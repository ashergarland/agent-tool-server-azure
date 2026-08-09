import { z } from 'zod';

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
 * Environment contract for the connector. Everything the process needs is declared here so that
 * a misconfigured deployment fails fast at startup instead of at the first Azure call.
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
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  // Authentication of the *caller* (ChatGPT).
  AUTH_MODE: z.enum(['api-key', 'entra-jwt', 'disabled']).default('api-key'),
  API_KEYS: csvList.default([]),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_AUDIENCE: z.string().optional(),
  ENTRA_ALLOWED_APP_IDS: csvList.default([]),

  // Authentication *to* Azure.
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_SUBSCRIPTION_IDS: csvList.default([]),
  AZURE_ALLOWED_RESOURCE_GROUPS: csvList.default([]),
  AZURE_ARM_ENDPOINT: z.url().default('https://management.azure.com'),

  // Guardrails for state-changing tools.
  MUTATIONS_ENABLED: booleanish.default(false),
  MUTATION_CONFIRMATION_REQUIRED: booleanish.default(true),
});

export type Env = z.infer<typeof envSchema>;

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
    readonly armEndpoint: string;
    readonly allowedSubscriptionIds: readonly string[];
    readonly allowedResourceGroups: readonly string[];
  };
  readonly guardrails: {
    readonly mutationsEnabled: boolean;
    readonly confirmationRequired: boolean;
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

export const buildConfig = (env: Env): AppConfig => ({
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
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
  },
  logLevel: env.LOG_LEVEL,
  auth: buildAuthConfig(env),
  azure: {
    tenantId: env.AZURE_TENANT_ID,
    clientId: env.AZURE_CLIENT_ID,
    armEndpoint: env.AZURE_ARM_ENDPOINT,
    allowedSubscriptionIds: env.AZURE_SUBSCRIPTION_IDS.map((id) => id.toLowerCase()),
    allowedResourceGroups: env.AZURE_ALLOWED_RESOURCE_GROUPS.map((name) => name.toLowerCase()),
  },
  guardrails: {
    mutationsEnabled: env.MUTATIONS_ENABLED,
    confirmationRequired: env.MUTATION_CONFIRMATION_REQUIRED,
  },
});

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
