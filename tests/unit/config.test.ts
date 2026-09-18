import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@agent-tool-platform/runtime/config';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import { loadConfig } from '../../src/config/index.js';

const baseEnv = {
  NODE_ENV: 'test',
  AUTH_MODE: 'disabled',
};

describe('config', () => {
  it('applies defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.http.port).toBe(8080);
    expect(config.http.requestTimeoutMs).toBe(0);
    expect(config.azure.armRequestTimeoutMs).toBe(30_000);
    expect(config.azure.mutationTimeoutMs).toBe(600_000);
    expect(config.mutations.enabled).toBe(false);
    expect(config.mutations.confirmationRequired).toBe(true);
    expect(config.auth.mode).toBe('disabled');
  });

  it('parses comma separated allow-lists and lowercases them', () => {
    const config = loadConfig({
      ...baseEnv,
      AZURE_SUBSCRIPTION_IDS: 'AAA, bbb ,,ccc',
      AZURE_ALLOWED_RESOURCE_GROUPS: 'RG-Prod',
    });
    expect(config.azure.allowedSubscriptionIds).toEqual(['aaa', 'bbb', 'ccc']);
    expect(config.azure.allowedResourceGroups).toEqual(['rg-prod']);
  });

  it('coerces boolean-ish mutation flags', () => {
    const config = loadConfig({
      ...baseEnv,
      MUTATIONS_ENABLED: 'true',
      MUTATION_CONFIRMATION_REQUIRED: '0',
    });
    expect(config.mutations.enabled).toBe(true);
    expect(config.mutations.confirmationRequired).toBe(false);
  });

  // Bicep's string(bool) emits "True"/"False", which previously failed startup validation and
  // left the Container App unable to boot.
  it.each([
    ['True', true],
    ['False', false],
    ['TRUE', true],
    [' true ', true],
    ['Yes', true],
    ['No', false],
    ['On', true],
    ['Off', false],
  ])('accepts %s as a boolean flag regardless of casing or padding', (input, expected) => {
    const config = loadConfig({ ...baseEnv, MUTATIONS_ENABLED: input });
    expect(config.mutations.enabled).toBe(expected);
  });

  it('rejects a boolean flag that is not boolean-ish', () => {
    expect(() => loadConfig({ ...baseEnv, MUTATIONS_ENABLED: 'maybe' })).toThrow(
      ConfigurationError,
    );
  });

  // The Container App template used to declare PUBLIC_BASE_URL unconditionally, and the
  // deployment that first creates the ingress has no hostname to supply. An empty string reached
  // z.url() and the container exited at startup.
  it('treats a blank optional variable as unset rather than invalid', () => {
    const config = loadConfig({ ...baseEnv, PUBLIC_BASE_URL: '' });
    expect(config.service.publicBaseUrl).toBeUndefined();
  });

  it('still rejects a non-empty but malformed optional variable', () => {
    expect(() => loadConfig({ ...baseEnv, PUBLIC_BASE_URL: 'not-a-url' })).toThrow(
      ConfigurationError,
    );
  });

  it('loads the exact environment the Container App template produces', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'info',
      SERVICE_NAME: 'ca-agent-tool-server-prod',
      AUTH_MODE: 'api-key',
      API_KEYS: generateTestApiKey(),
      AZURE_CLIENT_ID: '4c9809f5-7445-4422-8c48-c5cc90c7056d',
      AZURE_SUBSCRIPTION_IDS: '00000000-0000-0000-0000-000000000001',
      AZURE_ALLOWED_RESOURCE_GROUPS: '',
      MUTATIONS_ENABLED: 'False',
      MUTATION_CONFIRMATION_REQUIRED: 'True',
    });
    expect(config.mutations.enabled).toBe(false);
    expect(config.mutations.confirmationRequired).toBe(true);
    expect(config.azure.allowedResourceGroups).toEqual([]);
    expect(config.azure.allowedSubscriptionIds).toEqual(['00000000-0000-0000-0000-000000000001']);
  });

  it('rejects disabled auth in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })).toThrow(
      ConfigurationError,
    );
  });

  it('requires api keys when auth mode is api-key', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'api-key' })).toThrow(
      /requires API_KEYS/,
    );
  });

  it('rejects short api keys', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })).toThrow(
      /randomly generated high-entropy value|at least 32 characters/,
    );
  });

  it('requires tenant and audience for entra-jwt', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'entra-jwt' })).toThrow(
      /requires ENTRA_TENANT_ID/,
    );
  });

  it('reports invalid environment values with the offending path', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled', PORT: 'not-a-port' }),
    ).toThrow(/PORT/);
  });

  it('requires distinct explicit operator and deployment identities for production deployments', () => {
    const deploymentEnv = {
      NODE_ENV: 'production',
      AUTH_MODE: 'api-key',
      API_KEYS: generateTestApiKey(),
      DEPLOYMENTS_ENABLED: 'true',
      BICEP_CLI_PATH: '/opt/bicep/bicep',
      BICEP_CLI_SHA256: 'a'.repeat(64),
      AZURE_CLIENT_ID: 'operator-client',
      AZURE_DEPLOYMENT_CLIENT_ID: 'deployment-client',
      AZURE_SUBSCRIPTION_IDS: '11111111-1111-1111-1111-111111111111',
      DEPLOYMENT_RECORD_STORE: 'azure-table',
      DEPLOYMENT_RECORD_TABLE_ENDPOINT: 'https://records.table.core.windows.net',
    };

    expect(loadConfig(deploymentEnv).azure).toMatchObject({
      clientId: 'operator-client',
      deploymentClientId: 'deployment-client',
    });
    expect(() => loadConfig({ ...deploymentEnv, AZURE_CLIENT_ID: undefined })).toThrow(
      /AZURE_CLIENT_ID is required/,
    );
    expect(() =>
      loadConfig({
        ...deploymentEnv,
        AZURE_CLIENT_ID: 'SAME-CLIENT',
        AZURE_DEPLOYMENT_CLIENT_ID: 'same-client',
      }),
    ).toThrow(/must identify different managed identities/);
  });

  it('keeps the generic Platform deadline disabled when Bicep deployments are enabled', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        DEPLOYMENTS_ENABLED: 'true',
        BICEP_CLI_PATH: '/opt/bicep/bicep',
        REQUEST_TIMEOUT_MS: '30000',
      }),
    ).toThrow(/requires REQUEST_TIMEOUT_MS=0/);
  });

  it('bounds the Azure ARM transport independently of the generic tool deadline', () => {
    expect(
      loadConfig({ ...baseEnv, REQUEST_TIMEOUT_MS: '0', AZURE_ARM_REQUEST_TIMEOUT_MS: '45000' })
        .azure.armRequestTimeoutMs,
    ).toBe(45_000);
    expect(() => loadConfig({ ...baseEnv, AZURE_ARM_REQUEST_TIMEOUT_MS: '0' })).toThrow(
      /AZURE_ARM_REQUEST_TIMEOUT_MS/,
    );
  });

  it('bounds the admitted mutation lifecycle independently of each ARM request', () => {
    expect(
      loadConfig({ ...baseEnv, AZURE_MUTATION_TIMEOUT_MS: '900000' }).azure.mutationTimeoutMs,
    ).toBe(900_000);
    expect(() => loadConfig({ ...baseEnv, AZURE_MUTATION_TIMEOUT_MS: '0' })).toThrow(
      /AZURE_MUTATION_TIMEOUT_MS/,
    );
  });

  it('keeps the distributed scope lock valid for the whole ARM submission timeout', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        DEPLOYMENTS_ENABLED: 'true',
        BICEP_CLI_PATH: '/opt/bicep/bicep',
        DEPLOYMENT_RECORD_STORE: 'azure-table',
        DEPLOYMENT_RECORD_TABLE_ENDPOINT: 'https://records.table.core.windows.net',
        DEPLOYMENT_LOCK_TTL_MS: '60000',
        AZURE_ARM_REQUEST_TIMEOUT_MS: '60000',
      }),
    ).toThrow(/DEPLOYMENT_LOCK_TTL_MS must exceed four AZURE_ARM_REQUEST_TIMEOUT_MS intervals/);
  });
});
