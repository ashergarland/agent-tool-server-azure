import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import { InMemoryDeploymentRecordStore } from '../../src/deployments/store-memory.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler } from '../helpers/bicep.js';
import { SUB_A, createFakeProvider, createTestLogger, webAppId } from '../helpers/fake-provider.js';

const API_KEY = 'security-test-api-key-that-is-long-enough';
const auth = { 'x-api-key': API_KEY };

const buildApp = (overrides: Record<string, string> = {}): Promise<Application> =>
  createApplication({
    config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY, ...overrides }),
    logger: createTestLogger() as unknown as Logger,
    provider: createFakeProvider(),
    compiler: createFakeCompiler(),
    store: new InMemoryDeploymentRecordStore(),
  });

const DEPLOYMENT_ENV = {
  DEPLOYMENTS_ENABLED: 'true',
  BICEP_CLI_PATH: '/opt/bicep/bicep',
  AZURE_SUBSCRIPTION_IDS: SUB_A,
};

describe('guarded and public routes', () => {
  let app: Application;

  beforeAll(async () => {
    app = await buildApp();
    await app.http.ready();
  });

  afterAll(async () => {
    await app.shutdown();
  });

  it.each(['/health', '/ready', '/version', '/openapi.json'])(
    'serves %s without authentication',
    async (url) => {
      expect((await app.http.inject({ method: 'GET', url })).statusCode).toBe(200);
    },
  );

  it.each(['/tools', '/metrics', '/mcp'])('requires authentication for %s', async (url) => {
    const response = await app.http.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('serves metrics to an authenticated caller only', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/metrics', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('counters');
  });

  it('records capability operation metrics without recording tool inputs', async () => {
    await app.http.inject({
      method: 'POST',
      url: '/tools/azure_restart_web_app',
      headers: auth,
      payload: { resourceId: webAppId(), dryRun: true },
    });
    const snapshot = await app.http.inject({ method: 'GET', url: '/metrics', headers: auth });
    const body = snapshot.json<{ counters: Record<string, number> }>();
    const key = Object.keys(body.counters).find((entry) => entry.startsWith('mutations_total'));
    expect(key).toBeDefined();
    expect(key).toContain('restart_web_app');
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('never echoes the presented credential back to the caller', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': 'wrong-key-but-still-quite-long-abcdefgh' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('wrong-key-but-still-quite-long');
  });

  it('advertises /ready in the OpenAPI document', async () => {
    const document = (await app.http.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(document.paths['/ready']).toBeDefined();
  });
});

describe('error exposure', () => {
  it('hides internal failure detail in production but keeps the request id', async () => {
    const app = await buildApp({ NODE_ENV: 'production' });
    await app.http.ready();
    vi.spyOn(app.services.inventory, 'listSubscriptions').mockRejectedValue(
      new Error('ARM said: token eyJhbGciOi... for tenant 00000000-0000-0000-0000-000000000000'),
    );

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_subscriptions',
      headers: auth,
      payload: {},
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('eyJhbGciOi');
    expect(response.json<{ error: { message: string; requestId: string } }>().error).toMatchObject({
      code: 'internal_error',
      message: 'The tool server failed to complete the request',
    });
    expect(response.json<{ error: { requestId: string } }>().error.requestId).toBeTruthy();

    await app.shutdown();
  });

  it('rejects a body larger than the configured limit', async () => {
    const app = await buildApp({ BODY_LIMIT_BYTES: '65536' });
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_validate_bicep',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        bundle: { mainFile: 'main.bicep', files: [] },
        pad: 'x'.repeat(70_000),
      }),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain('x'.repeat(1_000));

    await app.shutdown();
  });
});

describe('deployment tool inputs', () => {
  it.each(['null', '1', 'true', '"coerced"'])(
    'rejects root primitive JSON input %s without schema coercion',
    async (payload) => {
      const app = await buildApp();
      const response = await app.http.inject({
        method: 'POST',
        url: '/tools/azure_validate_bicep',
        headers: { ...auth, 'content-type': 'application/json' },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('bad_request');
      await app.shutdown();
    },
  );

  it('requires the Platform mutation gate even when Azure deployments are enabled', async () => {
    const app = await buildApp(DEPLOYMENT_ENV);
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_deploy_bicep',
      headers: auth,
      payload: {
        bundle: {
          mainFile: 'main.bicep',
          files: [{ path: 'main.bicep', content: 'param a string' }],
        },
        parameters: {},
        scope: {
          kind: 'resourceGroup',
          subscriptionId: SUB_A,
          resourceGroup: 'rg-prod',
        },
        confirmationHash: 'a'.repeat(64),
        confirm: true,
        reason: 'mutation-gate test',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    await app.shutdown();
  });

  it('rejects unknown fields, so caller-supplied identities and credentials cannot slip in', async () => {
    const app = await buildApp(DEPLOYMENT_ENV);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_validate_bicep',
      headers: auth,
      payload: {
        bundle: {
          mainFile: 'main.bicep',
          files: [{ path: 'main.bicep', content: 'param a string' }],
        },
        clientId: 'attacker-identity',
        clientSecret: 'attacker-secret',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('attacker-secret');

    await app.shutdown();
  });

  it('refuses a deployment when deployments are disabled, but still validates source', async () => {
    const app = await buildApp();
    await app.http.ready();
    const bundle = {
      mainFile: 'main.bicep',
      files: [{ path: 'main.bicep', content: 'param a string' }],
    };

    const validated = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_validate_bicep',
      headers: auth,
      payload: { bundle },
    });
    expect(validated.statusCode).toBe(200);

    const previewed = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_what_if_bicep',
      headers: auth,
      payload: {
        bundle,
        parameters: {},
        scope: { kind: 'resourceGroup', subscriptionId: SUB_A, resourceGroup: 'rg-prod' },
      },
    });
    expect(previewed.statusCode).toBe(403);

    await app.shutdown();
  });

  it('rejects a traversing bundle path before anything is written to disk', async () => {
    const app = await buildApp(DEPLOYMENT_ENV);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_validate_bicep',
      headers: auth,
      payload: {
        bundle: {
          mainFile: 'main.bicep',
          files: [
            { path: 'main.bicep', content: 'param a string' },
            { path: '../../etc/passwd.bicep', content: 'x' },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /traverse outside/,
    );

    await app.shutdown();
  });
});
