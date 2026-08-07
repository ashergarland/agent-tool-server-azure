import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import type { AzureProvider } from '../provider/types.js';
import { DiagnosticsService } from './diagnostics.js';
import { Guardrails } from './guardrails.js';
import { InventoryService } from './inventory.js';
import { OperationsService } from './operations.js';

export { DiagnosticsService, Guardrails, InventoryService, OperationsService };

export interface Services {
  readonly guardrails: Guardrails;
  readonly inventory: InventoryService;
  readonly diagnostics: DiagnosticsService;
  readonly operations: OperationsService;
}

export const createServices = (
  config: AppConfig,
  provider: AzureProvider,
  logger: Logger,
): Services => {
  const guardrails = new Guardrails(config);
  return {
    guardrails,
    inventory: new InventoryService(provider, guardrails),
    diagnostics: new DiagnosticsService(provider, guardrails),
    operations: new OperationsService(provider, guardrails, logger),
  };
};
