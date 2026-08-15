import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from 'pino';
import { createApplication } from '../../src/app.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { SERVER_INSTRUCTIONS } from '../../src/tools/instructions.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler } from '../helpers/bicep.js';
import { createFakeProvider, createTestLogger, SUB_A } from '../helpers/fake-provider.js';

const API_KEY = 'transport-parity-key-that-is-long-enough';

const build = () =>
  createApplication({
    config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY }),
    logger: createTestLogger() as unknown as Logger,
    provider: createFakeProvider(),
    compiler: createFakeCompiler(),
  });

interface ToolSurface {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

const sortByName = <T extends { name: string }>(tools: readonly T[]): T[] =>
  [...tools].sort((a, b) => (a.name < b.name ? -1 : 1));

describe('transport parity', () => {
  const app = build();
  let baseUrl: string;

  beforeAll(async () => {
    await app.http.listen({ host: '127.0.0.1', port: 0 });
    const address = app.http.server.address();
    if (typeof address === 'string' || address === null) throw new Error('no address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.http.close();
  });

  const httpTools = async (): Promise<ToolSurface[]> => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': API_KEY },
    });
    const body = response.json<{
      instructions: string;
      tools: { name: string; description: string; inputSchema: unknown }[];
    }>();
    expect(body.instructions).toBe(SERVER_INSTRUCTIONS);
    return sortByName(body.tools);
  };

  const withClient = async <T>(
    transport: Transport,
    run: (client: Client) => Promise<T>,
  ): Promise<T> => {
    const client = new Client({ name: 'parity-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  };

  const inMemoryClient = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(app.config, app.registry, app.services, {
      transport: 'mcp-stdio',
      context: () => ({ requestId: 'test', principal: 'stdio:local' }),
    });
    await server.connect(serverTransport);
    try {
      return await withClient(clientTransport as unknown as Transport, run);
    } finally {
      await server.close();
    }
  };

  const remoteClient = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { 'x-api-key': API_KEY } },
    });
    return withClient(transport as unknown as Transport, run);
  };

  it('exposes the same tool names over HTTP, stdio MCP and Streamable HTTP MCP', async () => {
    const http = await httpTools();
    const stdio = await inMemoryClient(async (client) =>
      sortByName((await client.listTools()).tools),
    );
    const remote = await remoteClient(async (client) =>
      sortByName((await client.listTools()).tools),
    );

    const names = http.map((tool) => tool.name);
    expect(names.length).toBeGreaterThanOrEqual(18);
    expect(stdio.map((tool) => tool.name)).toEqual(names);
    expect(remote.map((tool) => tool.name)).toEqual(names);
  });

  it('serves identical descriptions and input schemas across MCP transports', async () => {
    const http = await httpTools();
    const stdio = await inMemoryClient(async (client) =>
      sortByName((await client.listTools()).tools),
    );

    for (const [index, tool] of stdio.entries()) {
      const reference = http[index];
      expect(tool.name).toBe(reference?.name);
      expect(tool.description).toBe(reference?.description);
      expect(tool.inputSchema).toEqual(reference?.inputSchema);
    }
  });

  it('advertises annotations that match each tool’s declared behaviour', async () => {
    const tools = await inMemoryClient(async (client) => (await client.listTools()).tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get('azure_list_subscriptions')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get('azure_deploy_bicep')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get('azure_tag_resource')?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('shares server instructions with MCP clients', async () => {
    const instructions = await inMemoryClient((client) =>
      Promise.resolve(client.getInstructions()),
    );
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('returns the same tool result over every transport', async () => {
    const httpResponse = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_list_subscriptions',
      headers: { 'x-api-key': API_KEY },
      payload: {},
    });
    const httpResult = httpResponse.json<{ result: unknown }>().result;

    const stdioResult = await inMemoryClient(
      async (client) =>
        (await client.callTool({ name: 'azure_list_subscriptions', arguments: {} }))
          .structuredContent,
    );
    const remoteResult = await remoteClient(
      async (client) =>
        (await client.callTool({ name: 'azure_list_subscriptions', arguments: {} }))
          .structuredContent,
    );

    expect(stdioResult).toEqual(httpResult);
    expect(remoteResult).toEqual(httpResult);
    expect((httpResult as { subscriptions: unknown[] }).subscriptions).toHaveLength(2);
  });

  it('applies the same guardrails to MCP calls as to HTTP calls', async () => {
    const result = await inMemoryClient((client) =>
      client.callTool({
        name: 'azure_restart_web_app',
        arguments: {
          resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-prod/providers/Microsoft.Web/sites/api`,
          confirm: true,
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('forbidden');
  });

  it('rejects unauthenticated Streamable HTTP MCP requests', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
  });
});
