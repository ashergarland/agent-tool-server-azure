import { z } from 'zod';
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_DENIED_RESOURCE_TYPES,
  type BundleLimits,
  type InspectionLimits,
  type ModulePolicy,
} from '../bicep/index.js';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const csvList = z
  .string()
  .transform(csv)
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

// Environment variables arrive as strings from many producers, and casing is not consistent:
// Bicep's `string(bool)` yields "True"/"False", shells yield "true"/"false". Normalise before
// deciding, so a deployment never fails startup validation over capitalisation.
const booleanish = z
  .union([
    z.boolean(),
    z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .refine((value) => TRUTHY.has(value) || FALSY.has(value), {
        message: `Expected one of ${[...TRUTHY, ...FALSY].join(', ')} (case-insensitive)`,
      }),
  ])
  .transform((value) => (typeof value === 'boolean' ? value : TRUTHY.has(value)));

/**
 * Drops variables whose value is blank so an empty string means "not set" rather than "set to
 * something invalid".
 *
 * Deployment platforms routinely materialise an unset value as an empty string: the Container App
 * template always declares `PUBLIC_BASE_URL`, and the provisioning pass that first creates the app
 * has no public URL to supply yet because the ingress hostname does not exist until the app does.
 * Without this, `z.url()` would reject that empty string and the container would exit at startup
 * instead of falling back to its default.
 */
export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

/**
 * Environment contract for the server. Everything the process needs is declared here so that a
 * misconfigured deployment fails fast at startup instead of at the first Azure call.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('agent-tool-server-azure'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  HTTP_MAX_BODY_BYTES: z.coerce.number().int().min(64_000).max(16_777_216).default(4_194_304),
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  // Authentication of the *caller* (the agent or client).
  AUTH_MODE: z.enum(['api-key', 'entra-jwt', 'disabled']).default('api-key'),
  API_KEYS: csvList.default([]),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_AUDIENCE: z.string().optional(),
  ENTRA_ALLOWED_APP_IDS: csvList.default([]),

  // Authentication *to* Azure.
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  /** Separate user-assigned identity used only for generic Bicep deployments. */
  AZURE_DEPLOYMENT_CLIENT_ID: z.string().optional(),
  AZURE_SUBSCRIPTION_IDS: csvList.default([]),
  AZURE_ALLOWED_RESOURCE_GROUPS: csvList.default([]),
  AZURE_ALLOWED_MANAGEMENT_GROUP_IDS: csvList.default([]),
  AZURE_TENANT_DEPLOYMENTS_ENABLED: booleanish.default(false),
  AZURE_ARM_ENDPOINT: z.url().default('https://management.azure.com'),
  /** Ask ARM what each identity can actually do before reporting a scope as usable. */
  AZURE_VERIFY_RBAC: booleanish.default(true),
  AZURE_RBAC_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),

  // Guardrails for the four constrained mutation tools.
  MUTATIONS_ENABLED: booleanish.default(false),
  MUTATION_CONFIRMATION_REQUIRED: booleanish.default(true),

  // Remote MCP transport.
  MCP_HTTP_ENABLED: booleanish.default(true),

  // Generic Bicep deployment.
  DEPLOYMENTS_ENABLED: booleanish.default(false),
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
    .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/)
    .default('deploymentrecords'),
  DEPLOYMENT_LOCK_TABLE_NAME: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/)
    .default('deploymentlocks'),
  DEPLOYMENT_LOCK_TTL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),

  // Bicep compiler and bundle limits.
  BICEP_CLI_PATH: z.string().default(''),
  BICEP_CLI_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be a hex SHA-256 digest')
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
  BICEP_REMOTE_MODULES_ENABLED: booleanish.default(false),
  BICEP_ALLOWED_REGISTRIES: csvList.default([]),
  BICEP_TEMPLATE_SPECS_ENABLED: booleanish.default(false),
  BICEP_RUN_AS_UID: z.coerce.number().int().min(0).optional(),
  BICEP_RUN_AS_GID: z.coerce.number().int().min(0).optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface DeploymentStoreConfig {
  readonly kind: 'memory' | 'azure-table';
  readonly tableEndpoint: string | undefined;
  readonly recordsTable: string;
  readonly locksTable: string;
  readonly lockTtlMs: number;
}

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly requestTimeoutMs: number;
    readonly shutdownGraceMs: number;
    readonly maxBodyBytes: number;
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
  };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] }
    | {
        readonly mode: 'entra-jwt';
        readonly tenantId: string;
        readonly audience: string;
        readonly allowedAppIds: readonly string[];
      };
  readonly azure: {
    readonly tenantId: string | undefined;
    readonly clientId: string | undefined;
    readonly deploymentClientId: string | undefined;
    readonly armEndpoint: string;
    readonly allowedSubscriptionIds: readonly string[];
    readonly allowedResourceGroups: readonly string[];
    readonly allowedManagementGroupIds: readonly string[];
    readonly tenantDeploymentsEnabled: boolean;
    readonly verifyRbac: boolean;
    readonly rbacCacheTtlMs: number;
  };
  readonly guardrails: {
    readonly mutationsEnabled: boolean;
    readonly confirmationRequired: boolean;
  };
  readonly mcp: {
    readonly httpEnabled: boolean;
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
    readonly runAsUid: number | undefined;
    readonly runAsGid: number | undefined;
    readonly bundleLimits: BundleLimits;
    readonly inspectionLimits: InspectionLimits;
    readonly modulePolicy: ModulePolicy;
  };
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

