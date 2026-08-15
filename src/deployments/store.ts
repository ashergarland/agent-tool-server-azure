import type { AppConfig } from '../config/index.js';
import { createAzureCredentials } from '../provider/azure/credential.js';
import type { DeploymentRecordStore } from './records.js';
import { AzureTableDeploymentRecordStore } from './store-azure.js';
import { InMemoryDeploymentRecordStore } from './store-memory.js';

export * from './records.js';
export { AzureTableDeploymentRecordStore } from './store-azure.js';
export { InMemoryDeploymentRecordStore } from './store-memory.js';

/**
 * Chooses the record implementation from configuration. Production configuration refuses the
 * in-memory store, because a Container App that scales to zero would forget every pending preview
 * between calls and two replicas would disagree about what was approved.
 */
export const createDeploymentRecordStore = (config: AppConfig): DeploymentRecordStore => {
  if (config.deployments.store.kind === 'memory') {
    return new InMemoryDeploymentRecordStore();
  }

  const endpoint = config.deployments.store.tableEndpoint;
  if (!endpoint) {
    throw new Error('DEPLOYMENT_RECORD_TABLE_ENDPOINT is required for the azure-table store');
  }

  return new AzureTableDeploymentRecordStore(createAzureCredentials(config).deployment, {
    accountUrl: endpoint,
    recordsTable: config.deployments.store.recordsTable,
    locksTable: config.deployments.store.locksTable,
    lockTtlMs: config.deployments.store.lockTtlMs,
  });
};
