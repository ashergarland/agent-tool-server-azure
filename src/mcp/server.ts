import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import { SERVER_INSTRUCTIONS } from '../tools/instructions.js';
import type { ToolRegistry, ToolTransport } from '../tools/registry.js';

const shapeOf = (schema: z.ZodType): z.ZodRawShape =>
  schema instanceof z.ZodObject ? schema.shape : {};

export interface McpContextFactory {
  (toolName: string): { readonly requestId: string; readonly principal: string };
}

export interface CreateMcpServerOptions {
  readonly transport: ToolTransport;
  readonly context: McpContextFactory;
}

/**
 * MCP adaptation of the tool registry. No Azure logic lives here: this module only translates the
 * registry into MCP's tool protocol, so stdio, Streamable HTTP and plain HTTP can never drift
 * apart in names, schemas, annotations or behaviour.
 */
export const createMcpServer = (
  config: AppConfig,
  registry: ToolRegistry,
  services: Services,
  options: CreateMcpServerOptions,
): McpServer => {
  const server = new McpServer(
    { name: config.service.name, version: config.service.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: shapeOf(tool.inputSchema),
        outputSchema: shapeOf(tool.outputSchema),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        },
      },
      async (args: unknown) => {
        const { requestId, principal } = options.context(tool.name);
        try {
          const result = await tool.invoke(args, services, {
            requestId,
            principal,
            transport: options.transport,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          const appError = toAppError(error);
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
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
      },
    );
  }

  return server;
};
