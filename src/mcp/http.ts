import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import type { Services } from '../services/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './server.js';

export interface McpHttpHandlerDeps {
  readonly config: AppConfig;
  readonly registry: ToolRegistry;
  readonly services: Services;
}

/**
 * Stateless Streamable HTTP MCP endpoint.
 *
 * A fresh server and transport are created for each request and closed when it completes, so no
 * session state accumulates in the process. That is what lets the same deployment scale to zero
 * and run several replicas behind one hostname without sticky routing.
 *
 * Authentication, rate limiting and the audit principal are applied by the surrounding Fastify
 * hooks, exactly as for the plain HTTP tool routes: this transport adds a protocol, never a way
 * around the guards.
 */
export const handleMcpHttpRequest = async (
  deps: McpHttpHandlerDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const principal = request.principal?.id ?? 'anonymous';

  const server = createMcpServer(deps.config, deps.registry, deps.services, {
    transport: 'mcp-http',
    context: () => ({ requestId: request.id, principal }),
  });

  const transport = new StreamableHTTPServerTransport({
    // Stateless: omitting sessionIdGenerator disables session management entirely, so no session
    // id is issued and none is required.
    //
    // Return a single JSON response rather than opening an SSE stream, which keeps every call a
    // bounded request/response pair that an ingress and a scale-to-zero app can reason about.
    enableJsonResponse: true,
  });

  reply.hijack();
  try {
    // The SDK's Transport interface declares optional callbacks that the concrete transport types
    // as `T | undefined`; under exactOptionalPropertyTypes those are not assignable without a
    // cast. The runtime contract is unaffected.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } finally {
    // The response has already been written by the time handleRequest resolves in JSON mode, so
    // nothing survives the request: no session map, no open stream, no listener.
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
};
