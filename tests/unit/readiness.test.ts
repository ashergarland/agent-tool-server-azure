import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createApplication } from '../../src/app.js';
import { buildReadinessReport } from '../../src/server/ready.js';
import { InMemoryDeploymentRecordStore } from '../../src/deployments/store-memory.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler } from '../helpers/bicep.js';
import { createFakeProvider, createTestLogger, SUB_A } from '../helpers/fake-provider.js';

const build = (overrides: Record<string, string> = {}) => {
  const compiler = createFakeCompiler();
  const store = new InMemoryDeploymentRecordStore();
  const app = createApplication({
    config: testConfig(overrides),
    logger: createTestLogger() as unknown as Logger,
    provider: createFakeProvider(),
    compiler,
    store,
  });
  return { app, compiler, store };
};

const DEPLOYMENT_ENV = {
  DEPLOYMENTS_ENABLED: 'true',
  BICEP_CLI_PATH: '/opt/bicep/bicep',
  AZURE_SUBSCRIPTION_IDS: SUB_A,
};

describe('readiness', () => {
  it('is ready and reports deployment components as disabled by default', async () => {
    const { app } = build();
    const report = await buildReadinessReport(app.config, app.registry, app.services);

    expect(report.ready).toBe(true);
    expect(report.components['registry']?.state).toBe('ok');
    expect(report.components['bicepCompiler']?.state).toBe('disabled');
    expect(report.components['deploymentStore']?.state).toBe('disabled');
    expect(report.capabilities.deploymentsEnabled).toBe(false);
    expect(report.capabilities.transports).toEqual(['http', 'mcp-stdio', 'mcp-http']);
    expect(report.capabilities.toolCount).toBeGreaterThanOrEqual(18);
  });

  it('checks the compiler and the record store when deployments are enabled', async () => {
    const { app } = build(DEPLOYMENT_ENV);
    const report = await buildReadinessReport(app.config, app.registry, app.services);

    expect(report.ready).toBe(true);
    expect(report.components['bicepCompiler']).toMatchObject({ state: 'ok' });
    expect(report.components['deploymentStore']).toMatchObject({ state: 'ok' });
  });

  it('is not ready when the pinned compiler is unusable', async () => {
    const { app, compiler } = build(DEPLOYMENT_ENV);
    compiler.info = {
      available: false,
      version: undefined,
      checksumVerified: false,
      detail: 'the Bicep CLI digest does not match BICEP_CLI_SHA256',
    };

    const report = await buildReadinessReport(app.config, app.registry, app.services);
    expect(report.ready).toBe(false);
    expect(report.components['bicepCompiler']?.state).toBe('unavailable');
  });

  it('is degraded but still ready when the compiler digest is unpinned', async () => {
    const { app, compiler } = build(DEPLOYMENT_ENV);
    compiler.info = {
      available: true,
      version: '0.30.0',
      checksumVerified: false,
      detail: undefined,
    };

    const report = await buildReadinessReport(app.config, app.registry, app.services);
    expect(report.components['bicepCompiler']?.state).toBe('degraded');
    expect(report.components['bicepCompiler']?.detail).toMatch(/BICEP_CLI_SHA256 not configured/);
    expect(report.ready).toBe(true);
  });

  it('is not ready when the record store cannot be reached', async () => {
    const { app, store } = build(DEPLOYMENT_ENV);
    vi.spyOn(store, 'ping').mockRejectedValue(new Error('table storage unreachable'));

    const report = await buildReadinessReport(app.config, app.registry, app.services);
    expect(report.ready).toBe(false);
    expect(report.components['deploymentStore']).toMatchObject({
      state: 'unavailable',
      detail: 'table storage unreachable',
    });
  });

  it('flags a shared identity for deployments as degraded', async () => {
    const { app } = build(DEPLOYMENT_ENV);
    const report = await buildReadinessReport(app.config, app.registry, app.services);
    expect(report.components['identity']?.detail).toMatch(/AZURE_DEPLOYMENT_CLIENT_ID is unset/);
  });

  it('reports a separate deployment identity when one is configured', async () => {
    const { app } = build({
      ...DEPLOYMENT_ENV,
      AZURE_CLIENT_ID: 'operator-client-id',
      AZURE_DEPLOYMENT_CLIENT_ID: 'deployer-client-id',
    });
    const report = await buildReadinessReport(app.config, app.registry, app.services);
    expect(report.components['identity']).toMatchObject({
      state: 'ok',
      detail: 'separate operator and deployment identities',
    });
  });

  it('serves /ready with the right status code and never mutates anything', async () => {
    const { app } = build();
    const response = await app.http.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ready: boolean }>().ready).toBe(true);

    const failing = build(DEPLOYMENT_ENV);
    failing.compiler.info = {
      available: false,
      version: undefined,
      checksumVerified: false,
      detail: 'missing',
    };
    const unhealthy = await failing.app.http.inject({ method: 'GET', url: '/ready' });
    expect(unhealthy.statusCode).toBe(503);
  });

  it('keeps /health independent of readiness', async () => {
    const failing = build(DEPLOYMENT_ENV);
    failing.compiler.info = {
      available: false,
      version: undefined,
      checksumVerified: false,
      detail: 'missing',
    };
    const health = await failing.app.http.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string }>().status).toBe('ok');
  });
});
