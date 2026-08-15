import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from '../app.js';
import { createMcpServer } from './server.js';

/**
 * Entry point for running the server as a local MCP server over stdio (`npm run mcp:stdio`).
 * Logs go to stderr so that stdout stays a clean JSON-RPC channel.
 *
 * The caller here is the local operating system user, who already holds whatever Azure credentials
 * `DefaultAzureCredential` finds. There is no second authentication step to perform, and the
 * process-level allow-lists still apply.
 */
const main = async (): Promise<void> => {
  const app = createApplication();
  const { config, registry, services, logger } = app;

  const server = createMcpServer(config, registry, services, {
    transport: 'mcp-stdio',
    context: () => ({ requestId: randomUUID(), principal: 'stdio:local' }),
  });

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  logger.info({ tools: registry.list().length }, 'MCP stdio server connected');
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      msg: 'failed to start MCP stdio server',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
