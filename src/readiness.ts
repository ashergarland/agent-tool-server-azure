import {
  readinessDegraded,
  readinessNotReady,
  readinessReady,
  type ReadinessResult,
} from '@agent-tool-platform/runtime/lifecycle';
import type { CapabilityReadinessContributor } from '@agent-tool-platform/runtime/capability';
import type { AppConfig } from './config/index.js';
import { DEPLOYMENT_REQUIRED_ACTIONS } from './provider/permissions.js';
import type { Services } from './services/index.js';

const OPERATOR_ACTIONS = [
  'Microsoft.Compute/virtualMachines/restart/action',
  'Microsoft.Compute/virtualMachines/start/action',
  'Microsoft.Web/sites/restart/action',
  'Microsoft.Resources/tags/write',
] as const;

const readProvider = async (config: AppConfig, services: Services): Promise<ReadinessResult> => {
  try {
    const subscriptions = await services.inventory.listSubscriptions();
    if (subscriptions.length === 0) {
      return readinessNotReady(
        'azure-provider',
        'Azure authentication succeeded but no configured subscription is visible',
      );
    }
    const readableSubscriptionIds = new Set(
      subscriptions
        .filter((subscription) => subscription.readable)
        .map((subscription) => subscription.subscriptionId),
    );
    if (config.azure.verifyRbac && config.azure.allowedResourceGroups.length > 0) {
      const resourceGroupChecks = await Promise.all(
        subscriptions.flatMap((subscription) =>
          config.azure.allowedResourceGroups.map(async (resourceGroup) => ({
            subscriptionId: subscription.subscriptionId,
            readable: await services.inventory.hasReadPermission(
              `/subscriptions/${subscription.subscriptionId}/resourceGroups/${resourceGroup}`,
            ),
          })),
        ),
      );
      for (const check of resourceGroupChecks) {
        if (check.readable) readableSubscriptionIds.add(check.subscriptionId);
      }
    }
    const readable = readableSubscriptionIds.size;
    if (readable === 0) {
      return readinessNotReady(
        'azure-provider',
        'Azure responded but the operator identity has no verified readable subscription',
      );
    }
    if (!config.azure.verifyRbac) {
      return readinessDegraded(
        'azure-provider',
        `provider query succeeded for ${subscriptions.length} subscription(s); RBAC verification is disabled`,
      );
    }
    return readable === subscriptions.length
      ? readinessReady(
          'azure-provider',
          `provider authentication, query, and read RBAC succeeded for ${readable} subscription(s)`,
        )
      : readinessDegraded(
          'azure-provider',
          `${readable} of ${subscriptions.length} visible subscription(s) passed read RBAC verification`,
        );
  } catch {
    return readinessNotReady(
      'azure-provider',
      'Azure authentication or the read-only provider query failed',
    );
  }
};

const operationScopes = (
  config: AppConfig,
  subscriptionIds: readonly string[],
): readonly string[] => {
  if (config.azure.allowedResourceGroups.length === 0) {
    return subscriptionIds.map((id) => `/subscriptions/${id}`);
  }
  return subscriptionIds.flatMap((id) =>
    config.azure.allowedResourceGroups.map(
      (resourceGroup) => `/subscriptions/${id}/resourceGroups/${resourceGroup}`,
    ),
  );
};

