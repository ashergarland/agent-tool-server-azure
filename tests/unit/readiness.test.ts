import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import { InMemoryDeploymentRecordStore } from '../../src/deployments/store-memory.js';
import type { AzureProvider } from '../../src/provider/types.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler } from '../helpers/bicep.js';
import { createFakeProvider, createTestLogger, SUB_A } from '../helpers/fake-provider.js';

const applications: Application[] = [];

const build = async (
  overrides: Record<string, string> = {},
  providerOverrides: Partial<AzureProvider> = {},
) => {
  const compiler = createFakeCompiler();
  const store = new InMemoryDeploymentRecordStore();
  const provider = createFakeProvider(providerOverrides);
  const app = await createApplication({
    config: testConfig(overrides),
    logger: createTestLogger() as unknown as Logger,
    provider,
    compiler,
    store,
    readinessCacheMs: 0,
  });
  applications.push(app);
  return { app, compiler, store, provider };
};

const DEPLOYMENT_ENV = {
  MUTATIONS_ENABLED: 'true',
  DEPLOYMENTS_ENABLED: 'true',
  BICEP_CLI_PATH: '/opt/bicep/bicep',
  AZURE_SUBSCRIPTION_IDS: SUB_A,
};

const check = (report: Awaited<ReturnType<Application['readiness']>>, name: string) =>
  report.checks.find((entry) => entry.name === name);

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.shutdown()));
});

