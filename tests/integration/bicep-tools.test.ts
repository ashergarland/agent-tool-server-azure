import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import { InMemoryDeploymentRecordStore } from '../../src/deployments/store-memory.js';
import { testConfig } from '../helpers/config.js';
import { createFakeCompiler, type FakeCompiler } from '../helpers/bicep.js';
import {
  SUB_A,
  createFakeProvider,
  createTestLogger,
  type FakeProvider,
} from '../helpers/fake-provider.js';

const API_KEY = 'bicep-tools-api-key-that-is-long-enough';
const auth = { 'x-api-key': API_KEY };

const bundle = {
  mainFile: 'main.bicep',
  files: [
    { path: 'main.bicep', content: "param name string\nmodule s 'modules/storage.bicep' = {}\n" },
    { path: 'modules/storage.bicep', content: 'param name string\n' },
  ],
};

const scope = { kind: 'resourceGroup', subscriptionId: SUB_A, resourceGroup: 'rg-prod' };

describe('Bicep tools over HTTP', () => {
  let app: Application;
  let provider: FakeProvider;
  let compiler: FakeCompiler;

  beforeEach(async () => {
    provider = createFakeProvider({
      whatIfDeployment: vi.fn(() =>
        Promise.resolve({
          status: 'Succeeded',
          changes: [
            {
              changeType: 'Create',
              resourceId: `/subscriptions/${SUB_A}/resourceGroups/rg-prod/providers/Microsoft.Storage/storageAccounts/sa`,
              unsupportedReason: undefined,
              propertyChanges: [],
            },
          ],
          error: undefined,
        }),
      ),
      listDeploymentOperations: vi.fn(() =>
        Promise.resolve({
          operations: [
            {
              operationId: 'op-1',
              provisioningState: 'Failed',
              timestamp: '2026-01-01T00:00:00Z',
              duration: 'PT2S',
              resourceType: 'Microsoft.Storage/storageAccounts',
              resourceName: 'sa',
              targetResourceId:
                '/subscriptions/x/resourceGroups/rg-prod/providers/Microsoft.Storage/storageAccounts/sa',
              statusCode: 'Conflict',
              statusMessage: 'StorageAccountAlreadyTaken',
            },
          ],
          skipToken: 'next-page',
        }),
      ),
    });
    compiler = createFakeCompiler();

    app = createApplication({
      config: testConfig({
        AUTH_MODE: 'api-key',
        API_KEYS: API_KEY,
        DEPLOYMENTS_ENABLED: 'true',
        BICEP_CLI_PATH: '/opt/bicep/bicep',
        AZURE_SUBSCRIPTION_IDS: SUB_A,
      }),
      logger: createTestLogger() as unknown as Logger,
      provider,
      compiler,
      store: new InMemoryDeploymentRecordStore(),
    });
    await app.http.ready();
  });

  afterEach(async () => {
    await app.http.close();
  });

  const call = async <T>(
    tool: string,
    payload: unknown,
  ): Promise<{ status: number; result: T }> => {
    const response = await app.http.inject({
      method: 'POST',
      url: `/tools/${tool}`,
      headers: auth,
      payload: payload as Record<string, unknown>,
    });
    const body = response.json<{ result: T; error?: unknown }>();
    return { status: response.statusCode, result: body.result };
  };

  it('validates source without contacting Azure', async () => {
    const { status, result } = await call<{
      valid: boolean;
      templateScope: string;
      resourceTypes: string[];
      secureParameterNames: string[];
      sourceHash: string;
    }>('azure_validate_bicep', { bundle });

    expect(status).toBe(200);
    expect(result.valid).toBe(true);
    expect(result.templateScope).toBe('resourceGroup');
    expect(result.resourceTypes).toEqual(['microsoft.storage/storageaccounts']);
    expect(result.secureParameterNames).toEqual(['adminPassword']);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.calls.some((entry) => entry.name === 'whatIfDeployment')).toBe(false);
  });

  it('runs the whole preview, deploy, inspect and roll back lifecycle', async () => {
    const parameters = { name: 'sa' };

    const preview = await call<{
      confirmationHash: string;
      summary: { totalChanges: number; countsByChangeType: Record<string, number> };
      changes: { changeType: string; resourceType: string }[];
      scope: { armScope: string };
      mode: string;
    }>('azure_what_if_bicep', { bundle, parameters, scope });

    expect(preview.status).toBe(200);
    expect(preview.result.mode).toBe('Incremental');
    expect(preview.result.summary.countsByChangeType).toEqual({ Create: 1 });
    expect(preview.result.changes[0]?.resourceType).toBe('microsoft.storage/storageaccounts');
    expect(preview.result.scope.armScope).toBe(`/subscriptions/${SUB_A}/resourceGroups/rg-prod`);

    const deployed = await call<{ recordId: string; status: string; alreadyStarted: boolean }>(
      'azure_deploy_bicep',
      {
        bundle,
        parameters,
        scope,
        confirmationHash: preview.result.confirmationHash,
        confirm: true,
        reason: 'create the storage account the team asked for',
      },
    );
    expect(deployed.status).toBe(200);
    expect(deployed.result.status).toBe('running');
    expect(deployed.result.alreadyStarted).toBe(false);

    const status = await call<{ provisioningState: string; recordId: string }>(
      'azure_get_deployment',
      { recordId: deployed.result.recordId },
    );
    expect(status.status).toBe(200);
    expect(status.result.provisioningState).toBe('Succeeded');

    const operations = await call<{
      operations: { statusCode: string; resourceName: string }[];
      skipToken: string;
    }>('azure_list_deployment_operations', { recordId: deployed.result.recordId, limit: 10 });
    expect(operations.result.operations[0]?.statusCode).toBe('Conflict');
    expect(operations.result.skipToken).toBe('next-page');

    const rollbackPreview = await call<{
      phase: string;
      rollbackOf: string;
      preview: { confirmationHash: string; warnings: { code: string }[] };
    }>('azure_rollback_deployment', { recordId: deployed.result.recordId, reason: 'undo' });
    expect(rollbackPreview.result.phase).toBe('preview');
    expect(rollbackPreview.result.preview.warnings.map((w) => w.code)).toContain(
      'rollback_is_a_redeploy',
    );

    const rolledBack = await call<{ phase: string; result: { status: string } }>(
      'azure_rollback_deployment',
      {
        recordId: deployed.result.recordId,
        confirm: true,
        confirmationHash: rollbackPreview.result.preview.confirmationHash,
        reason: 'undo the storage account change',
      },
    );
    expect(rolledBack.result.phase).toBe('deployed');
    expect(rolledBack.result.result.status).toBe('running');
  });

  it('refuses a deployment whose source no longer matches the approved preview', async () => {
    const preview = await call<{ confirmationHash: string }>('azure_what_if_bicep', {
      bundle,
      parameters: { name: 'sa' },
      scope,
    });

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_deploy_bicep',
      headers: auth,
      payload: {
        bundle: {
          mainFile: 'main.bicep',
          files: [{ path: 'main.bicep', content: 'param name string // sneaky\n' }],
        },
        parameters: { name: 'sa' },
        scope,
        confirmationHash: preview.result.confirmationHash,
        confirm: true,
        reason: 'x',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('conflict');
  });

  it('rejects a template that hides a deployment script in a nested deployment', async () => {
    compiler.result = {
      ...compiler.result,
      template: {
        $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        contentVersion: '1.0.0.0',
        resources: [
          {
            type: 'Microsoft.Resources/deployments',
            apiVersion: '2024-03-01',
            name: 'inner',
            properties: {
              mode: 'Incremental',
              template: {
                resources: [
                  {
                    type: 'Microsoft.Resources/deploymentScripts',
                    apiVersion: '2023-08-01',
                    name: 'pwn',
                  },
                ],
              },
            },
          },
        ],
      },
    };

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_validate_bicep',
      headers: auth,
      payload: { bundle },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /executes arbitrary code/,
    );
  });

  it('rejects a remote module reference by default', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_validate_bicep',
      headers: auth,
      payload: {
        bundle: {
          mainFile: 'main.bicep',
          files: [
            {
              path: 'main.bicep',
              content: "module s 'br:contoso.azurecr.io/bicep/storage:v1' = {}\n",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(
      /Remote Bicep modules are disabled/,
    );
  });

  it('reports a deployment by explicit scope and name as well as by record id', async () => {
    const { status, result } = await call<{ deploymentName: string; recordId?: string }>(
      'azure_get_deployment',
      { scope, deploymentName: 'some-earlier-deployment' },
    );
    expect(status).toBe(200);
    expect(result.deploymentName).toBe('test');
    expect(result.recordId).toBeUndefined();
  });

  it('rejects a deployment name ARM would not accept', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/azure_get_deployment',
      headers: auth,
      payload: { scope, deploymentName: 'not/a/valid/name' },
    });
    expect(response.statusCode).toBe(400);
  });
});
