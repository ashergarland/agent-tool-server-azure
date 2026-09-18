import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { badRequest, notFound } from '@agent-tool-platform/runtime/errors';
import { DeploymentService } from '../../src/services/deployments.js';
import { Guardrails } from '../../src/services/guardrails.js';
import { InMemoryDeploymentRecordStore } from '../../src/deployments/store-memory.js';
import { Metrics } from '../../src/util/metrics.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler, RG_TEMPLATE, SUBSCRIPTION_TEMPLATE } from '../helpers/bicep.js';
import { createFakeProvider, createTestLogger, SUB_A, SUB_B } from '../helpers/fake-provider.js';
import type {
  ArmDeploymentRequest,
  ArmDeploymentStatus,
  ArmWhatIfResult,
} from '../../src/provider/types.js';

const PRINCIPAL = 'key:abc';
const OTHER_PRINCIPAL = 'key:def';

const bundle = {
  mainFile: 'main.bicep',
  files: [{ path: 'main.bicep', content: 'param name string\n' }],
};

const rgScope = { kind: 'resourceGroup' as const, subscriptionId: SUB_A, resourceGroup: 'rg-prod' };

const DEPLOYMENT_ENV = {
  MUTATIONS_ENABLED: 'true',
  DEPLOYMENTS_ENABLED: 'true',
  BICEP_CLI_PATH: '/opt/bicep/bicep',
  AZURE_SUBSCRIPTION_IDS: SUB_A,
};

const whatIfResult = (changes: ArmWhatIfResult['changes'] = []): ArmWhatIfResult => ({
  status: 'Succeeded',
  changes,
  error: undefined,
});

