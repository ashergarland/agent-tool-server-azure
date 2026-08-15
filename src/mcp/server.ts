import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../config/index.js';
import { toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import { SERVER_INSTRUCTIONS } from '../tools/instructions.js';
import type { ToolRegistry, ToolTransport } from '../tools/registry.js';

export interface McpContextFactory {
  (toolName: string): { readonly requestId: string; readonly principal: string };
}

export interface CreateMcpServerOptions {
  readonly transport: ToolTransport;
  readonly context: McpContextFactory;
}

type ToolListEntry = ListToolsResult['tools'][number];

/**
 * MCP adaptation of the tool registry.
 *
 * The list and call handlers are implemented directly rather than through the higher-level helper,
 * because that helper re-derives a JSON Schema from a Zod shape and quietly drops constraints
 * declared on the object itself. Serving `tool.inputJsonSchema` verbatim is what guarantees an MCP
 * client and an HTTP client see byte-identical contracts: there is one schema per tool, and every
 * transport publishes that one.
 */
export const createMcpServer = (
  config: AppConfig,
  registry: ToolRegistry,
  services: Services,
  options: CreateMcpServerOptions,
): Server => {
  const server = new Server(
    { name: config.service.name, version: config.service.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: registry.list().map((tool): ToolListEntry => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputJsonSchema as ToolListEntry['inputSchema'],
      outputSchema: tool.outputJsonSchema as ToolListEntry['outputSchema'],
      annotations: {
        title: tool.title,
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { requestId, principal } = options.context(request.params.name);
    try {
      const tool = registry.get(request.params.name);
      const result = await tool.invoke(request.params.arguments ?? {}, services, {
        requestId,
        principal,
        transport: options.transport,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      // Tool failures are reported in band so the model can react to them, rather than as protocol
      // errors, which look to a client like the server itself is broken.
      const appError = toAppError(error);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                code: appError.code,
                message: appError.message,
                ...(appError.details === undefined ? {} : { details: appError.details }),
                requestId,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  });

  return server;
};
