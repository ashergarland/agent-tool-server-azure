import { describe, expect, it } from 'vitest';
import { Guardrails } from '../../src/services/guardrails.js';
import { AppError } from '../../src/errors.js';
import { testConfig } from '../helpers/config.js';
import { SUB_A, SUB_B, webAppId } from '../helpers/fake-provider.js';

const scoped = () =>
  new Guardrails(
    testConfig({
      AZURE_SUBSCRIPTION_IDS: SUB_A,
      AZURE_ALLOWED_RESOURCE_GROUPS: 'rg-prod',
    }),
  );

describe('Guardrails', () => {
  it('allows subscriptions on the allow-list', () => {
    expect(scoped().assertSubscriptionAllowed(SUB_A)).toBe(SUB_A);
  });

  it('rejects subscriptions outside the allow-list', () => {
    expect(() => scoped().assertSubscriptionAllowed(SUB_B)).toThrowError(
      expect.objectContaining({ code: 'forbidden' }) as unknown,
    );
  });

  it('treats an empty allow-list as unrestricted', () => {
    const guardrails = new Guardrails(testConfig());
    expect(guardrails.assertSubscriptionAllowed(SUB_B)).toBe(SUB_B);
  });

  it('defaults the query scope to the allow-list when none is requested', () => {
    expect(scoped().resolveSubscriptionScope([])).toEqual([SUB_A]);
  });

  it('rejects resource groups outside the allow-list', () => {
    expect(() => scoped().assertResourceGroupAllowed('rg-dev')).toThrow(AppError);
  });

  it('rejects malformed resource ids', () => {
    expect(() => scoped().assertResourceIdInScope('not-a-resource-id')).toThrow(
      /fully qualified ARM resource id/,
    );
  });

  it('enforces both subscription and resource group scope for a resource id', () => {
    expect(() => scoped().assertResourceIdInScope(webAppId())).not.toThrow();
    expect(() => scoped().assertResourceIdInScope(webAppId(SUB_B))).toThrow(/allow-list/);
    expect(() => scoped().assertResourceIdInScope(webAppId(SUB_A, 'rg-dev'))).toThrow(/allow-list/);
  });

  it('rejects mutating KQL operators', () => {
    expect(() => scoped().assertReadOnlyQuery('Resources | evaluate bag_unpack(tags)')).toThrow(
      /disallowed operator/,
    );
    expect(() => scoped().assertReadOnlyQuery('Resources | project id')).not.toThrow();
  });

  describe('mutation gating', () => {
    it('always allows dry runs, even when mutations are disabled', () => {
      const guardrails = new Guardrails(testConfig());
      expect(
        guardrails.assertMutationAllowed({ toolName: 'x', confirm: false, dryRun: true }),
      ).toBe(true);
    });

    it('blocks real mutations when MUTATIONS_ENABLED is false', () => {
      const guardrails = new Guardrails(testConfig());
      expect(() =>
        guardrails.assertMutationAllowed({ toolName: 'x', confirm: true, dryRun: false }),
      ).toThrow(/MUTATIONS_ENABLED is false/);
    });

    it('requires explicit confirmation when mutations are enabled', () => {
      const guardrails = new Guardrails(testConfig({ MUTATIONS_ENABLED: 'true' }));
      expect(() =>
        guardrails.assertMutationAllowed({ toolName: 'x', confirm: false, dryRun: false }),
      ).toThrow(/confirm=true/);
      expect(
        guardrails.assertMutationAllowed({ toolName: 'x', confirm: true, dryRun: false }),
      ).toBe(false);
    });

    it('can be deployed without confirmation when explicitly configured', () => {
      const guardrails = new Guardrails(
        testConfig({ MUTATIONS_ENABLED: 'true', MUTATION_CONFIRMATION_REQUIRED: 'false' }),
      );
      expect(
        guardrails.assertMutationAllowed({ toolName: 'x', confirm: false, dryRun: false }),
      ).toBe(false);
    });
  });
});
