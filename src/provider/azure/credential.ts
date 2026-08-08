import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import type { AppConfig } from '../../config/index.js';

/**
 * Azure authentication always goes through the ambient credential chain. In Azure the connector
 * runs with a user-assigned managed identity (AZURE_CLIENT_ID); locally it falls back to the
 * developer's `az login` session. No secrets are ever read from configuration.
 */
export const createAzureCredential = (config: AppConfig): TokenCredential =>
  new DefaultAzureCredential({
    ...(config.azure.clientId ? { managedIdentityClientId: config.azure.clientId } : {}),
    ...(config.azure.tenantId ? { tenantId: config.azure.tenantId } : {}),
  });
