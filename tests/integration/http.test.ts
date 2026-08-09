import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import { testConfig } from '../helpers/config.js';
import { SUB_A, createFakeProvider, createTestLogger, webAppId } from '../helpers/fake-provider.js';

const API_KEY = 'test-api-key-that-is-long-enough-000000';

const buildApp = (overrides: Record<string, string> = {}): Application =>
  createApplication({
    config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY, ...overrides }),
    logger: createTestLogger() as unknown as Logger,
    provider: createFakeProvider(),
  });

describe('HTTP surface', () => {
  let app: Application;

  beforeAll(async () => {
    app = buildApp();
    await app.http.ready();
  });

  afterAll(async () => {
    await app.http.close();
  });

  const auth = { authorization: ['Bearer', API_KEY].join(' ') };

  it('serves an unauthenticated health probe', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('serves version and capability metadata without auth', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: '1.2.3',
      capabilities: { mutationsEnabled: false, authMode: 'api-key' },
    });
  });

  it('echoes a request id on every response', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-me' },
    });
    expect(response.headers['x-request-id']).toBe('trace-me');
  });

  it('rejects unauthenticated tool calls', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/tools' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects an incorrect api key', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: ['Bearer', 'wrong-key-wrong-key-wrong-key-wrong'].join(' ') },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the x-api-key header', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': API_KEY },
    });
    expect(response.statusCode).toBe(200);
  });

  it('lists tools with their schemas', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/tools', headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools[0]).toHaveProperty('inputSchema.type', 'object');
  });

  it('serves the same tools over authenticated Streamable HTTP MCP', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...auth,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.tools).toHaveLength(app.registry.list().length);
  });

  it('requires authentication for remote MCP', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('invokes a read tool', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_subscriptions',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.subscriptions).toHaveLength(2);
  });

  it('accepts both a bare payload and an { input } envelope', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_resource_groups',
      headers: auth,
      payload: { input: { subscriptionId: SUB_A } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.resourceGroups).toHaveLength(2);
  });

  it('returns 400 with validation issues for bad input', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_resource_groups',
      headers: auth,
      payload: { subscriptionId: 'not-a-guid' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.issues[0].path).toBe('subscriptionId');
  });

  it('returns 404 for an unknown tool', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_does_not_exist',
      headers: auth,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('returns 403 when a write tool is invoked on a read-only deployment', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_restart_web_app',
      headers: auth,
      payload: { resourceId: webAppId(), confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
  });

  it('allows a dry run of a write tool on a read-only deployment', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_restart_web_app',
      headers: auth,
      payload: { resourceId: webAppId(), dryRun: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ dryRun: true, performed: false });
  });

  it('serves an OpenAPI document covering every tool', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe('3.1.0');
    for (const tool of app.registry.list()) {
      expect(document.paths[`/tools/${tool.name}`]).toBeDefined();
    }
    expect(document.paths['/tools/azure_restart_web_app'].post['x-openai-isConsequential']).toBe(
      true,
    );
    expect(document.paths['/tools/azure_get_resource'].post['x-openai-isConsequential']).toBe(
      false,
    );
  });

  it('returns 404 in the standard error envelope for unknown routes', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'not_found' });
  });
});

describe('rate limiting', () => {
  it('returns 429 once the window is exhausted', async () => {
    const app = buildApp({ RATE_LIMIT_MAX: '2' });
    await app.http.ready();
    const headers = { authorization: ['Bearer', API_KEY].join(' ') };

    expect((await app.http.inject({ method: 'GET', url: '/tools', headers })).statusCode).toBe(200);
    expect((await app.http.inject({ method: 'GET', url: '/tools', headers })).statusCode).toBe(200);
    const limited = await app.http.inject({ method: 'GET', url: '/tools', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');

    await app.http.close();
  });
});

describe('disabled auth mode', () => {
  it('allows anonymous tool calls in development', async () => {
    const app = createApplication({
      config: testConfig({ AUTH_MODE: 'disabled' }),
      logger: createTestLogger() as unknown as Logger,
      provider: createFakeProvider(),
    });
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_subscriptions',
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    await app.http.close();
  });
});
