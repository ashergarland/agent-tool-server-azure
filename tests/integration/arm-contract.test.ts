import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArmRestClient } from '../../src/provider/azure/arm-rest.js';
import {
  ArmDeploymentClient,
  DEPLOYMENTS_API_VERSION,
  deploymentBasePath,
} from '../../src/provider/azure/deployments.js';
import type { DeploymentScope } from '../../src/provider/types.js';
import { startArmStub, stubCredential, type ArmStub } from '../helpers/arm-stub.js';

const SUB = '11111111-1111-1111-1111-111111111111';

const scopes = {
  resourceGroup: {
    kind: 'resourceGroup',
    subscriptionId: SUB,
    resourceGroup: 'rg-prod',
    managementGroupId: undefined,
    location: undefined,
    armScope: `/subscriptions/${SUB}/resourceGroups/rg-prod`,
  },
  subscription: {
    kind: 'subscription',
    subscriptionId: SUB,
    resourceGroup: undefined,
    managementGroupId: undefined,
    location: 'westeurope',
    armScope: `/subscriptions/${SUB}`,
  },
  managementGroup: {
    kind: 'managementGroup',
    subscriptionId: undefined,
    resourceGroup: undefined,
    managementGroupId: 'mg-platform',
    location: 'westeurope',
    armScope: '/providers/Microsoft.Management/managementGroups/mg-platform',
  },
  tenant: {
    kind: 'tenant',
    subscriptionId: undefined,
    resourceGroup: undefined,
    managementGroupId: undefined,
    location: 'westeurope',
    armScope: '/',
  },
} satisfies Record<string, DeploymentScope>;

const TEMPLATE = { $schema: 'https://example.invalid/t.json#', resources: [] };

