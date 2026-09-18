import { z } from 'zod';
import {
  ConfigurationError,
  csvList,
  defineCapabilityConfig,
  loadCapabilityConfig,
  strictBoolean,
  type PlatformConfig,
} from '@agent-tool-platform/runtime/config';
import packageManifest from '../../package.json' with { type: 'json' };
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_DENIED_RESOURCE_TYPES,
  type BundleLimits,
  type InspectionLimits,
  type ModulePolicy,
} from '../bicep/index.js';

const capabilityEnvSchema = z.object({
  // Azure needs larger request bodies for bounded Bicep bundles and a finite provider deadline.
  // These specialize Platform defaults; Platform still owns parsing and enforcement.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(64_000).max(16_777_216).default(4_194_304),

  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_DEPLOYMENT_CLIENT_ID: z.string().optional(),
  AZURE_SUBSCRIPTION_IDS: csvList.default([]),
  AZURE_ALLOWED_RESOURCE_GROUPS: csvList.default([]),
  AZURE_ALLOWED_MANAGEMENT_GROUP_IDS: csvList.default([]),
  AZURE_TENANT_DEPLOYMENTS_ENABLED: strictBoolean.default(false),
  AZURE_ARM_ENDPOINT: z.url().default('https://management.azure.com'),
  AZURE_ARM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  AZURE_MUTATION_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
  AZURE_VERIFY_RBAC: strictBoolean.default(true),
  AZURE_RBAC_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),

  DEPLOYMENTS_ENABLED: strictBoolean.default(false),
  DEPLOYMENT_PREVIEW_TTL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  DEPLOYMENT_MAX_PREVIEW_CHANGES: z.coerce.number().int().min(1).max(2_000).default(200),
  DEPLOYMENT_MAX_PROPERTY_CHANGES: z.coerce.number().int().min(1).max(200).default(20),
  DEPLOYMENT_MAX_OPERATIONS: z.coerce.number().int().min(1).max(500).default(100),
  DEPLOYMENT_WHATIF_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(900_000).default(300_000),
  DEPLOYMENT_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  DEPLOYMENT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(2),
  DEPLOYMENT_RECORD_STORE: z.enum(['memory', 'azure-table']).default('memory'),
  DEPLOYMENT_RECORD_TABLE_ENDPOINT: z.url().optional(),
  DEPLOYMENT_RECORD_TABLE_NAME: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/u)
    .default('deploymentrecords'),
  DEPLOYMENT_LOCK_TABLE_NAME: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/u)
    .default('deploymentlocks'),
  DEPLOYMENT_LOCK_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),

  BICEP_CLI_PATH: z.string().default(''),
  BICEP_CLI_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/u, 'must be a hex SHA-256 digest')
    .optional(),
  BICEP_COMPILE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  BICEP_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).max(16_777_216).default(8_388_608),
  BICEP_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  BICEP_MAX_FILES: z.coerce.number().int().min(1).max(512).default(64),
  BICEP_MAX_FILE_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(262_144),
  BICEP_MAX_TOTAL_BYTES: z.coerce.number().int().min(1_024).max(8_388_608).default(1_048_576),
  BICEP_MAX_PATH_LENGTH: z.coerce.number().int().min(16).max(1_024).default(200),
  BICEP_MAX_PATH_DEPTH: z.coerce.number().int().min(1).max(32).default(8),
  BICEP_ALLOWED_EXTENSIONS: csvList.default([...DEFAULT_ALLOWED_EXTENSIONS]),
  BICEP_MAX_TEMPLATE_RESOURCES: z.coerce.number().int().min(1).max(5_000).default(500),
  BICEP_MAX_TEMPLATE_BYTES: z.coerce.number().int().min(1_024).max(8_388_608).default(4_194_304),
  BICEP_MAX_NESTED_DEPLOYMENTS: z.coerce.number().int().min(0).max(256).default(32),
  BICEP_DENIED_RESOURCE_TYPES: csvList.default([...DEFAULT_DENIED_RESOURCE_TYPES]),
  BICEP_REMOTE_MODULES_ENABLED: strictBoolean.default(false),
  BICEP_ALLOWED_REGISTRIES: csvList.default([]),
});

export { capabilityEnvSchema as envSchema };
export type Env = z.infer<typeof capabilityEnvSchema>;

export interface DeploymentStoreConfig {
  readonly kind: 'memory' | 'azure-table';
  readonly tableEndpoint: string | undefined;
  readonly recordsTable: string;
  readonly locksTable: string;
  readonly lockTtlMs: number;
}

