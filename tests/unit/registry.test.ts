import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolRegistry } from '../../src/tools/registry.js';
import { toolDefinitions, type ToolDefinition } from '../../src/tools/definitions.js';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';
import { createFakeProvider, createTestLogger } from '../helpers/fake-provider.js';
import type { Logger } from 'pino';

const context = { requestId: 'req-1', principal: 'test' };

const buildServices = (overrides: Record<string, string> = {}) => {
  const provider = createFakeProvider();
  const services = createServices(
    testConfig(overrides),
    provider,
    createTestLogger() as unknown as Logger,
  );
  return { provider, services };
};

describe('ToolRegistry', () => {
  const registry = createToolRegistry();

  it('registers every declared tool', () => {
    expect(registry.list()).toHaveLength(toolDefinitions.length);
  });

  it('exposes unique, snake_case, azure-prefixed tool names', () => {
    const names = registry.list().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^azure_[a-z0-9_]+$/);
  });

  it('emits a JSON schema for every tool', () => {
    for (const tool of registry.list()) {
      expect(tool.inputJsonSchema).toMatchObject({ type: 'object' });
      expect(tool.outputJsonSchema).toBeTypeOf('object');
    }
  });

  it('marks state-changing tools as write tools', () => {
    const writeTools = registry
      .list()
      .filter((tool) => tool.kind === 'write')
      .map((tool) => tool.name);
    expect(writeTools).toEqual([
      'azure_restart_virtual_machine',
      'azure_start_virtual_machine',
      'azure_restart_web_app',
      'azure_tag_resource',
    ]);
  });

  it('rejects duplicate tool names', () => {
    const duplicate = toolDefinitions[0] as unknown as ToolDefinition;
    expect(() => createToolRegistry([duplicate, duplicate])).toThrow(/Duplicate tool name/);
  });

  it('throws not_found for unknown tools', () => {
    expect(() => registry.get('azure_nope')).toThrowError(
      expect.objectContaining({ code: 'not_found' }) as unknown,
    );
  });

  it('validates input before invoking the handler', async () => {
    const { services } = buildServices();
    await expect(
      registry.invoke('azure_get_resource', { resourceId: 123 }, services, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });

  it('applies schema defaults', async () => {
    const { provider, services } = buildServices();
    await registry.invoke('azure_search_resources', {}, services, context);
    const call = provider.calls.find((entry) => entry.name === 'queryResourceGraph');
    expect((call?.args[0] as { top: number }).top).toBe(100);
  });

  it('invokes a read tool end to end', async () => {
    const { services } = buildServices();
    const result = await registry.invoke('azure_list_subscriptions', {}, services, context);
    const parsed = z
      .object({ subscriptions: z.array(z.object({ subscriptionId: z.string() })) })
      .parse(result);
    expect(parsed.subscriptions).toHaveLength(2);
  });

  it('surfaces guardrail failures as AppErrors', async () => {
    const { services } = buildServices({ MUTATIONS_ENABLED: 'false' });
    await expect(
      registry.invoke(
        'azure_restart_web_app',
        {
          resourceId:
            '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-prod/providers/Microsoft.Web/sites/api',
          confirm: true,
        },
        services,
        context,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'forbidden' }) as unknown);
  });
});
