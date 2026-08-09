import { describe, expect, it } from 'vitest';
import { ConfigurationError, buildConfig, envSchema, loadConfig } from '../../src/config/index.js';

const baseEnv = {
  NODE_ENV: 'test',
  AUTH_MODE: 'disabled',
};

describe('config', () => {
  it('applies defaults', () => {
    const config = buildConfig(envSchema.parse(baseEnv));
    expect(config.http.port).toBe(8080);
    expect(config.guardrails.mutationsEnabled).toBe(false);
    expect(config.guardrails.confirmationRequired).toBe(true);
    expect(config.auth.mode).toBe('disabled');
  });

  it('parses comma separated allow-lists and lowercases them', () => {
    const config = buildConfig(
      envSchema.parse({
        ...baseEnv,
        AZURE_SUBSCRIPTION_IDS: 'AAA, bbb ,,ccc',
        AZURE_ALLOWED_RESOURCE_GROUPS: 'RG-Prod',
      }),
    );
    expect(config.azure.allowedSubscriptionIds).toEqual(['aaa', 'bbb', 'ccc']);
    expect(config.azure.allowedResourceGroups).toEqual(['rg-prod']);
  });

  it('coerces boolean-ish mutation flags', () => {
    const config = buildConfig(
      envSchema.parse({
        ...baseEnv,
        MUTATIONS_ENABLED: 'true',
        MUTATION_CONFIRMATION_REQUIRED: '0',
      }),
    );
    expect(config.guardrails.mutationsEnabled).toBe(true);
    expect(config.guardrails.confirmationRequired).toBe(false);
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
    const config = buildConfig(envSchema.parse({ ...baseEnv, MUTATIONS_ENABLED: input }));
    expect(config.guardrails.mutationsEnabled).toBe(expected);
  });

  it('rejects a boolean flag that is not boolean-ish', () => {
    expect(() => envSchema.parse({ ...baseEnv, MUTATIONS_ENABLED: 'maybe' })).toThrow();
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
      API_KEYS: '0123456789abcdef0123456789abcdef0123456789abcdef',
      AZURE_CLIENT_ID: '4c9809f5-7445-4422-8c48-c5cc90c7056d',
      AZURE_SUBSCRIPTION_IDS: '00000000-0000-0000-0000-000000000001',
      AZURE_ALLOWED_RESOURCE_GROUPS: '',
      MUTATIONS_ENABLED: 'False',
      MUTATION_CONFIRMATION_REQUIRED: 'True',
    });
    expect(config.guardrails.mutationsEnabled).toBe(false);
    expect(config.guardrails.confirmationRequired).toBe(true);
    expect(config.azure.allowedResourceGroups).toEqual([]);
    expect(config.azure.allowedSubscriptionIds).toEqual(['00000000-0000-0000-0000-000000000001']);
  });

  it('rejects disabled auth in production', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })),
    ).toThrow(ConfigurationError);
  });

  it('requires api keys when auth mode is api-key', () => {
    expect(() => buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key' }))).toThrow(
      /requires at least one value in API_KEYS/,
    );
  });

  it('rejects short api keys', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })),
    ).toThrow(/at least 32 characters/);
  });

  it('requires tenant and audience for entra-jwt', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'entra-jwt' })),
    ).toThrow(/ENTRA_TENANT_ID and ENTRA_AUDIENCE/);
  });

  it('reports invalid environment values with the offending path', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled', PORT: 'not-a-port' }),
    ).toThrow(/PORT/);
  });
});
