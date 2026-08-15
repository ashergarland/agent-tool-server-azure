import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/index.js';
import type { BicepCompiler } from './bicep/index.js';
import type { DeploymentRecordStore } from './deployments/records.js';
import { createAzureProvider } from './provider/azure/index.js';
import type { AzureProvider } from './provider/types.js';
import { createServices, type Services } from './services/index.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly http: HttpServer;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  /** Injectable for tests; defaults to the real Azure SDK adapter. */
  readonly provider?: AzureProvider;
  /** Injectable for tests; defaults to the pinned Bicep CLI adapter. */
  readonly compiler?: BicepCompiler;
  /** Injectable for tests; defaults to the store chosen by configuration. */
  readonly store?: DeploymentRecordStore;
}

/**
 * Composition root. Everything is wired here so that tests can substitute the Azure provider, the
 * compiler and the record store without touching any other layer.
 */
export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const provider = options.provider ?? createAzureProvider(config);
  const services = createServices(config, provider, logger, {
    ...(options.compiler === undefined ? {} : { compiler: options.compiler }),
    ...(options.store === undefined ? {} : { store: options.store }),
  });
  const registry = createToolRegistry();
  const http = createHttpServer({ config, logger, services, registry });

  return { config, logger, services, registry, http };
};
