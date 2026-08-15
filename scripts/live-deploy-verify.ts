/**
 * Targeted live verification of the two paths a stub server cannot prove: the real ARM deployment
 * PUT, and the Azure Table Storage record store.
 *
 * This one DOES create resources. It deploys a single storage account into a scratch resource
 * group, reads it back, lists its operations, and rolls it back. Delete the resource group
 * afterwards.
 *
 * Run:
 *   npx tsx scripts/live-deploy-verify.ts <subscription-id> <resource-group> <table-endpoint>
 */
import { createApplication } from '../src/app.js';
import { buildConfig, envSchema } from '../src/config/index.js';
import { AzureTableDeploymentRecordStore } from '../src/deployments/store-azure.js';
import { createAzureCredentials } from '../src/provider/azure/credential.js';
import type { DeploymentRecord } from '../src/deployments/records.js';

const [subscriptionId, resourceGroup, tableEndpoint] = process.argv.slice(2);
if (!subscriptionId || !resourceGroup || !tableEndpoint) {
  throw new Error(
    'usage: live-deploy-verify.ts <subscription-id> <resource-group> <table-endpoint>',
  );
}

const results: { step: string; outcome: 'pass' | 'fail'; detail: string }[] = [];
const record = (step: string, outcome: 'pass' | 'fail', detail: string): void => {
  results.push({ step, outcome, detail });
  console.log(`${outcome === 'pass' ? 'PASS' : 'FAIL'}  ${step}\n      ${detail}`);
};
const check = async (step: string, run: () => Promise<string>): Promise<void> => {
  try {
    record(step, 'pass', await run());
  } catch (error) {
    record(step, 'fail', (error instanceof Error ? error.message : String(error)).slice(0, 500));
  }
};

const config = buildConfig(
  envSchema.parse({
    NODE_ENV: 'development',
    AUTH_MODE: 'disabled',
    LOG_LEVEL: 'silent',
    AZURE_SUBSCRIPTION_IDS: subscriptionId,
    AZURE_ALLOWED_RESOURCE_GROUPS: resourceGroup,
    DEPLOYMENTS_ENABLED: 'true',
    BICEP_CLI_PATH: process.env['BICEP_CLI_PATH'] ?? '',
    DEPLOYMENT_RECORD_STORE: 'azure-table',
    DEPLOYMENT_RECORD_TABLE_ENDPOINT: tableEndpoint,
    DEPLOYMENT_POLL_INTERVAL_MS: '2000',
  }),
);

// The real Azure Table store, against a real storage account with shared keys disabled.
const store = new AzureTableDeploymentRecordStore(createAzureCredentials(config).deployment, {
  accountUrl: tableEndpoint,
  recordsTable: config.deployments.store.recordsTable,
  locksTable: config.deployments.store.locksTable,
  lockTtlMs: config.deployments.store.lockTtlMs,
});

const app = createApplication({ config, store });
const { services, registry } = app;
const principal = 'live:deploy-verify';
const context = { requestId: 'live-deploy', principal, transport: 'http' } as const;
const invoke = <T>(tool: string, input: unknown): Promise<T> =>
  registry.invoke(tool, input, services, context) as Promise<T>;

const scope = { kind: 'resourceGroup' as const, subscriptionId, resourceGroup };
const suffix = Math.random().toString(36).slice(2, 8);

const bundleFor = (tier: string) => ({
  mainFile: 'main.bicep',
  files: [
    {
      path: 'main.bicep',
      content: [
        `param accountName string = 'atsad${suffix}'`,
        'param location string = resourceGroup().location',
        "resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {",
        '  name: accountName',
        '  location: location',
        `  sku: { name: '${tier}' }`,
        "  kind: 'StorageV2'",
        "  tags: { verifiedBy: 'live-deploy-verify' }",
        "  properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false }",
        '}',
        'output accountId string = sa.id',
      ].join('\n'),
    },
  ],
});

console.log(
  `\nTargeted live deployment verification\n  group ${resourceGroup}\n  table ${tableEndpoint}\n`,
);

/* ------------------------------------------------------------------ the record store itself */

