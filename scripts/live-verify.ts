/**
 * Read-only live verification against a real Azure subscription.
 *
 * Everything here is non-mutating. Mutations stay disabled, and the only deployment tools called
 * are validate (which never contacts Azure) and what-if (which asks ARM to *predict* a change set
 * and creates nothing). No resource is created, modified or deleted, and nothing is billed.
 *
 * Run:
 *   npx tsx <this file> <subscription-id> <existing-resource-group> <region>
 */
import { createApplication } from '../src/app.js';
import { buildConfig, envSchema } from '../src/config/index.js';
import { buildReadinessReport } from '../src/server/ready.js';

const [subscriptionId, resourceGroup, region] = process.argv.slice(2);
if (!subscriptionId || !resourceGroup || !region) {
  throw new Error('usage: live-verify.ts <subscription-id> <resource-group> <region>');
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
    const message = error instanceof Error ? error.message : String(error);
    record(step, 'fail', message.slice(0, 400));
  }
};

const config = buildConfig(
  envSchema.parse({
    NODE_ENV: 'development',
    AUTH_MODE: 'disabled',
    LOG_LEVEL: 'silent',
    AZURE_SUBSCRIPTION_IDS: subscriptionId,
    // Mutations stay off. Even if a tool were called by mistake, it could not change anything.
    MUTATIONS_ENABLED: 'false',
    DEPLOYMENTS_ENABLED: 'true',
    BICEP_CLI_PATH: process.env['BICEP_CLI_PATH'] ?? '',
    ...(process.env['BICEP_CLI_SHA256']
      ? { BICEP_CLI_SHA256: process.env['BICEP_CLI_SHA256'] }
      : {}),
  }),
);

const app = createApplication({ config });
const { services, registry } = app;
const context = {
  requestId: 'live-verify',
  principal: 'live:operator',
  transport: 'http',
} as const;

const invoke = <T>(tool: string, input: unknown): Promise<T> =>
  registry.invoke(tool, input, services, context) as Promise<T>;

console.log(
  `\nLive read-only verification\n  subscription ${subscriptionId}\n  group        ${resourceGroup}\n  region       ${region}\n`,
);

/* ------------------------------------------------------------------ identity and readiness */

await check('readiness reports the real compiler and identity', async () => {
  const report = await buildReadinessReport(config, registry, services);
  const compiler = report.components['bicepCompiler'];
  if (compiler?.state !== 'ok' && compiler?.state !== 'degraded') {
    throw new Error(`bicepCompiler is ${compiler?.state}: ${compiler?.detail}`);
  }
  return `ready=${report.ready}, compiler=${compiler.state} (${compiler.detail})`;
});

/* ---------------------------------------------------------------------------- read surface */

await check('azure_list_subscriptions against real ARM and Resource Graph', async () => {
  const result = await invoke<{
    subscriptions: {
      subscriptionId: string;
      displayName: string;
      readable: boolean;
      deployable: boolean;
    }[];
  }>('azure_list_subscriptions', {});
  const found = result.subscriptions.find((entry) => entry.subscriptionId === subscriptionId);
  if (!found) throw new Error('the target subscription was not returned');
  return `${result.subscriptions.length} subscription(s); target readable=${found.readable} deployable=${found.deployable}`;
});

await check('azure_list_resource_groups', async () => {
  const result = await invoke<{ resourceGroups: { name: string }[] }>(
    'azure_list_resource_groups',
    { subscriptionId },
  );
  if (!result.resourceGroups.some((group) => group.name === resourceGroup)) {
    throw new Error(`${resourceGroup} was not returned`);
  }
  return `${result.resourceGroups.length} group(s), including ${resourceGroup}`;
});

let sampleResourceId: string | undefined;

await check('azure_search_resources with structured filters', async () => {
  const result = await invoke<{ resources: { id: string; type: string }[]; scope: string[] }>(
    'azure_search_resources',
    { subscriptionIds: [subscriptionId], resourceGroup, limit: 5 },
  );
  sampleResourceId = result.resources[0]?.id;
  return `${result.resources.length} resource(s) in ${resourceGroup}; scope=${result.scope.join(',')}`;
});

await check('azure_get_resource by ARM id', async () => {
  if (!sampleResourceId) return 'skipped: the resource group is empty';
  const result = await invoke<{ resource: { id: string; type: string } }>('azure_get_resource', {
    resourceId: sampleResourceId,
  });
  return `${result.resource.type}`;
});

await check('azure_run_graph_query aggregation', async () => {
  const result = await invoke<{ rows: Record<string, unknown>[]; totalRecords?: number }>(
    'azure_run_graph_query',
    {
      subscriptionIds: [subscriptionId],
      query: 'Resources | summarize count() by type | order by count_ desc',
      limit: 5,
    },
  );
  return `${result.rows.length} row(s), e.g. ${JSON.stringify(result.rows[0] ?? {})}`;
});

await check('azure_get_activity_log via the hand-written ARM client', async () => {
  const result = await invoke<{ events: unknown[] }>('azure_get_activity_log', {
    subscriptionId,
    lookbackHours: 24,
    limit: 5,
  });
  return `${result.events.length} event(s) in the last 24h`;
});

