import { createApplication } from './app.js';
import { ConfigurationError } from './config/index.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

const main = async (): Promise<void> => {
  const app = createApplication();
  const { config, logger, http } = app;

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
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
      scopedSubscriptions: config.azure.allowedSubscriptionIds.length,
    },
    'Azure agent tool server listening',
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