const setup = (overrides: Record<string, string> = {}) => {
  const config = testConfig({ ...DEPLOYMENT_ENV, ...overrides });
  const provider = createFakeProvider();
  const compiler = createFakeCompiler();
  const store = new InMemoryDeploymentRecordStore();
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  let counter = 0;
  const logger = createTestLogger();

  const service = new DeploymentService({
    provider,
    guardrails: new Guardrails(config),
    config,
    store,
    compiler,
    logger: logger as unknown as Logger,
    metrics: new Metrics(),
    now: () => new Date(clock),
    newId: () => `id-${(counter += 1)}`,
  });

  return {
    config,
    provider,
    compiler,
    store,
    service,
    logger,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const previewAndDeploy = async (
  harness: ReturnType<typeof setup>,
  parameters: Record<string, unknown> = { name: 'sa' },
) => {
  const preview = await harness.service.whatIf(
    { bundle, parameters, scope: rgScope },
    PRINCIPAL,
    'req-1',
  );
  const result = await harness.service.deploy(
    {
      bundle,
      parameters,
      scope: rgScope,
      confirmationHash: preview.confirmationHash,
      confirm: true,
      reason: 'ship it',
    },
    PRINCIPAL,
    'req-2',
  );
  return { preview, result };
};

describe('DeploymentService.validate', () => {
  it('reports the template surface without contacting Azure', async () => {
    const { service, provider, compiler } = setup();
    const signal = new AbortController().signal;
    const result = await service.validate({ bundle }, signal);

    expect(result.valid).toBe(true);
    expect(result.templateScope).toBe('resourceGroup');
    expect(result.resourceTypes).toEqual(['microsoft.storage/storageaccounts']);
    expect(result.secureParameterNames).toEqual(['adminPassword']);
    expect(compiler.requests[0]?.signal).toBe(signal);
    expect(provider.calls.filter((call) => call.name.startsWith('whatIf'))).toHaveLength(0);
  });

  it('reports diagnostics instead of a template when compilation fails', async () => {
    const { service, compiler } = setup();
    compiler.result = {
      template: undefined,
      diagnostics: [
        {
          level: 'error',
          code: 'BCP007',
          message: 'bad',
          file: 'main.bicep',
          line: 1,
          column: 1,
        },
      ],
      durationMs: 1,
      truncatedOutput: false,
    };

    const result = await service.validate({ bundle });
    expect(result.valid).toBe(false);
    expect(result.templateHash).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe('DeploymentService scope enforcement', () => {
  it('refuses every deployment tool when deployments are disabled', async () => {
    const { service } = setup({ DEPLOYMENTS_ENABLED: 'false', BICEP_CLI_PATH: '' });
    await expect(
      service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'r'),
    ).rejects.toThrowError(expect.objectContaining({ code: 'forbidden' }) as unknown);
  });

  it('refuses a subscription outside the allow-list', async () => {
    const { service } = setup();
    await expect(
      service.whatIf(
        { bundle, parameters: {}, scope: { ...rgScope, subscriptionId: SUB_B } },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/outside the server's allow-list/);
  });

  it('refuses a resource group outside the allow-list', async () => {
    const { service } = setup({ AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod' });
    await expect(
      service.whatIf(
        { bundle, parameters: {}, scope: { ...rgScope, resourceGroup: 'rg-elsewhere' } },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/outside the server's allow-list/);
  });

  it('refuses deployment when no subscription allow-list is configured at all', async () => {
    const { service } = setup({ AZURE_SUBSCRIPTION_IDS: '' });
    await expect(
      service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'r'),
    ).rejects.toThrowError(/explicit AZURE_SUBSCRIPTION_IDS allow-list/);
  });

  it('refuses a template whose scope differs from the requested scope', async () => {
    const harness = setup();
    harness.compiler.result = { ...harness.compiler.result, template: SUBSCRIPTION_TEMPLATE };
    await expect(
      harness.service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'r'),
    ).rejects.toThrowError(
      /targets subscription scope but the request asked to deploy at resourceGroup/,
    );
  });

  it('refuses management group scope unless it is explicitly allow-listed', async () => {
    const { service } = setup();
    await expect(
      service.whatIf(
        {
          bundle,
          parameters: {},
          scope: { kind: 'managementGroup', managementGroupId: 'mg-root', location: 'westeurope' },
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/AZURE_ALLOWED_MANAGEMENT_GROUP_IDS/);
  });

  it('refuses tenant scope unless it is explicitly enabled', async () => {
    const { service } = setup();
    await expect(
      service.whatIf(
        { bundle, parameters: {}, scope: { kind: 'tenant', location: 'westeurope' } },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/Tenant scope deployments are disabled/);
  });

  it('requires a location for scopes whose deployment resource needs a region', async () => {
    const harness = setup();
    harness.compiler.result = { ...harness.compiler.result, template: SUBSCRIPTION_TEMPLATE };
    await expect(
      harness.service.whatIf(
        { bundle, parameters: {}, scope: { kind: 'subscription', subscriptionId: SUB_A } },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/requires location/);
  });

  it('refuses subscription scope while a resource-group allow-list is active', async () => {
    const harness = setup({ AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod' });
    harness.compiler.result = { ...harness.compiler.result, template: SUBSCRIPTION_TEMPLATE };

    await expect(
      harness.service.whatIf(
        {
          bundle,
          parameters: {},
          scope: { kind: 'subscription', subscriptionId: SUB_A, location: 'westeurope' },
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/Subscription-scope deployments are disabled/);
  });

  it('refuses a nested deployment that escapes into another subscription', async () => {
    const harness = setup();
    harness.compiler.result = {
      ...harness.compiler.result,
      template: {
        ...RG_TEMPLATE,
        resources: [
          {
            type: 'Microsoft.Resources/deployments',
            apiVersion: '2024-03-01',
            name: 'escape',
            subscriptionId: SUB_B,
            properties: { mode: 'Incremental', template: { resources: [] } },
          },
        ],
      },
    };
    await expect(
      harness.service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'r'),
    ).rejects.toThrowError(/outside the server's allow-list/);
  });

  it('requires an explicit subscription allow-list for nested targets from a management group', async () => {
    const harness = setup({
      AZURE_SUBSCRIPTION_IDS: '',
      AZURE_ALLOWED_MANAGEMENT_GROUP_IDS: 'mg-root',
    });
    harness.compiler.result = {
      ...harness.compiler.result,
      template: {
        ...SUBSCRIPTION_TEMPLATE,
        $schema:
          'https://schema.management.azure.com/schemas/2019-08-01/managementGroupDeploymentTemplate.json#',
        resources: [
          {
            type: 'Microsoft.Resources/deployments',
            apiVersion: '2024-03-01',
            name: 'escape',
            subscriptionId: SUB_B,
            properties: { mode: 'Incremental', template: { resources: [] } },
          },
        ],
      },
    };

    await expect(
      harness.service.whatIf(
        {
          bundle,
          parameters: {},
          scope: { kind: 'managementGroup', managementGroupId: 'mg-root', location: 'westeurope' },
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/explicit AZURE_SUBSCRIPTION_IDS allow-list/);
  });

  it('refuses nested subscription scope while a resource-group allow-list is active', async () => {
    const harness = setup({ AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod' });
    harness.compiler.result = {
      ...harness.compiler.result,
      template: {
        ...RG_TEMPLATE,
        resources: [
          {
            type: 'Microsoft.Resources/deployments',
            apiVersion: '2024-03-01',
            name: 'subscription-scope',
            subscriptionId: SUB_A,
            properties: {
              mode: 'Incremental',
              template: {
                $schema:
                  'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
                resources: [
                  {
                    type: 'Microsoft.Resources/resourceGroups',
                    apiVersion: '2024-03-01',
                    name: 'outside-allow-list',
                    location: 'westeurope',
                  },
                ],
              },
            },
          },
        ],
      },
    };

    await expect(
      harness.service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'r'),
    ).rejects.toThrowError(/Nested subscription-scope deployments are disabled/);
  });
});

describe('DeploymentService.whatIf', () => {
  it('returns a bounded, normalised preview bound to a confirmation hash', async () => {
    const harness = setup({ DEPLOYMENT_MAX_PREVIEW_CHANGES: '2' });
    harness.provider.whatIfDeployment = vi.fn(() =>
      Promise.resolve(
        whatIfResult([
          {
            changeType: 'Create',
            resourceId:
              '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/a',
            unsupportedReason: undefined,
            propertyChanges: [],
          },
          {
            changeType: 'Delete',
            resourceId:
              '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/b',
            unsupportedReason: undefined,
            propertyChanges: [],
          },
          {
            changeType: 'Ignore',
            resourceId:
              '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/c',
            unsupportedReason: 'not supported',
            propertyChanges: [],
          },
        ]),
      ),
    );

    const preview = await harness.service.whatIf(
      { bundle, parameters: { name: 'sa' }, scope: rgScope },
      PRINCIPAL,
      'req',
    );

    expect(preview.confirmationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.summary.totalChanges).toBe(3);
    expect(preview.summary.countsByChangeType).toEqual({ Create: 1, Delete: 1, Ignore: 1 });
    expect(preview.summary.deletes).toHaveLength(1);
    expect(preview.summary.unsupported).toHaveLength(1);
    expect(preview.summary.truncated).toBe(true);
    expect(preview.changes).toHaveLength(2);
    expect(preview.changes[0]?.resourceType).toBe('microsoft.storage/storageaccounts');
  });

  it('never returns before or after property values from live resources', async () => {
    const harness = setup();
    harness.provider.whatIfDeployment = vi.fn(() =>
      Promise.resolve(
        whatIfResult([
          {
            changeType: 'Modify',
            resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/api',
            unsupportedReason: undefined,
            propertyChanges: [
              {
                path: 'properties.siteConfig.connectionString',
                propertyChangeType: 'Modify',
                before: 'Server=old;Password=hunter2',
                after: 'Server=new;Password=hunter3',
              },
            ],
          },
        ]),
      ),
    );

    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'req',
    );
    expect(JSON.stringify(preview)).not.toContain('hunter2');
    expect(preview.changes[0]?.propertyChanges[0]).toEqual({
      path: 'properties.siteConfig.connectionString',
      changeType: 'Modify',
    });
  });

  it('bounds the number of property changes reported per resource', async () => {
    const harness = setup({ DEPLOYMENT_MAX_PROPERTY_CHANGES: '1' });
    harness.provider.whatIfDeployment = vi.fn(() =>
      Promise.resolve(
        whatIfResult([
          {
            changeType: 'Modify',
            resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/api',
            unsupportedReason: undefined,
            propertyChanges: [
              { path: 'a', propertyChangeType: 'Modify', before: 1, after: 2 },
              { path: 'b', propertyChangeType: 'Modify', before: 1, after: 2 },
            ],
          },
        ]),
      ),
    );
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'req',
    );
    expect(preview.changes[0]?.propertyChanges).toHaveLength(1);
    expect(preview.changes[0]?.propertyChangesTruncated).toBe(true);
  });

  it('surfaces an ARM what-if error rather than pretending there are no changes', async () => {
    const harness = setup();
    harness.provider.whatIfDeployment = vi.fn(() =>
      Promise.resolve({
        status: 'Failed',
        changes: [],
        error: { code: 'InvalidTemplate', message: 'nope' },
      }),
    );
    await expect(
      harness.service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'req'),
    ).rejects.toThrowError(/Azure rejected the what-if preview/);
  });

  it('propagates request cancellation to compilation and ARM what-if', async () => {
    const harness = setup();
    const signal = new AbortController().signal;

    await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'req',
      signal,
    );

    expect(harness.compiler.requests[0]?.signal).toBe(signal);
    const request = harness.provider.calls.find((call) => call.name === 'whatIfDeployment')
      ?.args[0] as { readonly signal?: AbortSignal };
    expect(request.signal).toBe(signal);
  });

  it('refuses to preview source that does not compile', async () => {
    const harness = setup();
    harness.compiler.result = {
      template: undefined,
      diagnostics: [
        {
          level: 'error',
          code: 'BCP007',
          message: 'bad',
          file: undefined,
          line: undefined,
          column: undefined,
        },
      ],
      durationMs: 1,
      truncatedOutput: false,
    };
    await expect(
      harness.service.whatIf({ bundle, parameters: {}, scope: rgScope }, PRINCIPAL, 'req'),
    ).rejects.toThrowError(/did not compile/);
  });

  it('redacts secure parameter values from the stored record', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: { name: 'sa', adminPassword: 'hunter2' }, scope: rgScope },
      PRINCIPAL,
      'req',
    );
    const record = await harness.store.get(preview.previewId, PRINCIPAL);
    expect(record?.sanitizedParameters).toEqual({ name: 'sa', adminPassword: '[redacted]' });
    expect(JSON.stringify(record?.sanitizedParameters)).not.toContain('hunter2');
  });
});

describe('DeploymentService.deploy', () => {
  it('starts the deployment when the preview matches exactly', async () => {
    const harness = setup();
    const { preview, result } = await previewAndDeploy(harness);

    expect(result.status).toBe('running');
    expect(result.alreadyStarted).toBe(false);
    expect(result.confirmationHash).toBe(preview.confirmationHash);
    expect(result.deploymentName).toMatch(/^atsa-id-/);

    const begin = harness.provider.calls.find((call) => call.name === 'beginDeployment');
    expect(begin).toBeDefined();
    expect((begin?.args[0] as { parameters: unknown }).parameters).toEqual({
      name: { value: 'sa' },
    });
  });

  it('does not admit a deployment after its request is cancelled', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'cancelled request',
        },
        PRINCIPAL,
        'deploy',
        cancellation.signal,
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(harness.provider.calls.filter((call) => call.name === 'beginDeployment')).toHaveLength(
      0,
    );
  });

  it('finishes recording and auditing a deployment after it is admitted', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    const cancellation = new AbortController();
    const beginDeployment = vi.fn((_request: ArmDeploymentRequest) => {
      cancellation.abort();
      return Promise.resolve({
        id: '/subscriptions/x/providers/Microsoft.Resources/deployments/test',
        name: 'test',
        provisioningState: 'Accepted',
        correlationId: 'correlation',
        timestamp: undefined,
        duration: undefined,
        outputs: undefined,
        error: undefined,
      } satisfies ArmDeploymentStatus);
    });
    harness.provider.beginDeployment = beginDeployment;

    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'track accepted deployment',
        },
        PRINCIPAL,
        'deploy',
        cancellation.signal,
      ),
    ).resolves.toMatchObject({ status: 'running' });

    expect(beginDeployment.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(beginDeployment.mock.calls[0]?.[0].signal).not.toBe(cancellation.signal);
    await expect(harness.store.get(preview.previewId, PRINCIPAL)).resolves.toMatchObject({
      status: 'running',
      armDeploymentName: expect.stringMatching(/^atsa-/),
    });
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'deployment.submitting' }),
      expect.any(String),
    );
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'deployment.started' }),
      expect.any(String),
    );
  });

  it('retains an auditable submitting record when the ARM response is uncertain', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    harness.provider.beginDeployment = vi.fn(() => Promise.reject(new Error('response lost')));

    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'track uncertain deployment',
        },
        PRINCIPAL,
        'deploy',
      ),
    ).rejects.toThrow(/response lost/);

    await expect(harness.store.get(preview.previewId, PRINCIPAL)).resolves.toMatchObject({
      status: 'submitting',
      armDeploymentName: expect.stringMatching(/^atsa-/),
      reason: 'track uncertain deployment',
    });
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'deployment.submitting' }),
      expect.any(String),
    );
  });

  it('terminalizes a definitive ARM submission rejection', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    harness.provider.beginDeployment = vi.fn(() =>
      Promise.reject(badRequest('ARM rejected the deployment body')),
    );

    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'invalid deployment',
        },
        PRINCIPAL,
        'deploy',
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });

    await expect(harness.store.get(preview.previewId, PRINCIPAL)).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'bad_request',
        message: 'ARM rejected the deployment body',
      },
    });
  });

  it('reconciles and safely retries an uncertain submission by deterministic name', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    const accepted: ArmDeploymentStatus = {
      id: '/subscriptions/x/providers/Microsoft.Resources/deployments/retried',
      name: `atsa-${preview.previewId}`,
      provisioningState: 'Accepted',
      correlationId: 'retry-correlation',
      timestamp: undefined,
      duration: undefined,
      outputs: undefined,
      error: undefined,
    };
    const beginDeployment = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(accepted);
    harness.provider.beginDeployment = beginDeployment;
    harness.provider.getDeployment = vi.fn(() =>
      Promise.reject(notFound('deployment is not visible')),
    );
    const input = {
      bundle,
      parameters: {},
      scope: rgScope,
      confirmationHash: preview.confirmationHash,
      confirm: true,
      reason: 'retry uncertain submission',
    };

    await expect(harness.service.deploy(input, PRINCIPAL, 'first')).rejects.toThrow(
      /response lost/,
    );
    await expect(
      harness.service.getDeployment({ recordId: preview.previewId }, PRINCIPAL),
    ).rejects.toThrow(/Retry azure_deploy_bicep with the exact approved source/);
    await expect(harness.service.deploy(input, PRINCIPAL, 'retry')).resolves.toMatchObject({
      deploymentName: `atsa-${preview.previewId}`,
      status: 'running',
      alreadyStarted: false,
    });
    expect(beginDeployment).toHaveBeenCalledTimes(2);
  });

  it('continues from the durable admission point when cancellation follows the submitting write', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    const cancellation = new AbortController();
    const patch = harness.store.patch.bind(harness.store);
    vi.spyOn(harness.store, 'patch').mockImplementation(
      async (id, principal, recordPatch, signal) => {
        const updated = await patch(id, principal, recordPatch, signal);
        if (recordPatch.status === 'submitting') cancellation.abort();
        return updated;
      },
    );

    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'durable admission',
        },
        PRINCIPAL,
        'deploy',
        cancellation.signal,
      ),
    ).resolves.toMatchObject({ status: 'running' });
    expect(harness.provider.calls.filter((call) => call.name === 'beginDeployment')).toHaveLength(
      1,
    );
  });

  it('rechecks record state under the scope lock before a delayed retry submits', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    const compile = harness.compiler.compile.bind(harness.compiler);
    let compileCount = 0;
    let markSecondCompile = (): void => undefined;
    const secondCompileStarted = new Promise<void>((resolve) => {
      markSecondCompile = resolve;
    });
    let releaseSecondCompile = (): void => undefined;
    const secondCompileRelease = new Promise<void>((resolve) => {
      releaseSecondCompile = resolve;
    });
    harness.compiler.compile = async (request) => {
      compileCount += 1;
      if (compileCount === 2) {
        markSecondCompile();
        await secondCompileRelease;
      }
      return compile(request);
    };
    const input = {
      bundle,
      parameters: {},
      scope: rgScope,
      confirmationHash: preview.confirmationHash,
      confirm: true,
      reason: 'idempotent retry',
    };

    const first = harness.service.deploy(input, PRINCIPAL, 'first');
    const second = harness.service.deploy(input, PRINCIPAL, 'second');
    await secondCompileStarted;
    await expect(first).resolves.toMatchObject({ alreadyStarted: false });
    releaseSecondCompile();
    await expect(second).resolves.toMatchObject({ alreadyStarted: true });
    expect(harness.provider.calls.filter((call) => call.name === 'beginDeployment')).toHaveLength(
      1,
    );
  });

  it('does not regress a terminal status when deployment acceptance finishes late', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'preview',
    );
    let markSubmission = (): void => undefined;
    const submissionStarted = new Promise<void>((resolve) => {
      markSubmission = resolve;
    });
    let releaseSubmission = (): void => undefined;
    harness.provider.beginDeployment = vi.fn(
      () =>
        new Promise<ArmDeploymentStatus>((resolve) => {
          markSubmission();
          releaseSubmission = () =>
            resolve({
              id: '/subscriptions/x/providers/Microsoft.Resources/deployments/test',
              name: `atsa-${preview.previewId}`,
              provisioningState: 'Accepted',
              correlationId: 'accepted-late',
              timestamp: undefined,
              duration: undefined,
              outputs: undefined,
              error: undefined,
            });
        }),
    );
    const deploying = harness.service.deploy(
      {
        bundle,
        parameters: {},
        scope: rgScope,
        confirmationHash: preview.confirmationHash,
        confirm: true,
        reason: 'race status reconciliation',
      },
      PRINCIPAL,
      'deploy',
    );
    await submissionStarted;

    await expect(
      harness.service.getDeployment({ recordId: preview.previewId }, PRINCIPAL),
    ).resolves.toMatchObject({ provisioningState: 'Succeeded' });
    releaseSubmission();
    await expect(deploying).resolves.toMatchObject({ status: 'succeeded' });
    await expect(harness.store.get(preview.previewId, PRINCIPAL)).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('refuses without confirm=true', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: false,
          reason: 'x',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/requires an explicit confirm=true/);
  });

  it('refuses without a reason', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: '   ',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/requires a reason/);
  });

  it('refuses a confirmation hash that was never issued', async () => {
    const harness = setup();
    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: 'f'.repeat(64),
          confirm: true,
          reason: 'x',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/No recent what-if preview matches/);
  });

  it('refuses when the source changed after the preview', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    await expect(
      harness.service.deploy(
        {
          bundle: {
            mainFile: 'main.bicep',
            files: [{ path: 'main.bicep', content: 'param name string // changed\n' }],
          },
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'x',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/differ from the previewed deployment/);
  });

  it('refuses when the parameters changed after the preview', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: { name: 'sa' }, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: { name: 'other' },
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'x',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/differ from the previewed deployment/);
  });

  it('refuses an expired preview', async () => {
    const harness = setup({ DEPLOYMENT_PREVIEW_TTL_MS: '60000' });
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    harness.advance(60_001);
    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'x',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/preview expired/);
  });

  it('refuses a preview issued to a different principal', async () => {
    const harness = setup();
    const preview = await harness.service.whatIf(
      { bundle, parameters: {}, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: {},
          scope: rgScope,
          confirmationHash: preview.confirmationHash,
          confirm: true,
          reason: 'x',
        },
        OTHER_PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/No recent what-if preview matches/);
  });

  it('is idempotent: a retried deploy reports the existing deployment', async () => {
    const harness = setup();
    const { preview } = await previewAndDeploy(harness);

    const retry = await harness.service.deploy(
      {
        bundle,
        parameters: { name: 'sa' },
        scope: rgScope,
        confirmationHash: preview.confirmationHash,
        confirm: true,
        reason: 'ship it',
      },
      PRINCIPAL,
      'req-3',
    );

    expect(retry.alreadyStarted).toBe(true);
    expect(harness.provider.calls.filter((call) => call.name === 'beginDeployment')).toHaveLength(
      1,
    );
  });

  it('serialises concurrent deployments against the same scope', async () => {
    const harness = setup();
    const first = await harness.service.whatIf(
      { bundle, parameters: { name: 'a' }, scope: rgScope },
      PRINCIPAL,
      'r',
    );
    const second = await harness.service.whatIf(
      { bundle, parameters: { name: 'b' }, scope: rgScope },
      PRINCIPAL,
      'r',
    );

    let release = (): void => undefined;
    harness.provider.beginDeployment = vi.fn(
      (): Promise<ArmDeploymentStatus> =>
        new Promise<ArmDeploymentStatus>((resolve) => {
          release = () =>
            resolve({
              id: 'deployment-id',
              name: 'n',
              provisioningState: 'Accepted',
              correlationId: undefined,
              timestamp: undefined,
              duration: undefined,
              outputs: undefined,
              error: undefined,
            });
        }),
    );

    const running = harness.service.deploy(
      {
        bundle,
        parameters: { name: 'a' },
        scope: rgScope,
        confirmationHash: first.confirmationHash,
        confirm: true,
        reason: 'first',
      },
      PRINCIPAL,
      'r',
    );

    await expect(
      harness.service.deploy(
        {
          bundle,
          parameters: { name: 'b' },
          scope: rgScope,
          confirmationHash: second.confirmationHash,
          confirm: true,
          reason: 'second',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'conflict' }) as unknown);

    release();
    await running;
  });
});

