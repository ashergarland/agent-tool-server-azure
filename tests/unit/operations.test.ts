import { describe, expect, it, vi } from 'vitest';
import { OperationsService } from '../../src/services/operations.js';
import { Guardrails } from '../../src/services/guardrails.js';
import { testConfig } from '../helpers/config.js';
import {
  createFakeProvider,
  createTestLogger,
  makeResource,
  vmId,
  webAppId,
} from '../helpers/fake-provider.js';
import type { Logger } from 'pino';
import { Metrics } from '../../src/util/metrics.js';

const setup = (overrides: Record<string, string> = {}) => {
  const provider = createFakeProvider({
    getResourceById: vi.fn((resourceId: string) =>
      Promise.resolve(
        makeResource({
          id: resourceId,
          type: resourceId.toLowerCase().includes('/virtualmachines/')
            ? 'microsoft.compute/virtualmachines'
            : 'microsoft.web/sites',
        }),
      ),
    ),
  });
  const logger = createTestLogger();
  const service = new OperationsService(
    provider,
    new Guardrails(testConfig(overrides)),
    logger as unknown as Logger,
    new Metrics(),
  );
  return { provider, service, logger };
};

describe('OperationsService', () => {
  it('performs a dry run without calling Azure', async () => {
    const { provider, service } = setup();
    const result = await service.restartWebApp({
      resourceId: webAppId(),
      confirm: false,
      dryRun: true,
    });

    expect(result).toMatchObject({ dryRun: true, performed: false, action: 'restart_web_app' });
    expect(provider.calls.some((call) => call.name === 'restartWebApp')).toBe(false);
  });

  it('refuses to mutate when mutations are disabled', async () => {
    const { service } = setup();
    await expect(
      service.restartWebApp({ resourceId: webAppId(), confirm: true, dryRun: false }),
    ).rejects.toThrow(/MUTATIONS_ENABLED is false/);
  });

  it('requires confirmation even when mutations are enabled', async () => {
    const { service } = setup({ MUTATIONS_ENABLED: 'true' });
    await expect(
      service.restartWebApp({ resourceId: webAppId(), confirm: false, dryRun: false }),
    ).rejects.toThrow(/confirm=true/);
  });

  it('executes a confirmed restart and audit logs it', async () => {
    const { provider, service, logger } = setup({ MUTATIONS_ENABLED: 'true' });
    const result = await service.restartWebApp({
      resourceId: webAppId(),
      confirm: true,
      dryRun: false,
      reason: 'deployment wedged',
    });

    expect(result.performed).toBe(true);
    expect(provider.calls.some((call) => call.name === 'restartWebApp')).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'azure.mutation', reason: 'deployment wedged' }),
      expect.any(String),
    );
  });

  it('rejects an operation applied to the wrong resource type', async () => {
    const { service } = setup({ MUTATIONS_ENABLED: 'true' });
    await expect(
      service.restartVirtualMachine({ resourceId: webAppId(), confirm: true, dryRun: false }),
    ).rejects.toThrow(/expects a resource of type microsoft.compute\/virtualmachines/);
  });

  it('restarts a virtual machine when the type matches', async () => {
    const { provider, service } = setup({ MUTATIONS_ENABLED: 'true' });
    await service.restartVirtualMachine({ resourceId: vmId(), confirm: true, dryRun: false });
    const call = provider.calls.find((entry) => entry.name === 'restartVirtualMachine');
    expect(call?.args[0]).toEqual({
      subscriptionId: '11111111-1111-1111-1111-111111111111',
      resourceGroup: 'rg-prod',
      name: 'vm1',
    });
  });

  it('rejects tagging with an empty tag set', async () => {
    const { service } = setup({ MUTATIONS_ENABLED: 'true' });
    await expect(
      service.tagResource({ resourceId: webAppId(), tags: {}, confirm: true, dryRun: false }),
    ).rejects.toThrow(/At least one tag/);
  });

  it('merges tags and returns the refreshed resource', async () => {
    const { provider, service } = setup({ MUTATIONS_ENABLED: 'true' });
    const result = await service.tagResource({
      resourceId: webAppId(),
      tags: { owner: 'platform' },
      confirm: true,
      dryRun: false,
    });

    expect(result.performed).toBe(true);
    expect(result.resource?.tags).toEqual({ owner: 'platform' });
    expect(provider.calls.some((call) => call.name === 'setResourceTags')).toBe(true);
  });
});
