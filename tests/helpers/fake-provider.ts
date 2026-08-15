import { vi } from 'vitest';
import type {
  ActivityLogEntry,
  ArmDeploymentOperationPage,
  ArmDeploymentStatus,
  ArmWhatIfResult,
  AzureProvider,
  AzureResource,
  EffectivePermission,
  MetricSeries,
  ResourceGraphPage,
  ResourceGroup,
  Subscription,
} from '../../src/provider/types.js';

export const SUB_A = '11111111-1111-1111-1111-111111111111';
export const SUB_B = '22222222-2222-2222-2222-222222222222';

export const webAppId = (subscription = SUB_A, group = 'rg-prod', name = 'api'): string =>
  `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Web/sites/${name}`;

export const vmId = (subscription = SUB_A, group = 'rg-prod', name = 'vm1'): string =>
  `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Compute/virtualMachines/${name}`;

export const makeResource = (overrides: Partial<AzureResource> = {}): AzureResource => ({
  id: webAppId(),
  name: 'api',
  type: 'microsoft.web/sites',
  location: 'westeurope',
  resourceGroup: 'rg-prod',
  subscriptionId: SUB_A,
  kind: 'app',
  sku: undefined,
  tags: {},
  ...overrides,
});

export interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface FakeProvider extends AzureProvider {
  readonly calls: RecordedCall[];
}

/**
 * Hand-written fake provider. Tests assert on the recorded calls, which keeps them honest about
 * what the connector would actually send to Azure.
 */
export const createFakeProvider = (overrides: Partial<AzureProvider> = {}): FakeProvider => {
  const calls: RecordedCall[] = [];
  const record =
    <T>(name: string, result: () => T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ name, args });
      return Promise.resolve(result());
    };

  const base: AzureProvider = {
    listSubscriptions: record<readonly Subscription[]>('listSubscriptions', () => [
      { subscriptionId: SUB_A, displayName: 'prod', state: 'Enabled', tenantId: 'tenant' },
      { subscriptionId: SUB_B, displayName: 'sandbox', state: 'Enabled', tenantId: 'tenant' },
    ]),
    listResourceGroups: record<readonly ResourceGroup[]>('listResourceGroups', () => [
      {
        id: 'rg-prod-id',
        name: 'rg-prod',
        location: 'westeurope',
        provisioningState: 'Succeeded',
        tags: {},
      },
      {
        id: 'rg-dev-id',
        name: 'rg-dev',
        location: 'westeurope',
        provisioningState: 'Succeeded',
        tags: {},
      },
    ]),
    getResourceById: record<AzureResource>('getResourceById', () => makeResource()),
    queryResourceGraph: record<ResourceGraphPage>('queryResourceGraph', () => ({
      rows: [{ id: webAppId(), name: 'api', type: 'microsoft.web/sites', tags: {} }],
      totalRecords: 1,
      skipToken: undefined,
    })),
    listActivityLog: record<readonly ActivityLogEntry[]>('listActivityLog', () => []),
    listMetrics: record<readonly MetricSeries[]>('listMetrics', () => []),
    restartVirtualMachine: record<void>('restartVirtualMachine', () => undefined),
    startVirtualMachine: record<void>('startVirtualMachine', () => undefined),
    restartWebApp: record<void>('restartWebApp', () => undefined),
    setResourceTags: record<AzureResource>('setResourceTags', () =>
      makeResource({ tags: { owner: 'platform' } }),
    ),
    getEffectivePermissions: record<readonly EffectivePermission[]>(
      'getEffectivePermissions',
      () => [{ actions: ['*'], notActions: [] }],
    ),
    whatIfDeployment: record<ArmWhatIfResult>('whatIfDeployment', () => ({
      status: 'Succeeded',
      changes: [],
      error: undefined,
    })),
    beginDeployment: record<ArmDeploymentStatus>('beginDeployment', () => ({
      id: '/subscriptions/x/providers/Microsoft.Resources/deployments/test',
      name: 'test',
      provisioningState: 'Accepted',
      correlationId: 'correlation',
      timestamp: undefined,
      duration: undefined,
      outputs: undefined,
      error: undefined,
    })),
    getDeployment: record<ArmDeploymentStatus>('getDeployment', () => ({
      id: '/subscriptions/x/providers/Microsoft.Resources/deployments/test',
      name: 'test',
      provisioningState: 'Succeeded',
      correlationId: 'correlation',
      timestamp: '2026-01-01T00:00:00Z',
      duration: 'PT1M',
      outputs: undefined,
      error: undefined,
    })),
    listDeploymentOperations: record<ArmDeploymentOperationPage>(
      'listDeploymentOperations',
      () => ({ operations: [], skipToken: undefined }),
    ),
  };

  return { ...base, ...overrides, calls };
};

/** Minimal pino-compatible logger that swallows output during tests. */
export const createTestLogger = () => {
  const logger = {
    level: 'silent',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
};
