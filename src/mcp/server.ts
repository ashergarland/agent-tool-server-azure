import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import type { ToolRegistry } from '../tools/registry.js';

const shapeOf = (schema: z.ZodType): z.ZodRawShape =>
  schema instanceof z.ZodObject ? (schema.shape as z.ZodRawShape) : {};

/**
 * MCP transport over the exact same tool registry that backs the HTTP surface. No Azure logic is
 * duplicated here: this module only adapts the registry to MCP's tool protocol.
 */
export const createMcpServer = (
  config: AppConfig,
  registry: ToolRegistry,
  services: Services,
): McpServer => {
  const server = new McpServer(
    { name: config.service.name, version: config.service.version },
    { capabilities: { tools: {} } },
  );

  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: shapeOf(tool.inputSchema),
        annotations: {
          readOnlyHint: tool.kind === 'read',
          destructiveHint: tool.kind === 'write',
          idempotentHint: tool.kind === 'read',
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const result = await tool.invoke(args, services, {
            requestId: `mcp-${Date.now().toString(36)}`,
            principal: 'mcp-client',
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
                text: JSON.stringify({ code: appError.code, message: appError.message }, null, 2),
              },
            ],
          };
        }
      },
    );
  }

  return server;
};
