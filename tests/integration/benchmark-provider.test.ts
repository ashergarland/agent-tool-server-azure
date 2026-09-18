import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplication, type Application } from '../../src/app.js';
import type { AzureResource } from '../../src/provider/types.js';
import { testConfig } from '../helpers/config.js';
import {
  createFakeProvider,
  createTestLogger,
  type FakeProvider,
} from '../helpers/fake-provider.js';

interface RevisionFixture {
  readonly schemaVersion: string;
  readonly fixture: true;
  readonly provider: 'azure';
  readonly mode: 'mock-read-only';
  readonly credentialsRequired: false;
  readonly request: { readonly operation: string; readonly resourceId: string };
  readonly response: {
    readonly name: string;
    readonly provisioningState: string;
    readonly runningState: string;
    readonly replicas: { readonly desired: number; readonly ready: number };
    readonly ingress: {
      readonly external: boolean;
      readonly targetPort: number;
      readonly transport: string;
    };
    readonly containers: readonly {
      readonly environmentVariableNames: readonly string[];
      readonly readinessProbe: {
        readonly transport: string;
        readonly port: number;
        readonly lastResult: string;
      };
      readonly latestConsoleEvent: {
        readonly address: string;
        readonly port: number;
        readonly healthPath: string;
      };
    }[];
    readonly registryImagePull: { readonly state: string };
    readonly providerErrors: readonly unknown[];
  };
}

const applications: Application[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.shutdown()));
});

describe('Hackathon Level 3 mock-provider seam', () => {
  it('derives all deployment-state facts through azure_get_resource without credentials or mutation', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../fixtures/azure-container-app-revision.json', import.meta.url),
        'utf8',
      ),
    ) as RevisionFixture;

    const getResourceById = vi.fn((resourceId: string): Promise<AzureResource> =>
      Promise.resolve({
        id: resourceId,
        name: fixture.response.name,
        type: 'microsoft.app/containerapps/revisions',
        location: 'fixture-region',
        resourceGroup: 'benchmark-fixture',
        subscriptionId: '00000000-0000-0000-0000-000000000000',
        kind: undefined,
        sku: undefined,
        tags: {},
        properties: fixture.response,
      }),
    );
    const provider: FakeProvider = createFakeProvider({ getResourceById });
    const mutationSpies = [
      vi.spyOn(provider, 'restartVirtualMachine'),
      vi.spyOn(provider, 'startVirtualMachine'),
      vi.spyOn(provider, 'restartWebApp'),
      vi.spyOn(provider, 'setResourceTags'),
      vi.spyOn(provider, 'beginDeployment'),
    ];
    const app = await createApplication({
      config: testConfig(),
      logger: createTestLogger() as unknown as Logger,
      provider,
      readinessCacheMs: 0,
    });
    applications.push(app);

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_get_resource',
      payload: { resourceId: fixture.request.resourceId },
    });
    expect(response.statusCode).toBe(200);
    const resource = response.json<{
      result: { resource: { name: string; properties: RevisionFixture['response'] } };
    }>().result.resource;

    expect(fixture).toMatchObject({
      schemaVersion: '1.0',
      fixture: true,
      provider: 'azure',
      mode: 'mock-read-only',
      credentialsRequired: false,
      request: { operation: 'getContainerAppRevision' },
    });
    expect(getResourceById).toHaveBeenCalledOnce();
    expect(getResourceById).toHaveBeenCalledWith(
      fixture.request.resourceId,
      expect.any(AbortSignal),
    );
    expect(resource.name).toBe('checkout-api--pr-1842');
    expect(resource.properties).toMatchObject({
      provisioningState: 'Succeeded',
      runningState: 'Degraded',
      replicas: { desired: 1, ready: 0 },
      ingress: { external: true, targetPort: 8080, transport: 'Auto' },
      containers: [
        {
          environmentVariableNames: ['NODE_ENV', 'APP_PORT'],
          readinessProbe: {
            transport: 'TCP',
            port: 8080,
            lastResult: 'ConnectionRefused',
          },
          latestConsoleEvent: {
            address: '0.0.0.0',
            port: 3000,
            healthPath: '/healthz',
          },
        },
      ],
      registryImagePull: { state: 'Succeeded' },
      providerErrors: [],
    });

    expect(provider.calls).toEqual([]);
    for (const mutation of mutationSpies) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });
});