describe('DeploymentService.getDeployment', () => {
  it('reconciles the record and redacts sensitive outputs', async () => {
    const harness = setup();
    const { result } = await previewAndDeploy(harness);

    harness.provider.getDeployment = vi.fn(() =>
      Promise.resolve({
        id: 'deployment-id',
        name: result.deploymentName,
        provisioningState: 'Succeeded',
        correlationId: 'corr',
        timestamp: '2026-01-01T00:05:00Z',
        duration: 'PT5M',
        outputs: {
          endpoint: { type: 'string', value: 'https://example.invalid' },
          primaryKey: { type: 'securestring', value: 'super-secret' },
          storageConnectionString: { type: 'string', value: 'Server=x;Password=y' },
        },
        error: undefined,
      }),
    );

    const status = await harness.service.getDeployment({ recordId: result.recordId }, PRINCIPAL);

    expect(status.provisioningState).toBe('Succeeded');
    expect(status.outputs).toEqual([{ name: 'endpoint', value: 'https://example.invalid' }]);
    expect(status.redactedOutputNames).toEqual(['primaryKey', 'storageConnectionString']);
    expect(JSON.stringify(status)).not.toContain('super-secret');

    const record = await harness.store.get(result.recordId, PRINCIPAL);
    expect(record?.status).toBe('succeeded');
  });

  it('refuses to read another principal’s record', async () => {
    const harness = setup();
    const { result } = await previewAndDeploy(harness);
    await expect(
      harness.service.getDeployment({ recordId: result.recordId }, OTHER_PRINCIPAL),
    ).rejects.toThrowError(expect.objectContaining({ code: 'not_found' }) as unknown);
  });

  it('requires either a record id or an explicit scope and deployment name', async () => {
    const { service } = setup();
    await expect(service.getDeployment({}, PRINCIPAL)).rejects.toThrowError(
      /Supply either recordId/,
    );
  });
});

