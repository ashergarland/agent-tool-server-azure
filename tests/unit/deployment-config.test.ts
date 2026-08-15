import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/index.js';

const root = new URL('../../', import.meta.url);
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

const mainBicep = read('infra/main.bicep');
const containerAppBicep = read('infra/modules/container-app.bicep');
const provisionSh = read('scripts/bootstrap/provision.sh');
const deploySh = read('scripts/bootstrap/deploy.sh');
const commonSh = read('scripts/lib/common.sh');

const parameterFiles = readdirSync(fileURLToPath(new URL('infra/parameters', root))).filter(
  (name) => name.endsWith('.parameters.json'),
);

const declaredParameters = new Set(
  [...mainBicep.matchAll(/^param\s+([A-Za-z0-9_]+)\s/gm)].map((match) => match[1] as string),
);

/** Environment variable names the container app actually sets. */
const containerAppEnvNames = [
  ...containerAppBicep.matchAll(/\{\s*name:\s*'([A-Z0-9_]+)'/g),
  ...containerAppBicep.matchAll(/name:\s*'([A-Z0-9_]+)'\s*$/gm),
].map((match) => match[1] as string);

describe('per-environment parameter files', () => {
  it('exist for every environment the scripts reference', () => {
    expect(parameterFiles).toContain('prod.parameters.json');
    expect(parameterFiles).toContain('dev.parameters.json');
  });

  it.each(parameterFiles)('%s only sets parameters main.bicep declares', (file) => {
    const parsed = JSON.parse(read(`infra/parameters/${file}`)) as {
      parameters: Record<string, { value: unknown }>;
    };
    for (const name of Object.keys(parsed.parameters)) {
      expect(declaredParameters, `${file} sets unknown parameter ${name}`).toContain(name);
    }
  });

  it.each(parameterFiles)('%s pins every setting a release could otherwise reset', (file) => {
    const parsed = JSON.parse(read(`infra/parameters/${file}`)) as {
      parameters: Record<string, { value: unknown }>;
    };
    // These are exactly the settings that a partially-specified redeployment used to silently
    // revert to a Bicep default.
    for (const required of [
      'environmentName',
      'allowedResourceGroups',
      'enableMutations',
      'mutationConfirmationRequired',
      'enableDeployments',
      'enableHealthAlerts',
      'minReplicas',
      'maxReplicas',
      'cpu',
      'memory',
      'logLevel',
      'tags',
    ]) {
      expect(Object.keys(parsed.parameters), `${file} is missing ${required}`).toContain(required);
    }
  });

  it.each(parameterFiles)('%s contains no account-specific identifier', (file) => {
    const contents = read(`infra/parameters/${file}`);
    expect(contents).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(contents).not.toMatch(/\.azurecr\.io|\.azurewebsites\.net|\.azurecontainerapps\.io/);
    expect(contents).not.toMatch(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('keeps deployments and mutations disabled by default in every environment', () => {
    for (const file of parameterFiles) {
      const parsed = JSON.parse(read(`infra/parameters/${file}`)) as {
        parameters: Record<string, { value: unknown }>;
      };
      expect(parsed.parameters['enableMutations']?.value, file).toBe(false);
      expect(parsed.parameters['enableDeployments']?.value, file).toBe(false);
      expect(parsed.parameters['tenantDeploymentsEnabled']?.value, file).toBe(false);
      expect(parsed.parameters['bicepRemoteModulesEnabled']?.value, file).toBe(false);
      expect(parsed.parameters['mutationConfirmationRequired']?.value, file).toBe(true);
    }
  });

  it('keeps scale-to-zero available', () => {
    for (const file of parameterFiles) {
      const parsed = JSON.parse(read(`infra/parameters/${file}`)) as {
        parameters: Record<string, { value: number }>;
      };
      expect(parsed.parameters['minReplicas']?.value, file).toBe(0);
    }
  });
});

describe('release scripts', () => {
  it('both provisioning and release consume the same authoritative parameter file', () => {
    for (const script of [provisionSh, deploySh]) {
      expect(script).toContain('parameter_file');
      expect(script).toContain('--parameters "@${PARAMETERS}"');
    }
  });

  it('the release only overrides values that are computed at release time', () => {
    const block = /RELEASE_ARGS=\(([\s\S]*?)\n\)/.exec(deploySh)?.[1] ?? '';
    expect(block).toContain('--parameters "@${PARAMETERS}"');
    const overrides = [...block.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)=/gm)].map(
      (match) => match[1] as string,
    );
    expect(new Set(overrides)).toEqual(
      new Set(['image', 'gitSha', 'serviceVersion', 'publicBaseUrl']),
    );
  });

  it('the release references an immutable digest rather than a floating tag', () => {
    expect(deploySh).toContain('--query digest --output tsv');
    expect(deploySh).toContain('IMAGE="${REGISTRY_SERVER}/${REPOSITORY}@${DIGEST}"');
    expect(deploySh).toContain('GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"');
  });

  it('validates, previews and confirms before changing anything', () => {
    expect(commonSh).toContain('az deployment sub validate');
    expect(commonSh).toContain('az deployment sub what-if');
    expect(commonSh).toMatch(/changeType == "Delete"/);
    expect(commonSh).toContain('Proceed with a deployment that deletes resources?');
    expect(deploySh).toContain('review_changes');
    expect(provisionSh).toContain('review_changes');
  });

  it('performs an account and tenant preflight before deploying', () => {
    expect(commonSh).toContain('az account show');
    expect(commonSh).toContain('Requested subscription');
    for (const script of [provisionSh, deploySh]) {
      expect(script).toContain('preflight "${SUBSCRIPTION_ID}" "${ENVIRONMENT}"');
    }
  });

  it('verifies health, readiness and the released revision after deploying', () => {
    expect(deploySh).toContain('/health');
    expect(deploySh).toContain('/ready');
    expect(deploySh).toContain('/version');
  });

  it('contains no account-specific identifier or hard-coded region', () => {
    for (const script of [provisionSh, deploySh, commonSh]) {
      expect(script).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(script).not.toMatch(/LOCATION="\$\{3:-[a-z]+\}"/);
    }
  });
});

describe('container app environment contract', () => {
  it('only sets variables the server understands', () => {
    const known = new Set(Object.keys(envSchema.shape));
    for (const name of containerAppEnvNames) {
      expect(known, `container-app.bicep sets unknown variable ${name}`).toContain(name);
    }
  });

  it('sets the guardrail variables explicitly rather than relying on server defaults', () => {
    for (const required of [
      'AUTH_MODE',
      'MUTATIONS_ENABLED',
      'MUTATION_CONFIRMATION_REQUIRED',
      'DEPLOYMENTS_ENABLED',
      'AZURE_SUBSCRIPTION_IDS',
      'AZURE_ALLOWED_RESOURCE_GROUPS',
      'BICEP_REMOTE_MODULES_ENABLED',
      'DEPLOYMENT_RECORD_STORE',
    ]) {
      expect(containerAppEnvNames).toContain(required);
    }
  });

  it('probes readiness separately from liveness', () => {
    expect(containerAppBicep).toMatch(/type: 'Readiness'[\s\S]{0,200}path: '\/ready'/);
    expect(containerAppBicep).toMatch(/type: 'Liveness'[\s\S]{0,200}path: '\/health'/);
  });

  it('never puts a secret value in an environment variable', () => {
    expect(containerAppBicep).toContain("secretRef: 'connector-api-key'");
    expect(containerAppBicep).not.toMatch(/API_KEYS'\s*,\s*value:/);
  });
});

describe('main template', () => {
  it('creates a deployment identity separate from the operator identity', () => {
    expect(mainBicep).toContain('module deploymentIdentity');
    expect(mainBicep).toContain('id-agent-tool-server-azure-deploy-');
  });

  it('grants reads through built-in roles and writes through custom roles only', () => {
    // Virtual Machine Contributor, Website Contributor and Tag Contributor ids must not reappear.
    for (const broadRole of [
      '9980e02c-c2be-4d73-94e8-173b1dc7cf3c',
      'de139f84-1756-47ae-9be6-808fbbe84772',
      '4a9ae827-6dc8-4573-8ac7-8239d42aa03f',
      // Owner and Contributor.
      '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
      'b24988ac-6180-42a0-ab88-20f7382dd24c',
    ]) {
      expect(mainBicep, `broad built-in role ${broadRole} must not be assigned`).not.toContain(
        broadRole,
      );
    }
    expect(mainBicep).toContain('customRoles.outputs.operatorRoleDefinitionId');
  });

  it('never grants the deployment identity permission to create arbitrary resources', () => {
    const customRoles = read('infra/modules/custom-roles.bicep');
    expect(customRoles).not.toMatch(/actions:\s*\[\s*'\*'/);
    expect(customRoles).toContain("'*/read'");
    expect(customRoles).toContain("'Microsoft.Resources/deployments/write'");
  });

  it('limits the operator role to the verbs the operations service actually issues', () => {
    const customRoles = read('infra/modules/custom-roles.bicep');
    for (const action of [
      'Microsoft.Compute/virtualMachines/restart/action',
      'Microsoft.Compute/virtualMachines/start/action',
      'Microsoft.Web/sites/restart/action',
      'Microsoft.Resources/tags/write',
    ]) {
      expect(customRoles).toContain(action);
    }
    expect(customRoles).not.toContain('Microsoft.Compute/virtualMachines/write');
    expect(customRoles).not.toContain('Microsoft.Compute/virtualMachines/delete');
  });
});

describe('container image', () => {
  const dockerfile = read('Dockerfile');

  it('runs as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile.lastIndexOf('USER node')).toBeLessThan(dockerfile.indexOf('CMD ['));
  });

  it('installs the Bicep compiler at build time and never at runtime', () => {
    expect(dockerfile).toContain('BICEP_VERSION');
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile).toContain('BICEP_CLI_PATH=/usr/local/bin/bicep');
  });

  it('keeps the compiler read-only and not owned by the runtime user', () => {
    expect(dockerfile).toContain('--chown=root:root /usr/local/bin/bicep');
    expect(dockerfile).toContain('chmod 0555 /usr/local/bin/bicep');
  });
});