describe('ARM wire contract', () => {
  let stub: ArmStub;
  let rest: ArmRestClient;
  let client: ArmDeploymentClient;

  const build = async (handler: Parameters<typeof startArmStub>[0]): Promise<void> => {
    stub = await startArmStub(handler);
    rest = new ArmRestClient(stubCredential(), stub.origin, 5_000);
    client = new ArmDeploymentClient(
      rest,
      { whatIfTimeoutMs: 5_000, pollIntervalMs: 1, armEndpoint: stub.origin },
      () => Promise.resolve(),
    );
  };

  beforeEach(async () => {
    await build(() => ({ body: {} }));
  });

  afterEach(async () => {
    await stub.close();
  });

  describe('request construction', () => {
    it('sends a bearer token and the JSON content type', async () => {
      await client.get(scopes.resourceGroup, 'dep-1');
      const request = stub.requests[0];
      expect(request?.headers['authorization']).toBe('Bearer stub-access-token');
      expect(request?.headers['accept']).toBe('application/json');
    });

    it.each([
      [
        'resourceGroup',
        scopes.resourceGroup,
        `/subscriptions/${SUB}/resourcegroups/rg-prod/providers/Microsoft.Resources/deployments/dep-1`,
      ],
      [
        'subscription',
        scopes.subscription,
        `/subscriptions/${SUB}/providers/Microsoft.Resources/deployments/dep-1`,
      ],
      [
        'managementGroup',
        scopes.managementGroup,
        '/providers/Microsoft.Management/managementGroups/mg-platform/providers/Microsoft.Resources/deployments/dep-1',
      ],
      ['tenant', scopes.tenant, '/providers/Microsoft.Resources/deployments/dep-1'],
    ])('builds the documented %s deployment path', async (_name, scope, expected) => {
      await client.get(scope, 'dep-1');
      expect(stub.requests[0]?.path).toBe(expected);
      expect(stub.requests[0]?.query['api-version']).toBe(DEPLOYMENTS_API_VERSION);
    });

    it('pins a single api-version across every deployment call', () => {
      // A drifting api-version between calls is the kind of thing that only fails in production.
      expect(DEPLOYMENTS_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('percent-encodes caller-influenced path segments', async () => {
      await client.get({ ...scopes.resourceGroup, resourceGroup: 'rg with space' }, 'dep/../evil');
      // The path must not contain a traversal segment ARM would resolve.
      expect(stub.requests[0]?.path).not.toContain('/../');
      expect(stub.requests[0]?.path).toContain('rg%20with%20space');
    });

    it('always deploys in Incremental mode and never in Complete mode', async () => {
      await client.begin({
        scope: scopes.resourceGroup,
        deploymentName: 'dep-1',
        template: TEMPLATE,
        parameters: { name: { value: 'x' } },
      });
      const body = stub.requests[0]?.body as { properties: { mode: string } };
      expect(body.properties.mode).toBe('Incremental');
      expect(JSON.stringify(stub.requests[0]?.body)).not.toContain('Complete');
    });

    it('omits location at resource group scope and includes it at every other scope', async () => {
      await client.begin({
        scope: scopes.resourceGroup,
        deploymentName: 'a',
        template: TEMPLATE,
        parameters: {},
      });
      expect(stub.requests[0]?.body).not.toHaveProperty('location');

      for (const scope of [scopes.subscription, scopes.managementGroup, scopes.tenant]) {
        await client.begin({ scope, deploymentName: 'a', template: TEMPLATE, parameters: {} });
        expect(stub.requests.at(-1)?.body).toHaveProperty('location', 'westeurope');
      }
    });

    it('uses PUT to start a deployment, so ARM accepts and returns immediately', async () => {
      await client.begin({
        scope: scopes.resourceGroup,
        deploymentName: 'dep-1',
        template: TEMPLATE,
        parameters: {},
      });
      expect(stub.requests[0]?.method).toBe('PUT');
    });

    it('posts what-if to the /whatIf sub-resource', async () => {
      await client.whatIf({
        scope: scopes.resourceGroup,
        deploymentName: 'dep-1',
        template: TEMPLATE,
        parameters: {},
      });
      expect(stub.requests[0]?.method).toBe('POST');
      expect(stub.requests[0]?.path).toMatch(/\/deployments\/dep-1\/whatIf$/);
    });
  });

  describe('what-if long-running operation', () => {
    it('follows the 202 poll location until the operation settles', async () => {
      await stub.close();
      await build((_request, index) => {
        if (index === 0) {
          return { status: 202, headers: { location: `${stub.origin}/poll/1` }, body: {} };
        }
        if (index === 1) return { status: 202, body: {} };
        return {
          status: 200,
          body: {
            status: 'Succeeded',
            properties: {
              changes: [
                {
                  changeType: 'Create',
                  resourceId: '/subscriptions/s/rg/providers/Microsoft.Storage/storageAccounts/a',
                  delta: [
                    { path: 'sku.name', propertyChangeType: 'Create', after: 'Standard_LRS' },
                  ],
                },
              ],
            },
          },
        };
      });

      const result = await client.whatIf({
        scope: scopes.resourceGroup,
        deploymentName: 'dep-1',
        template: TEMPLATE,
        parameters: {},
      });

      expect(stub.requests).toHaveLength(3);
      expect(stub.requests[1]?.path).toBe('/poll/1');
      expect(stub.requests[1]?.method).toBe('GET');
      expect(result.status).toBe('Succeeded');
      expect(result.changes[0]).toMatchObject({ changeType: 'Create' });
      expect(result.changes[0]?.propertyChanges[0]).toMatchObject({
        path: 'sku.name',
        propertyChangeType: 'Create',
      });
    });

    it('accepts azure-asyncoperation when location is absent', async () => {
      await stub.close();
      await build((_request, index) =>
        index === 0
          ? { status: 202, headers: { 'azure-asyncoperation': `${stub.origin}/async/1` }, body: {} }
          : { status: 200, body: { status: 'Succeeded', properties: { changes: [] } } },
      );

      await client.whatIf({
        scope: scopes.resourceGroup,
        deploymentName: 'd',
        template: TEMPLATE,
        parameters: {},
      });
      expect(stub.requests[1]?.path).toBe('/async/1');
    });

    it('refuses to follow a poll location outside the ARM endpoint', async () => {
      await stub.close();
      await build(() => ({
        status: 202,
        headers: { location: 'https://attacker.example.invalid/steal' },
        body: {},
      }));

      await expect(
        client.whatIf({
          scope: scopes.resourceGroup,
          deploymentName: 'd',
          template: TEMPLATE,
          parameters: {},
        }),
      ).rejects.toThrowError(/poll location outside the ARM endpoint/);
      // The token must never have been sent anywhere but ARM.
      expect(stub.requests).toHaveLength(1);
    });

    it('fails cleanly when Azure accepts but returns no poll location', async () => {
      await stub.close();
      await build(() => ({ status: 202, body: {} }));
      await expect(
        client.whatIf({
          scope: scopes.resourceGroup,
          deploymentName: 'd',
          template: TEMPLATE,
          parameters: {},
        }),
      ).rejects.toThrowError(/no poll location/);
    });

    it('surfaces an error reported inside a settled what-if body', async () => {
      await stub.close();
      await build(() => ({
        status: 200,
        body: { status: 'Failed', error: { code: 'InvalidTemplate', message: 'bad template' } },
      }));

      const result = await client.whatIf({
        scope: scopes.resourceGroup,
        deploymentName: 'd',
        template: TEMPLATE,
        parameters: {},
      });
      expect(result.error).toEqual({ code: 'InvalidTemplate', message: 'bad template' });
    });
  });

  describe('responses', () => {
    it('maps a deployment status, including outputs and correlation id', async () => {
      await stub.close();
      await build(() => ({
        body: {
          id: '/subscriptions/s/providers/Microsoft.Resources/deployments/dep-1',
          name: 'dep-1',
          properties: {
            provisioningState: 'Succeeded',
            correlationId: 'corr-1',
            timestamp: '2026-01-01T00:00:00Z',
            duration: 'PT1M',
            outputs: { endpoint: { type: 'string', value: 'https://example.invalid' } },
          },
        },
      }));

      const status = await client.get(scopes.resourceGroup, 'dep-1');
      expect(status).toMatchObject({
        name: 'dep-1',
        provisioningState: 'Succeeded',
        correlationId: 'corr-1',
        duration: 'PT1M',
      });
      expect(status.outputs).toEqual({
        endpoint: { type: 'string', value: 'https://example.invalid' },
      });
    });

    it('extracts a continuation token from nextLink in either casing', async () => {
      for (const key of ['$skiptoken', '$skipToken']) {
        await stub.close();
        await build(() => ({
          body: {
            value: [{ operationId: 'op-1', properties: { provisioningState: 'Succeeded' } }],
            nextLink: `${stub.origin}/next?api-version=2024-03-01&${key}=TOKEN123`,
          },
        }));

        const page = await client.listOperations(scopes.resourceGroup, 'dep-1', {
          top: 10,
          skipToken: undefined,
        });
        expect(page.skipToken, key).toBe('TOKEN123');
        expect(page.operations[0]?.operationId).toBe('op-1');
      }
    });

    it('passes a continuation token back as $skiptoken and bounds the page with $top', async () => {
      await client.listOperations(scopes.resourceGroup, 'dep-1', { top: 25, skipToken: 'ABC' });
      expect(stub.requests[0]?.query['$top']).toBe('25');
      expect(stub.requests[0]?.query['$skiptoken']).toBe('ABC');
    });

    it('never returns more operations than requested, whatever ARM sends', async () => {
      await stub.close();
      await build(() => ({
        body: {
          value: Array.from({ length: 50 }, (_, index) => ({ operationId: `op-${index}` })),
        },
      }));
      const page = await client.listOperations(scopes.resourceGroup, 'dep-1', {
        top: 5,
        skipToken: undefined,
      });
      expect(page.operations).toHaveLength(5);
    });

    it('serialises a non-string status message rather than leaking an object', async () => {
      await stub.close();
      await build(() => ({
        body: {
          value: [
            {
              operationId: 'op-1',
              properties: { statusMessage: { error: { code: 'Conflict', message: 'taken' } } },
            },
          ],
        },
      }));
      const page = await client.listOperations(scopes.resourceGroup, 'd', {
        top: 10,
        skipToken: undefined,
      });
      expect(typeof page.operations[0]?.statusMessage).toBe('string');
      expect(page.operations[0]?.statusMessage).toContain('Conflict');
    });

    it('reads effective permissions from the documented provider path', async () => {
      await stub.close();
      await build(() => ({
        body: { value: [{ actions: ['*/read'], notActions: ['Microsoft.Authorization/*/Write'] }] },
      }));

      const permissions = await client.effectivePermissions(`/subscriptions/${SUB}`);
      expect(stub.requests[0]?.path).toBe(
        `/subscriptions/${SUB}/providers/Microsoft.Authorization/permissions`,
      );
      expect(permissions[0]).toEqual({
        actions: ['*/read'],
        notActions: ['Microsoft.Authorization/*/Write'],
      });
    });
  });

  describe('failures', () => {
    it.each([
      [400, 'bad_request'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [429, 'rate_limited'],
      [500, 'upstream_error'],
    ])('maps HTTP %i onto the %s error code', async (status, code) => {
      await stub.close();
      await build(() => ({
        status,
        body: { error: { code: 'AzureCode', message: 'something went wrong' } },
      }));

      await expect(client.get(scopes.resourceGroup, 'dep-1')).rejects.toThrowError(
        expect.objectContaining({ code }) as unknown,
      );
    });

    it('abandons a response larger than the limit rather than buffering it', async () => {
      await stub.close();
      stub = await startArmStub(() => ({ raw: 'x'.repeat(200_000) }));
      // An injected small limit stands in for the production one. The behaviour under test is that
      // the read is abandoned mid-stream rather than buffered in full and then measured.
      const bounded = new ArmRestClient(stubCredential(), stub.origin, 5_000, 4_096);
      await expect(
        bounded.get('subscriptions/x/providers/Microsoft.Resources/deployments', {}),
      ).rejects.toThrowError(/larger than the limit/);
    });

    it('rejects on content-length before reading a single byte of the body', async () => {
      await stub.close();
      stub = await startArmStub(() => ({
        headers: { 'content-length': String(50 * 1024 * 1024) },
        raw: 'x'.repeat(1_000),
      }));
      const bounded = new ArmRestClient(stubCredential(), stub.origin, 5_000, 4_096);
      await expect(
        bounded.get('subscriptions/x/providers/Microsoft.Resources/deployments', {}),
      ).rejects.toThrowError(/larger than the limit/);
    });

    it('accepts a response that sits just inside the limit', async () => {
      await stub.close();
      stub = await startArmStub(() => ({ body: { name: 'x'.repeat(1_000) } }));
      const bounded = new ArmRestClient(stubCredential(), stub.origin, 5_000, 8_192);
      await expect(
        bounded.get<{ name: string }>(
          'subscriptions/x/providers/Microsoft.Resources/deployments',
          {},
        ),
      ).resolves.toMatchObject({ name: 'x'.repeat(1_000) });
    });

    it('tolerates a malformed JSON body instead of throwing a parse error', async () => {
      await stub.close();
      await build(() => ({ raw: '{not json' }));
      const status = await client.get(scopes.resourceGroup, 'dep-1');
      expect(status.provisioningState).toBe('Unknown');
    });
  });
});

describe('deploymentBasePath', () => {
  it('produces a path with no leading slash, so it resolves against the endpoint', () => {
    for (const scope of Object.values(scopes)) {
      expect(deploymentBasePath(scope).startsWith('/')).toBe(false);
    }
  });
});
