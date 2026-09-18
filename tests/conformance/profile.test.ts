import { readFile } from 'node:fs/promises';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { capability } from '../../src/capability.js';

interface Profile {
  readonly id: string;
  readonly dimensions: Record<string, string>;
  readonly configuration: {
    readonly schema: { readonly id: string; readonly capabilityId: string; readonly path: string };
    readonly bounded: boolean;
  };
  readonly requiredSecrets: readonly string[];
  readonly providerPrerequisites: readonly unknown[];
  readonly identity: { readonly rbac: readonly string[] };
  readonly delivery: {
    readonly provenance: { readonly method: string; readonly reference: string };
  };
  readonly workload?: unknown;
  readonly mutation?: {
    readonly enablement: string;
    readonly authorization: string;
    readonly confirmation: string;
    readonly durableRecord: string;
    readonly authoritativeVerification: string;
  };
  readonly verification: { readonly surfaces: readonly string[] };
}

interface Declaration {
  readonly contractVersion: number;
  readonly kind: string;
  readonly capability: {
    readonly id: string;
    readonly displayName: string;
    readonly repository: string;
  };
  readonly profiles: readonly Profile[];
}

const load = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

const BASE_CONFIGURATION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'api-key',
  MUTATIONS_ENABLED: 'false',
  MUTATION_CONFIRMATION_REQUIRED: 'true',
  DEPLOYMENTS_ENABLED: 'false',
  AZURE_VERIFY_RBAC: 'true',
} as const;

const addFormats = addFormatsImport.default;

const compileProfileSchema = async (path: string): Promise<ValidateFunction> => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema((await load('../../schemas/hosted-configuration.schema.json')) as AnySchemaObject);
  return ajv.compile((await load(`../../${path}`)) as AnySchemaObject);
};

