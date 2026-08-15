import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import type { AppConfig } from '../../config/index.js';

/**
 * Azure authentication always goes through the ambient credential chain. In Azure the server runs
 * with user-assigned managed identities selected by client id; locally it falls back to the
 * developer's `az login` session. No secrets are ever read from configuration.
 */
export const createAzureCredential = (
  config: AppConfig,
  clientId: string | undefined,
): TokenCredential =>
  new DefaultAzureCredential({
    ...(clientId ? { managedIdentityClientId: clientId } : {}),
    ...(config.azure.tenantId ? { tenantId: config.azure.tenantId } : {}),
  });

export interface AzureCredentials {
  /** Reads and the four constrained mutations. */
  readonly operator: TokenCredential;
  /**
   * Generic Bicep deployments. A separate user-assigned identity, so the broad write permissions a
   * deployment needs are never available to the read and operator surface.
   */
  readonly deployment: TokenCredential;
}

export const createAzureCredentials = (config: AppConfig): AzureCredentials => {
  const operator = createAzureCredential(config, config.azure.clientId);
  return {
    operator,
    deployment: config.azure.deploymentClientId
      ? createAzureCredential(config, config.azure.deploymentClientId)
      : operator,
  };
};