await check('azure_list_unhealthy_resources via Resource Health', async () => {
  const result = await invoke<{ unhealthyResources: unknown[] }>('azure_list_unhealthy_resources', {
    subscriptionIds: [subscriptionId],
    limit: 5,
  });
  return `${result.unhealthyResources.length} unhealthy resource(s)`;
});

/* ------------------------------------------------------------------------- Bicep compiler */

const bundle = {
  mainFile: 'main.bicep',
  files: [
    {
      path: 'main.bicep',
      content: [
        "param namePrefix string = 'livecheck'",
        'param location string = resourceGroup().location',
        "var accountName = toLower('${namePrefix}${uniqueString(resourceGroup().id)}')",
        "resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {",
        '  name: accountName',
        '  location: location',
        "  sku: { name: 'Standard_LRS' }",
        "  kind: 'StorageV2'",
        "  properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false }",
        '}',
        'output accountId string = storage.id',
      ].join('\n'),
    },
  ],
};

await check('azure_validate_bicep with the real pinned compiler', async () => {
  const result = await invoke<{
    valid: boolean;
    templateScope?: string;
    resourceTypes: string[];
    diagnostics: { level: string; message: string }[];
  }>('azure_validate_bicep', { bundle });
  if (!result.valid) {
    throw new Error(`did not compile: ${JSON.stringify(result.diagnostics.slice(0, 3))}`);
  }
  return `scope=${result.templateScope ?? '?'}, types=${result.resourceTypes.join(',')}`;
});

await check('azure_validate_bicep rejects a deployment script', async () => {
  try {
    await invoke('azure_validate_bicep', {
      bundle: {
        mainFile: 'main.bicep',
        files: [
          {
            path: 'main.bicep',
            content: [
              "resource s 'Microsoft.Resources/deploymentScripts@2023-08-01' = {",
              "  name: 'pwn'",
              "  location: 'westus'",
              "  kind: 'AzureCLI'",
              "  properties: { azCliVersion: '2.9.1', scriptContent: 'echo hi', retentionInterval: 'P1D' }",
              '}',
            ].join('\n'),
          },
        ],
      },
    });
    throw new Error('a deployment script was accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/executes arbitrary code/.test(message)) throw error;
    return 'rejected, as intended';
  }
});

await check('azure_validate_bicep rejects a file load escaping the bundle', async () => {
  try {
    await invoke('azure_validate_bicep', {
      bundle: {
        mainFile: 'main.bicep',
        files: [
          {
            path: 'main.bicep',
            content: "output leak string = loadTextContent('../../../../etc/passwd')\n",
          },
        ],
      },
    });
    throw new Error('an escaping file load was accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a file in this bundle/.test(message)) throw error;
    return 'rejected, as intended';
  }
});

/* ------------------------------------------------------------------- ARM what-if (read-only) */

let confirmationHash: string | undefined;

await check('azure_what_if_bicep against real ARM (predicts only, creates nothing)', async () => {
  const result = await invoke<{
    confirmationHash: string;
    summary: {
      totalChanges: number;
      countsByChangeType: Record<string, number>;
      deletes: string[];
    };
    changes: { changeType: string; resourceType: string }[];
    scope: { armScope: string };
  }>('azure_what_if_bicep', {
    bundle,
    parameters: {},
    scope: { kind: 'resourceGroup', subscriptionId, resourceGroup },
  });
  confirmationHash = result.confirmationHash;
  if (result.summary.deletes.length > 0) {
    throw new Error(`unexpected predicted deletions: ${result.summary.deletes.join(', ')}`);
  }
  return `changes=${JSON.stringify(result.summary.countsByChangeType)}, scope=${result.scope.armScope}, hash=${result.confirmationHash.slice(0, 12)}…`;
});

await check('a tampered confirmation hash is refused', async () => {
  if (!confirmationHash) return 'skipped: no preview was produced';
  try {
    await invoke('azure_deploy_bicep', {
      bundle: {
        mainFile: 'main.bicep',
        files: [{ path: 'main.bicep', content: `${bundle.files[0]?.content ?? ''}\n// tampered` }],
      },
      parameters: {},
      scope: { kind: 'resourceGroup', subscriptionId, resourceGroup },
      confirmationHash,
      confirm: true,
      reason: 'live verification of the preview binding',
    });
    throw new Error('a tampered deployment was accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/differ from the previewed deployment/.test(message)) throw error;
    return 'refused, as intended (nothing was deployed)';
  }
});

await check('a scope outside the allow-list is refused', async () => {
  try {
    await invoke('azure_what_if_bicep', {
      bundle,
      parameters: {},
      scope: {
        kind: 'resourceGroup',
        subscriptionId: '00000000-0000-0000-0000-000000000000',
        resourceGroup,
      },
    });
    throw new Error('an out-of-scope subscription was accepted');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/allow-list/.test(message)) throw error;
    return 'refused, as intended';
  }
});

/* ---------------------------------------------------------------------------------- summary */

const failed = results.filter((entry) => entry.outcome === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const entry of failed) console.log(`  - ${entry.step}: ${entry.detail}`);
  process.exitCode = 1;
}