describe('DeploymentService.rollback', () => {
  const succeed = async (harness: ReturnType<typeof setup>) => {
    const { result } = await previewAndDeploy(harness, { name: 'sa' });
    await harness.store.patch(result.recordId, PRINCIPAL, { status: 'succeeded' });
    return result.recordId;
  };

  it('previews first and only deploys with a fresh confirmation', async () => {
    const harness = setup();
    const recordId = await succeed(harness);

    const preview = await harness.service.rollback(
      { recordId, confirm: false, reason: 'revert' },
      PRINCIPAL,
      'r',
    );
    expect(preview.phase).toBe('preview');
    if (preview.phase !== 'preview') throw new Error('expected a preview');
    expect(preview.preview.warnings.map((warning) => warning.code)).toContain(
      'rollback_is_a_redeploy',
    );

    const applied = await harness.service.rollback(
      {
        recordId,
        confirm: true,
        confirmationHash: preview.preview.confirmationHash,
        reason: 'revert',
      },
      PRINCIPAL,
      'r',
    );
    expect(applied.phase).toBe('deployed');
  });

  it('reconciles and retries an uncertain rollback using its deterministic name', async () => {
    const harness = setup();
    const recordId = await succeed(harness);
    const preview = await harness.service.rollback(
      { recordId, confirm: false, reason: 'revert' },
      PRINCIPAL,
      'preview',
    );
    if (preview.phase !== 'preview') throw new Error('expected a preview');
    const accepted: ArmDeploymentStatus = {
      id: '/subscriptions/x/providers/Microsoft.Resources/deployments/rollback',
      name: `atsa-${preview.preview.previewId}`,
      provisioningState: 'Accepted',
      correlationId: 'rollback-retry',
      timestamp: undefined,
      duration: undefined,
      outputs: undefined,
      error: undefined,
    };
    const beginDeployment = vi
      .fn()
      .mockRejectedValueOnce(new Error('rollback response lost'))
      .mockResolvedValueOnce(accepted);
    harness.provider.beginDeployment = beginDeployment;
    harness.provider.getDeployment = vi.fn(() =>
      Promise.reject(notFound('rollback deployment is not visible')),
    );
    const input = {
      recordId,
      confirm: true,
      confirmationHash: preview.preview.confirmationHash,
      reason: 'revert',
    };

    await expect(harness.service.rollback(input, PRINCIPAL, 'first')).rejects.toThrow(
      /rollback response lost/,
    );
    await expect(harness.service.rollback(input, PRINCIPAL, 'retry')).resolves.toMatchObject({
      phase: 'deployed',
      result: {
        deploymentName: `atsa-${preview.preview.previewId}`,
        status: 'running',
      },
    });
    expect(beginDeployment).toHaveBeenCalledTimes(2);
  });

  it('refuses a confirmation hash from a different record', async () => {
    const harness = setup();
    const recordId = await succeed(harness);
    await expect(
      harness.service.rollback(
        { recordId, confirm: true, confirmationHash: 'a'.repeat(64), reason: 'revert' },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/does not match a recent rollback preview/);
  });

  it('refuses a confirmation hash that came from an ordinary what-if preview', async () => {
    const harness = setup();
    const recordId = await succeed(harness);

    // An ordinary preview at the same scope also records the same previous successful deployment.
    // Approving *its* plan must not authorise redeploying the older template.
    const unrelated = await harness.service.whatIf(
      { bundle, parameters: { name: 'something-else' }, scope: rgScope },
      PRINCIPAL,
      'r',
    );

    const started = harness.provider.calls.filter((call) => call.name === 'beginDeployment').length;
    await expect(
      harness.service.rollback(
        {
          recordId,
          confirm: true,
          confirmationHash: unrelated.confirmationHash,
          reason: 'revert',
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/does not match a recent rollback preview/);
    expect(harness.provider.calls.filter((call) => call.name === 'beginDeployment')).toHaveLength(
      started,
    );
  });

  it('refuses to apply a rollback with secure values that differ from the previewed ones', async () => {
    const harness = setup();
    const { result } = await previewAndDeploy(harness, { name: 'sa', adminPassword: 'hunter2' });
    await harness.store.patch(result.recordId, PRINCIPAL, { status: 'succeeded' });

    const preview = await harness.service.rollback(
      {
        recordId: result.recordId,
        confirm: false,
        reason: 'revert',
        secureParameters: { adminPassword: 'previewed-value' },
      },
      PRINCIPAL,
      'r',
    );
    if (preview.phase !== 'preview') throw new Error('expected a preview');

    await expect(
      harness.service.rollback(
        {
          recordId: result.recordId,
          confirm: true,
          confirmationHash: preview.preview.confirmationHash,
          reason: 'revert',
          secureParameters: { adminPassword: 'a-different-value' },
        },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'conflict' }) as unknown);
  });

  it('refuses to redeploy a record that never succeeded', async () => {
    const harness = setup();
    const { result } = await previewAndDeploy(harness);
    await expect(
      harness.service.rollback(
        { recordId: result.recordId, confirm: false, reason: '' },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/Only a previously successful deployment/);
  });

  it('requires secure parameter values to be supplied again', async () => {
    const harness = setup();
    const { result } = await previewAndDeploy(harness, { name: 'sa', adminPassword: 'hunter2' });
    await harness.store.patch(result.recordId, PRINCIPAL, { status: 'succeeded' });

    await expect(
      harness.service.rollback(
        { recordId: result.recordId, confirm: false, reason: 'revert' },
        PRINCIPAL,
        'r',
      ),
    ).rejects.toThrowError(/missingSecureParameters|secure parameters/);

    const preview = await harness.service.rollback(
      {
        recordId: result.recordId,
        confirm: false,
        reason: 'revert',
        secureParameters: { adminPassword: 'hunter3' },
      },
      PRINCIPAL,
      'r',
    );
    expect(preview.phase).toBe('preview');
  });

  it('refuses another principal’s record', async () => {
    const harness = setup();
    const recordId = await succeed(harness);
    await expect(
      harness.service.rollback({ recordId, confirm: false, reason: 'x' }, OTHER_PRINCIPAL, 'r'),
    ).rejects.toThrowError(expect.objectContaining({ code: 'not_found' }) as unknown);
  });
});

describe('InMemoryDeploymentRecordStore', () => {
  let store: InMemoryDeploymentRecordStore;
  beforeEach(() => {
    store = new InMemoryDeploymentRecordStore();
  });

  it('refuses a second concurrent holder of the same scope lock', async () => {
    let release = (): void => undefined;
    const held = store.withScopeLock(
      'scope',
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(store.withScopeLock('scope', () => Promise.resolve())).rejects.toThrowError(
      /already in progress/,
    );
    release();
    await held;
    await expect(store.withScopeLock('scope', () => Promise.resolve())).resolves.toBeUndefined();
  });
});