const mutationAuthorization = async (
  config: AppConfig,
  services: Services,
): Promise<ReadinessResult> => {
  if (!config.mutations.enabled) {
    return readinessReady('azure-mutations', 'mutations are disabled');
  }
  if (!config.azure.verifyRbac) {
    return readinessDegraded(
      'azure-mutations',
      'mutations are enabled but effective Azure RBAC verification is disabled',
    );
  }

  try {
    const subscriptions = await services.inventory.listSubscriptions();
    const configured =
      config.azure.allowedSubscriptionIds.length > 0
        ? config.azure.allowedSubscriptionIds
        : subscriptions
            .filter(
              (subscription) =>
                config.azure.allowedResourceGroups.length > 0 || subscription.readable,
            )
            .map((subscription) => subscription.subscriptionId);
    const scopes = operationScopes(config, configured);
    const usable = await Promise.all(
      scopes.map((scope) =>
        Promise.all(
          OPERATOR_ACTIONS.map((action) =>
            services.inventory.hasEffectivePermission(scope, 'operator', action),
          ),
        ).then((actions) => actions.every(Boolean)),
      ),
    );
    const usableCount = usable.filter(Boolean).length;
    return usableCount > 0
      ? readinessReady(
          'azure-mutations',
          `operator mutation RBAC is usable at ${usableCount} configured scope(s)`,
        )
      : readinessNotReady(
          'azure-mutations',
          'mutations are enabled but no configured scope has the required operator RBAC',
        );
  } catch {
    return readinessNotReady(
      'azure-mutations',
      'mutation authorization could not be verified with Azure',
    );
  }
};

const deploymentAuthorization = async (
  config: AppConfig,
  services: Services,
): Promise<ReadinessResult> => {
  if (!config.deployments.enabled) {
    return readinessReady('azure-deployments', 'generic Bicep deployment is disabled');
  }
  if (!config.azure.verifyRbac) {
    return readinessDegraded(
      'azure-deployments',
      'deployments are enabled but effective Azure RBAC verification is disabled',
    );
  }

  const scopes = [
    ...operationScopes(config, config.azure.allowedSubscriptionIds),
    ...config.azure.allowedManagementGroupIds.map(
      (id) => `/providers/Microsoft.Management/managementGroups/${id}`,
    ),
    ...(config.azure.tenantDeploymentsEnabled ? ['/'] : []),
  ];
  try {
    const usable = await Promise.all(
      scopes.map((scope) =>
        services.inventory.hasEffectivePermissions(
          scope,
          'deployment',
          DEPLOYMENT_REQUIRED_ACTIONS,
        ),
      ),
    );
    const usableCount = usable.filter(Boolean).length;
    return usableCount > 0
      ? readinessReady(
          'azure-deployments',
          `deployment identity RBAC is usable at ${usableCount} configured scope(s)`,
        )
      : readinessNotReady(
          'azure-deployments',
          'deployments are enabled but no configured scope has deployment RBAC',
        );
  } catch {
    return readinessNotReady(
      'azure-deployments',
      'deployment authorization could not be verified with Azure',
    );
  }
};

const deploymentStore = async (config: AppConfig, services: Services): Promise<ReadinessResult> => {
  if (!config.deployments.enabled) {
    return readinessReady('deployment-store', 'generic Bicep deployment is disabled');
  }
  try {
    await services.deploymentStore.ping();
    return readinessReady('deployment-store', services.deploymentStore.describe().kind);
  } catch {
    return readinessNotReady('deployment-store', 'the deployment record store is unavailable');
  }
};

const bicepCompiler = async (config: AppConfig, services: Services): Promise<ReadinessResult> => {
  if (!config.deployments.enabled) {
    return readinessReady('bicep-compiler', 'generic Bicep deployment is disabled');
  }
  try {
    const compiler = await services.compiler.describe();
    if (!compiler.available) {
      return readinessNotReady('bicep-compiler', 'the configured Bicep compiler is unavailable');
    }
    return compiler.checksumVerified
      ? readinessReady('bicep-compiler', `Bicep ${compiler.version ?? 'unknown'} digest verified`)
      : readinessDegraded(
          'bicep-compiler',
          `Bicep ${compiler.version ?? 'unknown'} is available but its digest is not configured`,
        );
  } catch {
    return readinessNotReady('bicep-compiler', 'the Bicep compiler check failed');
  }
};

export const azureReadiness = [
  ({ config, services }) => readProvider(config, services),
  ({ config, services }) => mutationAuthorization(config, services),
  ({ config, services }) => deploymentAuthorization(config, services),
  ({ config, services }) => deploymentStore(config, services),
  ({ config, services }) => bicepCompiler(config, services),
] satisfies readonly CapabilityReadinessContributor<AppConfig, Services>[];
