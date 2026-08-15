import { createApplication } from './app.js';
import { ConfigurationError } from './config/index.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const main = async (): Promise<void> => {
  const app = createApplication();
  const { config, logger, http } = app;
  let shuttingDown = false;

  /**
   * Graceful drain. Container Apps sends SIGTERM and then waits before killing the container, so
   * the correct behaviour is to stop accepting new connections and let in-flight tool calls
   * finish. A deployment that is mid-flight in ARM is unaffected either way — it was started with
   * a fire-and-forget PUT precisely so that a restart cannot orphan it.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, graceMs: config.http.shutdownGraceMs }, 'draining');

    const forced = setTimeout(() => {
      logger.warn('drain timed out; exiting anyway');
      process.exit(0);
    }, config.http.shutdownGraceMs);
    forced.unref();

    try {
      await http.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  await http.listen({ host: config.http.host, port: config.http.port });
  logger.info(
    {
      port: config.http.port,
      authMode: config.auth.mode,
      mutationsEnabled: config.guardrails.mutationsEnabled,
      deploymentsEnabled: config.deployments.enabled,
      mcpHttpEnabled: config.mcp.httpEnabled,
      scopedSubscriptions: config.azure.allowedSubscriptionIds.length,
    },
    'agent-tool-server-azure listening',
  );
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      msg: error instanceof ConfigurationError ? 'invalid configuration' : 'failed to start',
      error: message,
    })}\n`,
  );
  process.exit(1);
});
