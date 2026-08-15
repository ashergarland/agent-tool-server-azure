import { describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../../src/services/inventory.js';
import { Guardrails } from '../../src/services/guardrails.js';
import { testConfig } from '../helpers/config.js';
import { SUB_A, SUB_B, createFakeProvider } from '../helpers/fake-provider.js';

const DEPLOYMENT_ENV = {
  DEPLOYMENTS_ENABLED: 'true',
  BICEP_CLI_PATH: '/opt/bicep/bicep',
};

const setup = (
  overrides: Record<string, string> = {},
  permissions: Record<string, string[]> = {},
) => {
  const getEffectivePermissions = vi.fn((armScope: string, identity: 'operator' | 'deployment') => {
    const actions = permissions[`${identity}:${armScope}`];
    if (actions === undefined) return Promise.reject(new Error('403'));
    return Promise.resolve([{ actions, notActions: [] }]);
  });
  const provider = createFakeProvider({ getEffectivePermissions });
  const config = testConfig(overrides);
  return {
    provider,
    getEffectivePermissions,
    service: new InventoryService(provider, new Guardrails(config), config),
  };
};

const READ = 'Microsoft.Resources/subscriptions/resourceGroups/read';
const DEPLOY = 'Microsoft.Resources/deployments/write';

describe('subscription capabilities', () => {
  it('reports a subscription as readable only when the operator identity holds RBAC there', async () => {
    const { service } = setup(
      {},
      {
        [`operator:/subscriptions/${SUB_A}`]: [READ],
        // SUB_B intentionally absent: the permissions call fails, as it would in Azure.
      },
    );

    const subscriptions = await service.listSubscriptions();
    expect(subscriptions).toEqual([
      expect.objectContaining({ subscriptionId: SUB_A, readable: true, deployable: false }),
      expect.objectContaining({ subscriptionId: SUB_B, readable: false, deployable: false }),
    ]);
  });

  it('honours wildcard permissions the way ARM does', async () => {
    const { service } = setup(
      {},
      {
        [`operator:/subscriptions/${SUB_A}`]: ['Microsoft.Resources/*'],
        [`operator:/subscriptions/${SUB_B}`]: ['Microsoft.Compute/*'],
      },
    );
    const subscriptions = await service.listSubscriptions();
    expect(subscriptions.map((entry) => entry.readable)).toEqual([true, false]);
  });

  it('never reports a subscription as deployable when deployments are disabled', async () => {
    const { service } = setup(
      { AZURE_SUBSCRIPTION_IDS: `${SUB_A},${SUB_B}` },
      {
        [`operator:/subscriptions/${SUB_A}`]: ['*'],
        [`deployment:/subscriptions/${SUB_A}`]: ['*'],
      },
    );
    const subscriptions = await service.listSubscriptions();
    expect(subscriptions.every((entry) => !entry.deployable)).toBe(true);
  });

  it('reports deployable only where the deployment identity itself holds write access', async () => {
    const { service } = setup(
      { ...DEPLOYMENT_ENV, AZURE_SUBSCRIPTION_IDS: `${SUB_A},${SUB_B}` },
      {
        [`operator:/subscriptions/${SUB_A}`]: [READ],
        [`operator:/subscriptions/${SUB_B}`]: [READ],
        [`deployment:/subscriptions/${SUB_A}`]: [DEPLOY],
        // The deployment identity has read but no write in SUB_B.
        [`deployment:/subscriptions/${SUB_B}`]: [READ],
      },
    );

    const subscriptions = await service.listSubscriptions();
    expect(subscriptions).toEqual([
      expect.objectContaining({ subscriptionId: SUB_A, readable: true, deployable: true }),
      expect.objectContaining({ subscriptionId: SUB_B, readable: true, deployable: false }),
    ]);
  });

  it('never reports a subscription outside the allow-list as deployable', async () => {
    const { service } = setup(
      { ...DEPLOYMENT_ENV, AZURE_SUBSCRIPTION_IDS: SUB_A },
      {
        [`operator:/subscriptions/${SUB_A}`]: ['*'],
        [`deployment:/subscriptions/${SUB_A}`]: ['*'],
        [`deployment:/subscriptions/${SUB_B}`]: ['*'],
      },
    );
    const subscriptions = await service.listSubscriptions();
    expect(subscriptions.map((entry) => entry.subscriptionId)).toEqual([SUB_A]);
  });

  it('asks ARM once per scope and then serves the answer from cache', async () => {
    const { getEffectivePermissions, service } = setup(
      {},
      { [`operator:/subscriptions/${SUB_A}`]: ['*'], [`operator:/subscriptions/${SUB_B}`]: ['*'] },
    );

    await service.listSubscriptions();
    await service.listSubscriptions();

    expect(getEffectivePermissions).toHaveBeenCalledTimes(2);
  });

  it('skips the RBAC probe entirely when verification is switched off', async () => {
    const { getEffectivePermissions, service } = setup({ AZURE_VERIFY_RBAC: 'false' });
    const subscriptions = await service.listSubscriptions();

    expect(getEffectivePermissions).not.toHaveBeenCalled();
    expect(subscriptions.every((entry) => entry.readable)).toBe(true);
  });
});
