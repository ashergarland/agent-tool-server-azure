import { describe, expect, it } from 'vitest';
import { InventoryService } from '../../src/services/inventory.js';
import { Guardrails } from '../../src/services/guardrails.js';
import { testConfig } from '../helpers/config.js';
import { SUB_A, SUB_B, createFakeProvider, webAppId } from '../helpers/fake-provider.js';
import type { ResourceGraphQueryInput } from '../../src/provider/types.js';

const setup = (overrides: Record<string, string> = {}) => {
  const provider = createFakeProvider();
  const config = testConfig(overrides);
  const guardrails = new Guardrails(config);
  return { provider, service: new InventoryService(provider, guardrails, config) };
};

const lastQuery = (provider: ReturnType<typeof createFakeProvider>): ResourceGraphQueryInput =>
  provider.calls.filter((call) => call.name === 'queryResourceGraph').at(-1)
    ?.args[0] as ResourceGraphQueryInput;

describe('InventoryService', () => {
  it('filters subscriptions by the allow-list', async () => {
    const { service } = setup({ AZURE_SUBSCRIPTION_IDS: SUB_A });
    const subscriptions = await service.listSubscriptions();
    expect(subscriptions.map((s) => s.subscriptionId)).toEqual([SUB_A]);
  });

  it('returns every subscription when unrestricted', async () => {
    const { service } = setup();
    expect(await service.listSubscriptions()).toHaveLength(2);
  });

  it('filters resource groups by the allow-list', async () => {
    const { service } = setup({ AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod' });
    const groups = await service.listResourceGroups(SUB_A);
    expect(groups.map((g) => g.name)).toEqual(['rg-prod']);
  });

  it('refuses to read a resource outside the allowed subscription', async () => {
    const { service } = setup({ AZURE_SUBSCRIPTION_IDS: SUB_A });
    await expect(service.getResource(webAppId(SUB_B))).rejects.toThrow(/allow-list/);
  });

  it('builds a filtered Resource Graph query from structured input', async () => {
    const { provider, service } = setup();
    await service.searchResources({
      subscriptionIds: [SUB_A],
      resourceType: 'microsoft.web/sites',
      location: 'westeurope',
      nameContains: 'api',
      tagName: 'env',
      tagValue: 'prod',
      limit: 25,
    });

    const query = lastQuery(provider);
    expect(query.subscriptionIds).toEqual([SUB_A]);
    expect(query.top).toBe(25);
    expect(query.query).toContain("| where type =~ 'microsoft.web/sites'");
    expect(query.query).toContain("| where location =~ 'westeurope'");
    expect(query.query).toContain("| where name contains 'api'");
    expect(query.query).toContain("| where tags['env'] =~ 'prod'");
  });

  it('constrains searches to allow-listed resource groups when none is supplied', async () => {
    const { provider, service } = setup({ AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod,rg-shared' });
    await service.searchResources({ subscriptionIds: [], limit: 10 });
    expect(lastQuery(provider).query).toContain(
      "| where tolower(resourceGroup) in ('rg-prod', 'rg-shared')",
    );
  });

  it('escapes single quotes in user supplied filter values', async () => {
    const { provider, service } = setup();
    await service.searchResources({
      subscriptionIds: [],
      nameContains: "a' | project 1 //",
      limit: 5,
    });
    expect(lastQuery(provider).query).toContain("| where name contains 'a\\' | project 1 //'");
  });

  it('rejects mutating raw graph queries before hitting Azure', async () => {
    const { provider, service } = setup();
    await expect(
      service.runGraphQuery({
        subscriptionIds: [],
        query: 'Resources | evaluate foo()',
        limit: 10,
      }),
    ).rejects.toThrow(/disallowed operator/);
    expect(provider.calls).toHaveLength(0);
  });

  it('passes through pagination tokens', async () => {
    const { provider, service } = setup();
    await service.runGraphQuery({
      subscriptionIds: [],
      query: 'Resources | project id',
      limit: 10,
      skipToken: 'token-123',
    });
    expect(lastQuery(provider).skipToken).toBe('token-123');
  });
});
