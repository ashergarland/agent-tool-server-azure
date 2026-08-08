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
