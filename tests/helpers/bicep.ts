import type {
  BicepCompiler,
  BicepCompileRequest,
  BicepCompileResult,
  BicepCompilerInfo,
} from '../../src/bicep/index.js';
import type {
  ProcessRunRequest,
  ProcessRunner,
  ProcessRunResult,
} from '../../src/bicep/process.js';

export const RG_TEMPLATE = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    name: { type: 'string' },
    adminPassword: { type: 'securestring' },
  },
  resources: [
    {
      type: 'Microsoft.Storage/storageAccounts',
      apiVersion: '2023-05-01',
      name: "[parameters('name')]",
      location: 'westeurope',
      sku: { name: 'Standard_LRS' },
      kind: 'StorageV2',
    },
  ],
  outputs: {
    accountId: { type: 'string', value: 'id' },
    primaryKey: { type: 'securestring', value: 'secret' },
  },
} satisfies Record<string, unknown>;

export const SUBSCRIPTION_TEMPLATE = {
  $schema:
    'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  resources: [
    {
      type: 'Microsoft.Resources/resourceGroups',
      apiVersion: '2024-03-01',
      name: 'rg-example',
      location: 'westeurope',
    },
  ],
} satisfies Record<string, unknown>;

export const simpleBundle = (main = 'param name string\n') => ({
  mainFile: 'main.bicep',
  files: [{ path: 'main.bicep', content: main }],
});

export interface FakeCompiler extends BicepCompiler {
  readonly requests: BicepCompileRequest[];
  result: BicepCompileResult;
  info: BicepCompilerInfo;
}

/**
 * Compiler double. Every deployment test runs against this: no Bicep binary, no child process and
 * no network are involved anywhere in the suite.
 */
export const createFakeCompiler = (
  template: Record<string, unknown> | undefined = RG_TEMPLATE,
): FakeCompiler => {
  const requests: BicepCompileRequest[] = [];
  const fake: FakeCompiler = {
    requests,
    result: {
      template,
      diagnostics: [],
      durationMs: 5,
      truncatedOutput: false,
    },
    info: { available: true, version: '0.30.0', checksumVerified: true, detail: undefined },
    compile(request) {
      requests.push(request);
      return Promise.resolve(fake.result);
    },
    describe() {
      return Promise.resolve(fake.info);
    },
  };
  return fake;
};

export interface ScriptedProcessRunner extends ProcessRunner {
  readonly requests: ProcessRunRequest[];
  respond(handler: (request: ProcessRunRequest) => ProcessRunResult): void;
}

export const createProcessRunner = (
  initial: (request: ProcessRunRequest) => ProcessRunResult,
): ScriptedProcessRunner => {
  const requests: ProcessRunRequest[] = [];
  let handler = initial;
  return {
    requests,
    respond(next) {
      handler = next;
    },
    run(request) {
      requests.push(request);
      return Promise.resolve(handler(request));
    },
  };
};

export const processResult = (overrides: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
  durationMs: 1,
  ...overrides,
});