export interface AppConfig extends PlatformConfig {
  readonly azure: {
    readonly tenantId: string | undefined;
    readonly clientId: string | undefined;
    readonly deploymentClientId: string | undefined;
    readonly armEndpoint: string;
    readonly armRequestTimeoutMs: number;
    readonly mutationTimeoutMs: number;
    readonly allowedSubscriptionIds: readonly string[];
    readonly allowedResourceGroups: readonly string[];
    readonly allowedManagementGroupIds: readonly string[];
    readonly tenantDeploymentsEnabled: boolean;
    readonly verifyRbac: boolean;
    readonly rbacCacheTtlMs: number;
  };
  readonly deployments: {
    readonly enabled: boolean;
    readonly previewTtlMs: number;
    readonly maxPreviewChanges: number;
    readonly maxPropertyChanges: number;
    readonly maxOperations: number;
    readonly whatIfTimeoutMs: number;
    readonly pollIntervalMs: number;
    readonly maxConcurrent: number;
    readonly store: DeploymentStoreConfig;
  };
  readonly bicep: {
    readonly cliPath: string;
    readonly expectedSha256: string | undefined;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxConcurrency: number;
    readonly bundleLimits: BundleLimits;
    readonly inspectionLimits: InspectionLimits;
    readonly modulePolicy: ModulePolicy;
  };
}

const assertDeploymentConfiguration = (config: AppConfig): void => {
  if (!config.deployments.enabled) return;

  if (config.bicep.cliPath.length === 0) {
    throw new ConfigurationError('DEPLOYMENTS_ENABLED=true requires BICEP_CLI_PATH');
  }
  if (config.http.requestTimeoutMs !== 0) {
    throw new ConfigurationError(
      'DEPLOYMENTS_ENABLED=true requires REQUEST_TIMEOUT_MS=0 so the Bicep compiler and ARM ' +
        'what-if domain timeouts remain authoritative',
    );
  }
  if (
    config.bicep.modulePolicy.remoteModulesEnabled &&
    config.bicep.modulePolicy.allowedRegistries.length === 0
  ) {
    throw new ConfigurationError(
      'BICEP_REMOTE_MODULES_ENABLED=true requires BICEP_ALLOWED_REGISTRIES',
    );
  }
  if (
    config.deployments.store.kind === 'azure-table' &&
    config.deployments.store.lockTtlMs <= config.azure.armRequestTimeoutMs * 4
  ) {
    throw new ConfigurationError(
      'DEPLOYMENT_LOCK_TTL_MS must exceed four AZURE_ARM_REQUEST_TIMEOUT_MS intervals so the ' +
        'scope-lock lease can be renewed before it expires',
    );
  }
  if (!config.isProduction) return;

  if (!config.bicep.expectedSha256) {
    throw new ConfigurationError(
      'BICEP_CLI_SHA256 is required in production so the compiler binary is pinned',
    );
  }
  if (!config.azure.clientId) {
    throw new ConfigurationError(
      'AZURE_CLIENT_ID is required when deployments are enabled in production so the operator ' +
        'identity is explicit and separate from the deployment identity',
    );
  }
  if (!config.azure.deploymentClientId) {
    throw new ConfigurationError(
      'AZURE_DEPLOYMENT_CLIENT_ID is required in production: deployments must use an identity ' +
        'separate from the read and operator identity',
    );
  }
  if (config.azure.clientId.toLowerCase() === config.azure.deploymentClientId.toLowerCase()) {
    throw new ConfigurationError(
      'AZURE_CLIENT_ID and AZURE_DEPLOYMENT_CLIENT_ID must identify different managed identities ' +
        'when deployments are enabled in production',
    );
  }
  if (config.deployments.store.kind !== 'azure-table') {
    throw new ConfigurationError(
      'DEPLOYMENT_RECORD_STORE=azure-table is required in production; in-memory records are lost ' +
        'when the app scales to zero',
    );
  }
  if (!config.deployments.store.tableEndpoint) {
    throw new ConfigurationError(
      'DEPLOYMENT_RECORD_TABLE_ENDPOINT is required when DEPLOYMENT_RECORD_STORE=azure-table',
    );
  }
  if (
    config.azure.allowedSubscriptionIds.length === 0 &&
    config.azure.allowedManagementGroupIds.length === 0
  ) {
    throw new ConfigurationError(
      'Deployments in production require an explicit AZURE_SUBSCRIPTION_IDS or ' +
        'AZURE_ALLOWED_MANAGEMENT_GROUP_IDS allow-list',
    );
  }
};