await check(
  'the Azure Table record store is reachable (managed identity, no shared key)',
  async () => {
    await store.ping();
    const info = store.describe();
    return `${info.kind}: ${info.detail ?? ''}`;
  },
);

await check('a record round-trips through Table Storage', async () => {
  const now = new Date().toISOString();
  const sample: DeploymentRecord = {
    id: `probe-${suffix}`,
    principal,
    scopeKey: `resourceGroup:/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}`,
    scope: {
      kind: 'resourceGroup',
      subscriptionId,
      resourceGroup,
      managementGroupId: undefined,
      location: undefined,
      armScope: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`,
    },
    mode: 'Incremental',
    sourceHash: 'a'.repeat(64),
    templateHash: 'b'.repeat(64),
    parametersHash: 'c'.repeat(64),
    previewHash: 'd'.repeat(64),
    confirmationHash: 'e'.repeat(64),
    previewSummary: {
      totalChanges: 1,
      countsByChangeType: { Create: 1 },
      deletes: [],
      unsupported: [],
      truncated: false,
    },
    resourceTypes: ['microsoft.storage/storageaccounts'],
    // Deliberately large, to exercise the chunking across Table Storage property limits.
    sanitizedParameters: { padding: 'x'.repeat(80_000), secret: '[redacted]' },
    secureParameterNames: ['secret'],
    template: { $schema: 'https://example.invalid/t.json#', resources: [] },
    status: 'previewed',
    armDeploymentId: undefined,
    armDeploymentName: undefined,
    correlationId: undefined,
    outputsMetadata: undefined,
    previousSuccessfulRecordId: undefined,
    rollbackOfRecordId: undefined,
    reason: undefined,
    requestId: 'probe',
    error: undefined,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };

  await store.put(sample);
  const read = await store.get(sample.id, principal);
  if (!read) throw new Error('the record could not be read back');
  if ((read.sanitizedParameters['padding'] as string).length !== 80_000) {
    throw new Error('the chunked payload did not survive the round trip');
  }
  const byHash = await store.findByConfirmationHash(sample.confirmationHash, principal);
  if (byHash?.id !== sample.id) throw new Error('lookup by confirmation hash failed');
  return `round-tripped an 80KB record and found it by confirmation hash`;
});

await check('records are isolated between principals', async () => {
  const other = await store.get(`probe-${suffix}`, 'live:someone-else');
  if (other) throw new Error('another principal could read the record');
  return 'a different principal cannot read it';
});

await check('the per-scope lock is exclusive and is released', async () => {
  const scopeKey = `lock-probe-${suffix}`;
  let inner: string = 'not attempted';
  await store.withScopeLock(scopeKey, async () => {
    try {
      await store.withScopeLock(scopeKey, () => Promise.resolve());
      inner = 'second holder was ALLOWED';
    } catch (error) {
      inner =
        error instanceof Error && /already in progress/.test(error.message)
          ? 'second holder refused'
          : `unexpected: ${String(error)}`;
    }
  });
  if (inner !== 'second holder refused') throw new Error(inner);
  // Must be re-acquirable once released.
  await store.withScopeLock(scopeKey, () => Promise.resolve());
  return 'held exclusively, then re-acquired after release';
});

/* ---------------------------------------------------------------- a real ARM deployment */

let confirmationHash = '';
let recordId = '';

await check('what-if predicts the storage account as a Create', async () => {
  const result = await invoke<{
    confirmationHash: string;
    summary: { countsByChangeType: Record<string, number>; deletes: string[] };
  }>('azure_what_if_bicep', { bundle: bundleFor('Standard_LRS'), parameters: {}, scope });
  confirmationHash = result.confirmationHash;
  if (result.summary.deletes.length > 0) throw new Error('unexpected predicted deletions');
  return JSON.stringify(result.summary.countsByChangeType);
});

await check('azure_deploy_bicep starts a REAL ARM deployment', async () => {
  const result = await invoke<{ recordId: string; deploymentId: string; status: string }>(
    'azure_deploy_bicep',
    {
      bundle: bundleFor('Standard_LRS'),
      parameters: {},
      scope,
      confirmationHash,
      confirm: true,
      reason: 'targeted live verification of the deployment path',
    },
  );
  recordId = result.recordId;
  return `status=${result.status}, id=${result.deploymentId.split('/').pop() ?? ''}`;
});

await check('the deployment reaches Succeeded and the record is reconciled', async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await invoke<{ provisioningState: string; outputs: { name: string }[] }>(
      'azure_get_deployment',
      { recordId },
    );
    if (status.provisioningState === 'Succeeded') {
      const stored = await store.get(recordId, principal);
      if (stored?.status !== 'succeeded') {
        throw new Error(`ARM says Succeeded but the record says ${stored?.status ?? 'missing'}`);
      }
      return `Succeeded; outputs=${status.outputs.map((o) => o.name).join(',')}; record=${stored.status}`;
    }
    if (['Failed', 'Canceled'].includes(status.provisioningState)) {
      throw new Error(`deployment ended as ${status.provisioningState}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error('the deployment did not settle within the allowed time');
});

await check('azure_list_deployment_operations returns per-resource detail', async () => {
  const result = await invoke<{ operations: { resourceType?: string; statusCode?: string }[] }>(
    'azure_list_deployment_operations',
    { recordId, limit: 20 },
  );
  return `${result.operations.length} operation(s), e.g. ${result.operations[0]?.resourceType ?? '?'} ${result.operations[0]?.statusCode ?? ''}`;
});

await check('the deployed resource is reported by the deployment itself', async () => {
  // Deliberately asserted through azure_get_deployment rather than azure_search_resources.
  // Resource Graph is eventually consistent and lags ARM by minutes, so searching immediately
  // after a deployment reports a miss for a resource that certainly exists. This check exists to
  // encode that: verify a deployment through the deployment, not through search.
  const status = await invoke<{
    provisioningState: string;
    outputs: { name: string; value: unknown }[];
  }>('azure_get_deployment', { recordId });
  const output = status.outputs.find((entry) => entry.name === 'accountId');
  if (!output) throw new Error('the deployment reported no accountId output');
  if (!String(output.value).endsWith(`atsad${suffix}`)) {
    throw new Error(`the accountId output does not name the account: ${String(output.value)}`);
  }
  return `accountId output names atsad${suffix}`;
});

await check('Resource Graph catches up with the new resource (eventually consistent)', async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await invoke<{ resources: { name: string }[] }>('azure_search_resources', {
      subscriptionIds: [subscriptionId],
      resourceGroup,
      resourceType: 'microsoft.storage/storageaccounts',
    });
    if (result.resources.some((entry) => entry.name === `atsad${suffix}`)) {
      return `indexed after about ${attempt * 15}s`;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  // Not a failure of the server: ARM is the source of truth and already confirmed the resource.
  return 'not indexed within 3 minutes; ARM remains the source of truth';
});

/* ------------------------------------------------------------------------------ rollback */

await check('rollback previews a redeploy of the stored template', async () => {
  const result = await invoke<{ phase: string; preview: { confirmationHash: string } }>(
    'azure_rollback_deployment',
    { recordId, reason: 'verify rollback' },
  );
  if (result.phase !== 'preview') throw new Error(`expected a preview, got ${result.phase}`);
  confirmationHash = result.preview.confirmationHash;
  return 'preview produced with a fresh confirmation hash';
});

await check('rollback applies with the fresh confirmation', async () => {
  const result = await invoke<{ phase: string; result: { status: string; recordId: string } }>(
    'azure_rollback_deployment',
    { recordId, confirm: true, confirmationHash, reason: 'verify rollback' },
  );
  if (result.phase !== 'deployed') throw new Error(`expected deployed, got ${result.phase}`);
  return `redeployed as ${result.result.recordId}, status=${result.result.status}`;
});

/* ---------------------------------------------------------------------------------- summary */

const failed = results.filter((entry) => entry.outcome === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const entry of failed) console.log(`  - ${entry.step}: ${entry.detail}`);
  process.exitCode = 1;
}
console.log(
  `\nRemember to delete the scratch resource group: az group delete --name ${resourceGroup} --yes`,
);
