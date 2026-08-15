import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { CliBicepCompiler, type BicepCompiler } from '../bicep/index.js';
import type { DeploymentRecordStore } from '../deployments/records.js';
import { createDeploymentRecordStore } from '../deployments/store.js';
import type { AzureProvider } from '../provider/types.js';
import { Metrics } from '../util/metrics.js';
import { DeploymentService } from './deployments.js';
import { DiagnosticsService } from './diagnostics.js';
import { Guardrails } from './guardrails.js';
import { InventoryService } from './inventory.js';
import { OperationsService } from './operations.js';

export { DeploymentService, DiagnosticsService, Guardrails, InventoryService, OperationsService };

export interface Services {
  readonly guardrails: Guardrails;
  readonly inventory: InventoryService;
  readonly diagnostics: DiagnosticsService;
  readonly operations: OperationsService;
  readonly deployments: DeploymentService;
  readonly metrics: Metrics;
  readonly compiler: BicepCompiler;
  readonly deploymentStore: DeploymentRecordStore;
}

export interface CreateServicesOptions {
  /** Injectable for tests, so no compiler binary or Azure account is required. */
  readonly compiler?: BicepCompiler;
  readonly store?: DeploymentRecordStore;
  readonly metrics?: Metrics;
}

export const createServices = (
  config: AppConfig,
  provider: AzureProvider,
  logger: Logger,
  options: CreateServicesOptions = {},
): Services => {
  const guardrails = new Guardrails(config);
  const metrics = options.metrics ?? new Metrics();
  const compiler =
    options.compiler ??
    new CliBicepCompiler({
      cliPath: config.bicep.cliPath,
      expectedSha256: config.bicep.expectedSha256,
      timeoutMs: config.bicep.timeoutMs,
      maxOutputBytes: config.bicep.maxOutputBytes,
      maxConcurrency: config.bicep.maxConcurrency,
      modulePolicy: config.bicep.modulePolicy,
      runAsUid: config.bicep.runAsUid,
      runAsGid: config.bicep.runAsGid,
    });
  const store = options.store ?? createDeploymentRecordStore(config);

  return {
    guardrails,
    metrics,
    compiler,
    deploymentStore: store,
    inventory: new InventoryService(provider, guardrails, config),
    diagnostics: new DiagnosticsService(provider, guardrails),
    operations: new OperationsService(provider, guardrails, logger, metrics),
    deployments: new DeploymentService({
      provider,
      guardrails,
      config,
      store,
      compiler,
      logger,
      metrics,
    }),
  };
};