describe('Azure capability profile truthfulness', () => {
  it('declares the account-neutral D4 identity and bounded configuration schema', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const server = (await load('../../server.json')) as {
      readonly name: string;
      readonly repository: { readonly url: string };
    };

    expect(declaration.contractVersion).toBe(1);
    expect(declaration.kind).toBe('capability-profile-declaration');
    expect(declaration.capability).toEqual({
      id: server.name,
      displayName: capability.manifest.title,
      repository: server.repository.url,
    });

    for (const profile of declaration.profiles) {
      expect(profile.configuration.bounded).toBe(true);
      expect(profile.configuration.schema.capabilityId).toBe(declaration.capability.id);
      const schema = (await load(`../../${profile.configuration.schema.path}`)) as {
        readonly $id: string;
        readonly unevaluatedProperties: boolean;
        readonly allOf: readonly [{ readonly $ref: string }];
      };
      expect(schema.$id).toBe(profile.configuration.schema.id);
      expect(schema.unevaluatedProperties).toBe(false);
      expect(schema.allOf[0].$ref).toBe(
        'urn:io:github.ashergarland:agent-tool-server-azure:hosted-configuration:v1',
      );
    }
  });

  it('declares read-only and mutating hosted provider profiles across all six dimensions', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const byId = new Map(declaration.profiles.map((profile) => [profile.id, profile]));
    const shared = {
      execution: 'hosted',
      delivery: 'container',
      access: 'authenticated-service',
      workload: 'provider',
      provider: 'external',
    };

    expect(byId.get('hosted-read-only')?.dimensions).toEqual({
      ...shared,
      mutation: 'read-only',
    });
    expect(byId.get('hosted-mutating')?.dimensions).toEqual({
      ...shared,
      mutation: 'mutating',
    });
    expect(capability.tools.some((tool) => tool.kind === 'read')).toBe(true);
    expect(capability.tools.some((tool) => tool.kind === 'write')).toBe(true);
  });

  it('states provider, identity, readiness, and mutation requirements explicitly', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    for (const profile of declaration.profiles) {
      expect(profile.requiredSecrets).toEqual(['connector-api-key']);
      expect(profile.providerPrerequisites.length).toBeGreaterThan(0);
      expect(profile.identity.rbac.length).toBeGreaterThan(0);
      expect(profile.delivery.provenance).toEqual({
        method: 'build-recipe',
        reference: 'Dockerfile',
      });
      expect(profile.workload).toBeDefined();
      expect(profile.verification.surfaces).toEqual(
        expect.arrayContaining(['identity', 'readiness', 'behavior', 'provider', 'provenance']),
      );
    }

    const mutating = declaration.profiles.find((profile) => profile.id === 'hosted-mutating');
    expect(mutating?.mutation).toMatchObject({
      enablement: 'separate',
      durableRecord: 'not-required',
    });
    expect(mutating?.mutation?.authorization).toContain('MUTATIONS_ENABLED');
    expect(mutating?.mutation?.confirmation).toContain('what-if confirmation hash');
    expect(mutating?.mutation?.authoritativeVerification).toContain('Azure deployment status');
    expect(
      declaration.profiles.find((profile) => profile.id === 'hosted-read-only'),
    ).not.toHaveProperty('mutation');
  });

  it('binds read-only and mutating profiles to their selected Platform mutation policy', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const byId = new Map(declaration.profiles.map((profile) => [profile.id, profile]));
    const readOnly = await compileProfileSchema(
      byId.get('hosted-read-only')?.configuration.schema.path ?? '',
    );
    const mutating = await compileProfileSchema(
      byId.get('hosted-mutating')?.configuration.schema.path ?? '',
    );

    expect(readOnly({ ...BASE_CONFIGURATION, MUTATIONS_ENABLED: 'False' })).toBe(true);
    expect(readOnly({ ...BASE_CONFIGURATION, TRUST_PROXY: 'OFF' })).toBe(true);
    expect(readOnly({ ...BASE_CONFIGURATION, TRUST_PROXY: 'true' })).toBe(false);
    expect(readOnly({ ...BASE_CONFIGURATION, TRUST_PROXY: 1 })).toBe(false);
    expect(readOnly({ ...BASE_CONFIGURATION, MUTATIONS_ENABLED: 'true' })).toBe(false);
    expect(readOnly({ ...BASE_CONFIGURATION, MUTATION_CONFIRMATION_REQUIRED: 'false' })).toBe(
      false,
    );
    expect(
      mutating({
        ...BASE_CONFIGURATION,
        MUTATIONS_ENABLED: 'TRUE',
        MUTATION_CONFIRMATION_REQUIRED: 'On',
      }),
    ).toBe(true);
    expect(mutating(BASE_CONFIGURATION)).toBe(false);
    expect(
      mutating({
        ...BASE_CONFIGURATION,
        MUTATIONS_ENABLED: 'true',
        MUTATION_CONFIRMATION_REQUIRED: 'no',
      }),
    ).toBe(false);
  });

  it('rejects schema-valid values that the runtime would reject at startup', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const profile = declaration.profiles.find(({ id }) => id === 'hosted-read-only');
    const validate = await compileProfileSchema(profile?.configuration.schema.path ?? '');

    expect(validate({ ...BASE_CONFIGURATION, BODY_LIMIT_BYTES: '1' })).toBe(false);
    expect(validate({ ...BASE_CONFIGURATION, BODY_LIMIT_BYTES: '64000' })).toBe(true);
    expect(validate({ ...BASE_CONFIGURATION, BODY_LIMIT_BYTES: 16_777_216 })).toBe(true);
    expect(validate({ ...BASE_CONFIGURATION, BODY_LIMIT_BYTES: '16777217' })).toBe(false);
    expect(validate({ ...BASE_CONFIGURATION, REQUEST_TIMEOUT_MS: '0' })).toBe(true);
    expect(validate({ ...BASE_CONFIGURATION, REQUEST_TIMEOUT_MS: '1' })).toBe(true);
    expect(validate({ ...BASE_CONFIGURATION, REQUEST_TIMEOUT_MS: '600000' })).toBe(true);
    expect(validate({ ...BASE_CONFIGURATION, BICEP_MAX_CONCURRENCY: '16' })).toBe(true);
    expect(validate({ ...BASE_CONFIGURATION, BICEP_MAX_CONCURRENCY: '999999' })).toBe(false);
  });

  it('keeps every numeric public bound inside the runtime limits for environment strings', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const profile = declaration.profiles.find(({ id }) => id === 'hosted-read-only');
    const validate = await compileProfileSchema(profile?.configuration.schema.path ?? '');
    const bounds = [
      ['PORT', 1, 65_535],
      ['BODY_LIMIT_BYTES', 64_000, 16_777_216],
      ['RATE_LIMIT_MAX', 0, 1_000_000],
      ['RATE_LIMIT_WINDOW_MS', 1_000, 86_400_000],
      ['PRE_AUTH_RATE_LIMIT_MAX', 0, 1_000_000],
      ['SHUTDOWN_GRACE_MS', 0, 120_000],
      ['REQUEST_TIMEOUT_MS', 0, 600_000],
      ['ENTRA_CLOCK_TOLERANCE_SECONDS', 0, 600],
      ['AZURE_ARM_REQUEST_TIMEOUT_MS', 1_000, 600_000],
      ['AZURE_MUTATION_TIMEOUT_MS', 10_000, 1_800_000],
      ['AZURE_RBAC_CACHE_TTL_MS', 0, 3_600_000],
      ['DEPLOYMENT_PREVIEW_TTL_MS', 60_000, 86_400_000],
      ['DEPLOYMENT_MAX_PREVIEW_CHANGES', 1, 2_000],
      ['DEPLOYMENT_MAX_PROPERTY_CHANGES', 1, 200],
      ['DEPLOYMENT_MAX_OPERATIONS', 1, 500],
      ['DEPLOYMENT_WHATIF_TIMEOUT_MS', 10_000, 900_000],
      ['DEPLOYMENT_POLL_INTERVAL_MS', 500, 60_000],
      ['DEPLOYMENT_MAX_CONCURRENT', 1, 16],
      ['DEPLOYMENT_LOCK_TTL_MS', 60_000, 3_600_000],
      ['BICEP_COMPILE_TIMEOUT_MS', 5_000, 600_000],
      ['BICEP_MAX_OUTPUT_BYTES', 65_536, 16_777_216],
      ['BICEP_MAX_CONCURRENCY', 1, 16],
      ['BICEP_MAX_FILES', 1, 512],
      ['BICEP_MAX_FILE_BYTES', 1_024, 4_194_304],
      ['BICEP_MAX_TOTAL_BYTES', 1_024, 8_388_608],
      ['BICEP_MAX_PATH_LENGTH', 16, 1_024],
      ['BICEP_MAX_PATH_DEPTH', 1, 32],
      ['BICEP_MAX_TEMPLATE_RESOURCES', 1, 5_000],
      ['BICEP_MAX_TEMPLATE_BYTES', 1_024, 8_388_608],
      ['BICEP_MAX_NESTED_DEPLOYMENTS', 0, 256],
    ] as const;

    for (const [field, minimum, maximum] of bounds) {
      expect(
        validate({ ...BASE_CONFIGURATION, [field]: String(minimum) }),
        `${field} minimum`,
      ).toBe(true);
      expect(
        validate({ ...BASE_CONFIGURATION, [field]: String(maximum) }),
        `${field} maximum`,
      ).toBe(true);
      expect(
        validate({ ...BASE_CONFIGURATION, [field]: String(minimum - 1) }),
        `${field} below minimum`,
      ).toBe(false);
      expect(
        validate({ ...BASE_CONFIGURATION, [field]: String(maximum + 1) }),
        `${field} above maximum`,
      ).toBe(false);
    }
  });

  it('mirrors hosted authentication, deployment, and remote-module startup invariants', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const profile = declaration.profiles.find(({ id }) => id === 'hosted-read-only');
    const validate = await compileProfileSchema(profile?.configuration.schema.path ?? '');

    expect(validate({ ...BASE_CONFIGURATION, AUTH_MODE: 'entra-jwt' })).toBe(false);
    expect(
      validate({
        ...BASE_CONFIGURATION,
        AUTH_MODE: 'entra-jwt',
        ENTRA_TENANT_ID: 'tenant',
        ENTRA_AUDIENCE: 'audience',
      }),
    ).toBe(false);

    expect(validate({ ...BASE_CONFIGURATION, DEPLOYMENTS_ENABLED: 'true' })).toBe(false);
    const deployment = {
      ...BASE_CONFIGURATION,
      DEPLOYMENTS_ENABLED: 'true',
      BICEP_CLI_PATH: '/usr/local/bin/bicep',
      BICEP_CLI_SHA256: 'a'.repeat(64),
      AZURE_CLIENT_ID: 'operator-client',
      AZURE_DEPLOYMENT_CLIENT_ID: 'deployment-client',
      AZURE_SUBSCRIPTION_IDS: '11111111-1111-1111-1111-111111111111',
      DEPLOYMENT_RECORD_STORE: 'azure-table',
      DEPLOYMENT_RECORD_TABLE_ENDPOINT: 'https://example.table.core.windows.net',
    };
    expect(validate(deployment)).toBe(true);
    expect(validate({ ...deployment, REQUEST_TIMEOUT_MS: '30000' })).toBe(false);
    const { AZURE_CLIENT_ID: _operatorClientId, ...withoutOperatorIdentity } = deployment;
    expect(validate(withoutOperatorIdentity)).toBe(false);
    expect(validate({ ...deployment, DEPLOYMENT_RECORD_STORE: 'memory' })).toBe(false);
    expect(validate({ ...deployment, BICEP_REMOTE_MODULES_ENABLED: 'true' })).toBe(false);
    expect(
      validate({
        ...deployment,
        BICEP_REMOTE_MODULES_ENABLED: 'true',
        BICEP_ALLOWED_REGISTRIES: 'contoso.azurecr.io',
      }),
    ).toBe(true);
    expect(validate({ ...deployment, BICEP_TEMPLATE_SPECS_ENABLED: 'YES' })).toBe(false);
  });

  it('contains no operator deployment instance, secret value, or account identifier', async () => {
    const declaration = await load('../../capability-profiles.json');
    const serialized = JSON.stringify(declaration);

    expect(serialized).not.toContain('secretValue');
    expect(serialized).not.toContain('deployment-instance');
    expect(serialized).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    );
    expect(serialized).not.toMatch(/\/subscriptions\/[^" ]+/iu);
  });
});