const buildAuthConfig = (env: Env): AppConfig['auth'] => {
  switch (env.AUTH_MODE) {
    case 'disabled':
      if (env.NODE_ENV === 'production') {
        throw new ConfigurationError(
          'AUTH_MODE=disabled is not permitted when NODE_ENV=production',
        );
      }
      return { mode: 'disabled' };
    case 'api-key':
      if (env.API_KEYS.length === 0) {
        throw new ConfigurationError('AUTH_MODE=api-key requires at least one value in API_KEYS');
      }
      if (env.API_KEYS.some((key) => key.length < 32)) {
        throw new ConfigurationError('Every entry in API_KEYS must be at least 32 characters long');
      }
      return { mode: 'api-key', apiKeys: env.API_KEYS };
    case 'entra-jwt': {
      if (!env.ENTRA_TENANT_ID || !env.ENTRA_AUDIENCE) {
        throw new ConfigurationError(
          'AUTH_MODE=entra-jwt requires ENTRA_TENANT_ID and ENTRA_AUDIENCE',
        );
      }
      return {
        mode: 'entra-jwt',
        tenantId: env.ENTRA_TENANT_ID,
        audience: env.ENTRA_AUDIENCE,
        allowedAppIds: env.ENTRA_ALLOWED_APP_IDS,
      };
    }
  }
};

/**
 * Deployment is the highest-privilege capability this server has, so everything it needs is
 * checked at startup rather than discovered at the first attempt.
 */
const assertDeploymentConfiguration = (env: Env): void => {
  if (!env.DEPLOYMENTS_ENABLED) return;

  if (env.BICEP_CLI_PATH.length === 0) {
    throw new ConfigurationError('DEPLOYMENTS_ENABLED=true requires BICEP_CLI_PATH');
  }
  if (
    env.BICEP_REMOTE_MODULES_ENABLED &&
    env.BICEP_ALLOWED_REGISTRIES.length === 0 &&
    !env.BICEP_TEMPLATE_SPECS_ENABLED
  ) {
    throw new ConfigurationError(
      'BICEP_REMOTE_MODULES_ENABLED=true requires BICEP_ALLOWED_REGISTRIES or ' +
        'BICEP_TEMPLATE_SPECS_ENABLED',
    );
  }
  if (env.NODE_ENV !== 'production') return;

  if (!env.BICEP_CLI_SHA256) {
    throw new ConfigurationError(
      'BICEP_CLI_SHA256 is required in production so the compiler binary is pinned',
    );
  }
  if (!env.AZURE_DEPLOYMENT_CLIENT_ID) {
    throw new ConfigurationError(
      'AZURE_DEPLOYMENT_CLIENT_ID is required in production: deployments must use an identity ' +
        'separate from the read and operator identity',
    );
  }
  if (env.DEPLOYMENT_RECORD_STORE !== 'azure-table') {
    throw new ConfigurationError(
      'DEPLOYMENT_RECORD_STORE=azure-table is required in production; in-memory records are lost ' +
        'when the app scales to zero',
    );
  }
  if (!env.DEPLOYMENT_RECORD_TABLE_ENDPOINT) {
    throw new ConfigurationError(
      'DEPLOYMENT_RECORD_TABLE_ENDPOINT is required when DEPLOYMENT_RECORD_STORE=azure-table',
    );
  }
  if (
    env.AZURE_SUBSCRIPTION_IDS.length === 0 &&
    env.AZURE_ALLOWED_MANAGEMENT_GROUP_IDS.length === 0
  ) {
    throw new ConfigurationError(
      'Deployments in production require an explicit AZURE_SUBSCRIPTION_IDS or ' +
        'AZURE_ALLOWED_MANAGEMENT_GROUP_IDS allow-list',
    );
  }
};

export const buildConfig = (env: Env): AppConfig => {
  assertDeploymentConfiguration(env);

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    service: {
      name: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      gitSha: env.GIT_SHA,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
      maxBodyBytes: env.HTTP_MAX_BODY_BYTES,
      rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    },
    logLevel: env.LOG_LEVEL,
    auth: buildAuthConfig(env),
    azure: {
      tenantId: env.AZURE_TENANT_ID,
      clientId: env.AZURE_CLIENT_ID,
      deploymentClientId: env.AZURE_DEPLOYMENT_CLIENT_ID,
      armEndpoint: env.AZURE_ARM_ENDPOINT,
      allowedSubscriptionIds: env.AZURE_SUBSCRIPTION_IDS.map((id) => id.toLowerCase()),
      allowedResourceGroups: env.AZURE_ALLOWED_RESOURCE_GROUPS.map((name) => name.toLowerCase()),
      allowedManagementGroupIds: env.AZURE_ALLOWED_MANAGEMENT_GROUP_IDS.map((id) =>
        id.toLowerCase(),
      ),
      tenantDeploymentsEnabled: env.AZURE_TENANT_DEPLOYMENTS_ENABLED,
      verifyRbac: env.AZURE_VERIFY_RBAC,
      rbacCacheTtlMs: env.AZURE_RBAC_CACHE_TTL_MS,
    },
    guardrails: {
      mutationsEnabled: env.MUTATIONS_ENABLED,
      confirmationRequired: env.MUTATION_CONFIRMATION_REQUIRED,
    },
    mcp: { httpEnabled: env.MCP_HTTP_ENABLED },
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
      runAsUid: env.BICEP_RUN_AS_UID,
      runAsGid: env.BICEP_RUN_AS_GID,
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
        templateSpecsEnabled: env.BICEP_TEMPLATE_SPECS_ENABLED,
        allowedSubscriptionIds: env.AZURE_SUBSCRIPTION_IDS.map((id) => id.toLowerCase()),
      },
    },
  };
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid environment configuration: ${details}`);
  }
  return buildConfig(parsed.data);
};