describe('provider readiness', () => {
  it('proves Azure query and read RBAC separately from process health', async () => {
    const { app, provider } = await build();
    const report = await app.readiness();

    expect(report.ready).toBe(true);
    expect(check(report, 'registry')).toMatchObject({ state: 'ready' });
    expect(check(report, 'azure-provider')).toMatchObject({ state: 'ready' });
    expect(check(report, 'azure-mutations')).toMatchObject({
      state: 'ready',
      detail: 'mutations are disabled',
    });
    expect(check(report, 'azure-deployments')).toMatchObject({
      state: 'ready',
      detail: 'generic Bicep deployment is disabled',
    });
    expect(provider.calls.some((entry) => entry.name === 'listSubscriptions')).toBe(true);
    expect(provider.calls.some((entry) => entry.name === 'getEffectivePermissions')).toBe(true);
  });

  it('checks mutation RBAC, deployment RBAC, compiler, and durable store when enabled', async () => {
    const { app } = await build(DEPLOYMENT_ENV);
    const report = await app.readiness();

    expect(report.ready).toBe(true);
    for (const name of [
      'azure-mutations',
      'azure-deployments',
      'bicep-compiler',
      'deployment-store',
    ]) {
      expect(check(report, name), name).toMatchObject({ state: 'ready' });
    }
  });

  it('requires the complete Bicep workflow RBAC before deployment readiness is ready', async () => {
    const { app } = await build(DEPLOYMENT_ENV, {
      getEffectivePermissions: vi.fn((_scope: string, identity: 'operator' | 'deployment') =>
        Promise.resolve(
          identity === 'deployment'
            ? [{ actions: ['Microsoft.Resources/deployments/write'], notActions: [] }]
            : [{ actions: ['*'], notActions: [] }],
        ),
      ),
    });

    const report = await app.readiness();

    expect(report.ready).toBe(false);
    expect(check(report, 'azure-deployments')).toMatchObject({ state: 'not_ready' });
  });

  it('is not ready when provider authentication or the read query fails', async () => {
    const { app } = await build(
      {},
      {
        listSubscriptions: vi.fn(() =>
          Promise.reject(new Error('credential payload must not escape')),
        ),
      },
    );
    const report = await app.readiness();

    expect(report.ready).toBe(false);
    expect(check(report, 'azure-provider')).toMatchObject({
      state: 'not_ready',
      detail: 'Azure authentication or the read-only provider query failed',
    });
    expect(JSON.stringify(report)).not.toContain('credential payload');
  });

  it('reports degraded provider assurance when RBAC verification is intentionally disabled', async () => {
    const { app } = await build({ AZURE_VERIFY_RBAC: 'false' });
    const report = await app.readiness();

    expect(report.ready).toBe(true);
    expect(check(report, 'azure-provider')?.state).toBe('degraded');
  });

  it('accepts read RBAC granted only at an allowed resource-group scope', async () => {
    const permissions = vi.fn((scope: string) =>
      Promise.resolve(
        scope.endsWith('/resourceGroups/rg-prod')
          ? [
              {
                actions: ['Microsoft.Resources/subscriptions/resourceGroups/read'],
                notActions: [],
              },
            ]
          : [],
      ),
    );
    const { app } = await build(
      {
        AZURE_SUBSCRIPTION_IDS: SUB_A,
        AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod',
      },
      { getEffectivePermissions: permissions },
    );

    const report = await app.readiness();

    expect(report.ready).toBe(true);
    expect(check(report, 'azure-provider')).toMatchObject({ state: 'ready' });
    expect(permissions).toHaveBeenCalledWith(
      `/subscriptions/${SUB_A}/resourceGroups/rg-prod`,
      'operator',
      undefined,
    );
  });

  it('accepts mutation RBAC granted only at allowed resource-group scopes', async () => {
    const permissions = vi.fn((scope: string) =>
      Promise.resolve(
        scope.endsWith('/resourceGroups/rg-prod') ? [{ actions: ['*'], notActions: [] }] : [],
      ),
    );
    const { app } = await build(
      {
        MUTATIONS_ENABLED: 'true',
        AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod',
      },
      { getEffectivePermissions: permissions },
    );

    const report = await app.readiness();

    expect(report.ready).toBe(true);
    expect(check(report, 'azure-provider')).toMatchObject({ state: 'ready' });
    expect(check(report, 'azure-mutations')).toMatchObject({ state: 'ready' });
  });

  it('is not ready when the pinned compiler is unusable', async () => {
    const { app, compiler } = await build(DEPLOYMENT_ENV);
    compiler.info = {
      available: false,
      version: undefined,
      checksumVerified: false,
      detail: 'the Bicep CLI digest does not match BICEP_CLI_SHA256',
    };

    const report = await app.readiness();
    expect(report.ready).toBe(false);
    expect(check(report, 'bicep-compiler')?.state).toBe('not_ready');
  });

  it('is degraded but still ready when the compiler digest is unpinned outside production', async () => {
    const { app, compiler } = await build(DEPLOYMENT_ENV);
    compiler.info = {
      available: true,
      version: '0.30.0',
      checksumVerified: false,
      detail: undefined,
    };

    const report = await app.readiness();
    expect(check(report, 'bicep-compiler')?.state).toBe('degraded');
    expect(report.ready).toBe(true);
  });

  it('is not ready when the deployment record store cannot be reached', async () => {
    const { app, store } = await build(DEPLOYMENT_ENV);
    vi.spyOn(store, 'ping').mockRejectedValue(new Error('table storage credential leaked'));

    const report = await app.readiness();
    expect(report.ready).toBe(false);
    expect(check(report, 'deployment-store')).toMatchObject({
      state: 'not_ready',
      detail: 'the deployment record store is unavailable',
    });
    expect(JSON.stringify(report)).not.toContain('credential leaked');
  });

  it('fails readiness when mutations are enabled without effective operator RBAC', async () => {
    const { app } = await build(
      { MUTATIONS_ENABLED: 'true', AZURE_SUBSCRIPTION_IDS: SUB_A },
      { getEffectivePermissions: vi.fn(() => Promise.resolve([])) },
    );
    const report = await app.readiness();

    expect(report.ready).toBe(false);
    expect(check(report, 'azure-mutations')?.state).toBe('not_ready');
  });

  it('serves bounded readiness without invoking a mutating provider operation', async () => {
    const { app, provider } = await build();
    const response = await app.http.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ready: boolean }>().ready).toBe(true);
    expect(response.body).not.toContain(SUB_A);
    const consequential = new Set([
      'restartVirtualMachine',
      'startVirtualMachine',
      'restartWebApp',
      'setResourceTags',
      'beginDeployment',
    ]);
    expect(provider.calls.some((entry) => consequential.has(entry.name))).toBe(false);
  });

  it('keeps /health independent of provider readiness', async () => {
    const { app } = await build(
      {},
      { listSubscriptions: vi.fn(() => Promise.reject(new Error('provider unavailable'))) },
    );

    expect((await app.http.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    const health = await app.http.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string }>().status).toBe('ok');
  });
});
