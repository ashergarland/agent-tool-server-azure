import type { AppConfig } from '../config/index.js';
import type { Services } from '../services/index.js';
import type { ToolRegistry } from '../tools/registry.js';

export type ComponentState = 'ok' | 'degraded' | 'unavailable' | 'disabled';

export interface ComponentReport {
  readonly state: ComponentState;
  readonly detail: string | undefined;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly service: string;
  readonly version: string;
  readonly gitSha: string;
  readonly environment: string;
  readonly checkedAt: string;
  readonly components: Readonly<Record<string, ComponentReport>>;
  readonly capabilities: {
    readonly authMode: string;
    readonly mutationsEnabled: boolean;
    readonly confirmationRequired: boolean;
    readonly deploymentsEnabled: boolean;
    readonly remoteModulesEnabled: boolean;
    readonly tenantDeploymentsEnabled: boolean;
    readonly mcpHttpEnabled: boolean;
    readonly scopedSubscriptions: number;
    readonly scopedResourceGroups: number;
    readonly scopedManagementGroups: number;
    readonly toolCount: number;
    readonly transports: readonly string[];
  };
}

const ok = (detail?: string): ComponentReport => ({ state: 'ok', detail });

/**
 * Readiness, as distinct from liveness.
 *
 * `/health` answers "is this process running". `/ready` answers "can this process do its job":
 * the registry built, the record store answers, the pinned compiler is present and verified, and
 * the identity configuration is coherent. It performs no mutation and contacts no Azure control
 * plane, so a probe can run as often as the platform likes.
 */
export const buildReadinessReport = async (
  config: AppConfig,
  registry: ToolRegistry,
  services: Services,
): Promise<ReadinessReport> => {
  const components: Record<string, ComponentReport> = {};

  const tools = registry.list();
  components['registry'] =
    tools.length > 0
      ? ok(`${tools.length} tools`)
      : { state: 'unavailable', detail: 'the tool registry is empty' };

  if (config.deployments.enabled) {
    try {
      await services.deploymentStore.ping();
      const info = services.deploymentStore.describe();
      components['deploymentStore'] = ok(`${info.kind}${info.detail ? `: ${info.detail}` : ''}`);
    } catch (error) {
      components['deploymentStore'] = {
        state: 'unavailable',
        detail: error instanceof Error ? error.message : 'the record store is unreachable',
      };
    }

    const compiler = await services.compiler.describe();
    components['bicepCompiler'] = compiler.available
      ? {
          state: compiler.checksumVerified ? 'ok' : 'degraded',
          detail: compiler.checksumVerified
            ? `bicep ${compiler.version ?? 'unknown'} (digest verified)`
            : `bicep ${compiler.version ?? 'unknown'} (BICEP_CLI_SHA256 not configured)`,
        }
      : { state: 'unavailable', detail: compiler.detail };
  } else {
    components['deploymentStore'] = { state: 'disabled', detail: 'DEPLOYMENTS_ENABLED=false' };
    components['bicepCompiler'] = { state: 'disabled', detail: 'DEPLOYMENTS_ENABLED=false' };
  }

  components['identity'] = describeIdentity(config);
  components['scopes'] = describeScopes(config);

  const ready = Object.values(components).every(
    (component) => component.state === 'ok' || component.state === 'disabled',
  );

  return {
    ready,
    service: config.service.name,
    version: config.service.version,
    gitSha: config.service.gitSha,
    environment: config.env,
    checkedAt: new Date().toISOString(),
    components,
    capabilities: {
      authMode: config.auth.mode,
      mutationsEnabled: config.guardrails.mutationsEnabled,
      confirmationRequired: config.guardrails.confirmationRequired,
      deploymentsEnabled: config.deployments.enabled,
      remoteModulesEnabled: config.bicep.modulePolicy.remoteModulesEnabled,
      tenantDeploymentsEnabled: config.azure.tenantDeploymentsEnabled,
      mcpHttpEnabled: config.mcp.httpEnabled,
      scopedSubscriptions: config.azure.allowedSubscriptionIds.length,
      scopedResourceGroups: config.azure.allowedResourceGroups.length,
      scopedManagementGroups: config.azure.allowedManagementGroupIds.length,
      toolCount: tools.length,
      transports: ['http', 'mcp-stdio', ...(config.mcp.httpEnabled ? ['mcp-http'] : [])],
    },
  };
};

const describeIdentity = (config: AppConfig): ComponentReport => {
  if (config.isProduction && !config.azure.clientId) {
    return {
      state: 'degraded',
      detail: 'AZURE_CLIENT_ID is unset, so the ambient credential chain will be used',
    };
  }
  if (config.deployments.enabled && !config.azure.deploymentClientId) {
    return {
      state: 'degraded',
      detail: 'deployments share the operator identity because AZURE_DEPLOYMENT_CLIENT_ID is unset',
    };
  }
  return ok(
    config.azure.deploymentClientId
      ? 'separate operator and deployment identities'
      : 'operator identity only',
  );
};

const describeScopes = (config: AppConfig): ComponentReport => {
  if (config.azure.allowedSubscriptionIds.length === 0) {
    return {
      state: config.isProduction ? 'degraded' : 'ok',
      detail:
        'AZURE_SUBSCRIPTION_IDS is empty: reads are limited only by the identity’s own RBAC and ' +
        'deployments are refused',
    };
  }
  return ok(`${config.azure.allowedSubscriptionIds.length} subscriptions allow-listed`);
};