export const azureCapabilityConfig = defineCapabilityConfig<typeof capabilityEnvSchema, AppConfig>({
  schema: capabilityEnvSchema,
  build({ base, env }): AppConfig {
    return {
      ...base,
      http: {
        ...base.http,
        requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
        bodyLimit: env.BODY_LIMIT_BYTES,
      },
      azure: {
        tenantId: env.AZURE_TENANT_ID,
        clientId: env.AZURE_CLIENT_ID,
        deploymentClientId: env.AZURE_DEPLOYMENT_CLIENT_ID,
        armEndpoint: env.AZURE_ARM_ENDPOINT,
        armRequestTimeoutMs: env.AZURE_ARM_REQUEST_TIMEOUT_MS,
        mutationTimeoutMs: env.AZURE_MUTATION_TIMEOUT_MS,
        allowedSubscriptionIds: env.AZURE_SUBSCRIPTION_IDS.map((id) => id.toLowerCase()),
        allowedResourceGroups: env.AZURE_ALLOWED_RESOURCE_GROUPS.map((name) => name.toLowerCase()),
        allowedManagementGroupIds: env.AZURE_ALLOWED_MANAGEMENT_GROUP_IDS.map((id) =>
          id.toLowerCase(),
        ),
        tenantDeploymentsEnabled: env.AZURE_TENANT_DEPLOYMENTS_ENABLED,
        verifyRbac: env.AZURE_VERIFY_RBAC,
        rbacCacheTtlMs: env.AZURE_RBAC_CACHE_TTL_MS,
      },
      deployments: {
        enabled: env.DEPLOYMENTS_ENABLED,
        previewTtlMs: env.DEPLOYMENT_PREVIEW_TTL_MS,
        maxPreviewChanges: env.DEPLOYMENT_MAX_PREVIEW_CHANGES,
        maxPropertyChanges: env.DEPLOYMENT_MAX_PROPERTY_CHANGES,
        maxOperations: env.DEPLOYMENT_MAX_OPERATIONS,
        whatIfTimeoutMs: env.DEPLOYMENT_WHATIF_TIMEOUT_MS,
        pollIntervalMs: env.DEPLOYMENT_POLL_INTERVAL_MS,
        maxConcurrent: env.DEPLOYMENT_MAX_CONCURRENT,
        store: {
          kind: env.DEPLOYMENT_RECORD_STORE,
          tableEndpoint: env.DEPLOYMENT_RECORD_TABLE_ENDPOINT,
          recordsTable: env.DEPLOYMENT_RECORD_TABLE_NAME,
          locksTable: env.DEPLOYMENT_LOCK_TABLE_NAME,
          lockTtlMs: env.DEPLOYMENT_LOCK_TTL_MS,
        },
      },
      bicep: {
        cliPath: env.BICEP_CLI_PATH,
        expectedSha256: env.BICEP_CLI_SHA256,
        timeoutMs: env.BICEP_COMPILE_TIMEOUT_MS,
        maxOutputBytes: env.BICEP_MAX_OUTPUT_BYTES,
        maxConcurrency: env.BICEP_MAX_CONCURRENCY,
        bundleLimits: {
          maxFiles: env.BICEP_MAX_FILES,
          maxFileBytes: env.BICEP_MAX_FILE_BYTES,
          maxTotalBytes: env.BICEP_MAX_TOTAL_BYTES,
          maxPathLength: env.BICEP_MAX_PATH_LENGTH,
          maxDepth: env.BICEP_MAX_PATH_DEPTH,
          allowedExtensions: env.BICEP_ALLOWED_EXTENSIONS.map((entry) =>
            entry.startsWith('.') ? entry.toLowerCase() : `.${entry.toLowerCase()}`,
          ),
        },
        inspectionLimits: {
          maxResources: env.BICEP_MAX_TEMPLATE_RESOURCES,
          maxDepth: 12,
          maxNestedDeployments: env.BICEP_MAX_NESTED_DEPLOYMENTS,
          maxTemplateBytes: env.BICEP_MAX_TEMPLATE_BYTES,
          deniedResourceTypes: env.BICEP_DENIED_RESOURCE_TYPES.map((entry) => entry.toLowerCase()),
        },
        modulePolicy: {
          remoteModulesEnabled: env.BICEP_REMOTE_MODULES_ENABLED,
          allowedRegistries: env.BICEP_ALLOWED_REGISTRIES.map((entry) => entry.toLowerCase()),
        },
      },
    };
  },
  validate: assertDeploymentConfiguration,
});

const configDefaults = {
  serviceName: 'agent-tool-server-azure',
  serviceVersion: packageManifest.version,
} as const;

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig =>
  loadCapabilityConfig({
    defaults: configDefaults,
    spec: azureCapabilityConfig,
    source,
  });
