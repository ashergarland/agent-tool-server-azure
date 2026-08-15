import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import { InMemoryDeploymentRecordStore } from '../../src/deployments/store-memory.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler } from '../helpers/bicep.js';
import { SUB_A, createFakeProvider, createTestLogger } from '../helpers/fake-provider.js';

const API_KEY = 'security-test-api-key-that-is-long-enough';
const auth = { 'x-api-key': API_KEY };

const buildApp = (overrides: Record<string, string> = {}): Application =>
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
    app = buildApp();
    await app.http.ready();
  });

  afterAll(async () => {
    await app.http.close();
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

  it('records tool invocation metrics without recording tool inputs', async () => {
    await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_subscriptions',
      headers: auth,
      payload: {},
    });
    const snapshot = await app.http.inject({ method: 'GET', url: '/metrics', headers: auth });
    const body = snapshot.json<{ counters: Record<string, number> }>();
    const key = Object.keys(body.counters).find((entry) =>
      entry.startsWith('tool_invocations_total'),
    );
    expect(key).toBeDefined();
    expect(key).toContain('azure_list_subscriptions');
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
    const app = buildApp({ NODE_ENV: 'production' });
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
      message: 'The server failed to complete the request',
    });
    expect(response.json<{ error: { requestId: string } }>().error.requestId).toBeTruthy();

    await app.http.close();
  });

  it('rejects a body larger than the configured limit', async () => {
    const app = buildApp({ HTTP_MAX_BODY_BYTES: '65536' });
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

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/too large/i);

    await app.http.close();
  });
});

describe('deployment tool inputs', () => {
  it('rejects unknown fields, so caller-supplied identities and credentials cannot slip in', async () => {
    const app = buildApp(DEPLOYMENT_ENV);
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

    await app.http.close();
  });

  it('refuses a deployment when deployments are disabled, but still validates source', async () => {
    const app = buildApp();
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

    await app.http.close();
  });

  it('rejects a traversing bundle path before anything is written to disk', async () => {
    const app = buildApp(DEPLOYMENT_ENV);
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

    await app.http.close();
  });
});
