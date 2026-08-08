import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from '../app.js';
import { createMcpServer } from './server.js';

/**
 * Entry point for running the connector as a local MCP server (`npm run mcp:stdio`).
 * Logs go to stderr so that stdout stays a clean JSON-RPC channel.
 */
const main = async (): Promise<void> => {
  const { config, registry, services, logger } = createApplication();
  const server = createMcpServer(config, registry, services);
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
