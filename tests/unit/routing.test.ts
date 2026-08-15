import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';
import { SERVER_INSTRUCTIONS } from '../../src/tools/instructions.js';
import { rankOf, topTool } from '../helpers/routing.js';

const registry = createToolRegistry();
const tools = registry.list();
const names = new Set(tools.map((tool) => tool.name));

describe('tool routing metadata', () => {
  it('gives every tool concrete positive and negative guidance', () => {
    for (const tool of tools) {
      expect(tool.routing.useWhen.length, `${tool.name} useWhen`).toBeGreaterThan(0);
      expect(tool.routing.doNotUseWhen.length, `${tool.name} doNotUseWhen`).toBeGreaterThan(0);
      expect(tool.routing.requiredScope.length, `${tool.name} requiredScope`).toBeGreaterThan(0);
    }
  });

  it('only cross-references tools that actually exist', () => {
    for (const tool of tools) {
      for (const referenced of [
        ...(tool.routing.prerequisites ?? []),
        ...(tool.routing.nextSteps ?? []),
      ]) {
        expect(names, `${tool.name} references ${referenced}`).toContain(referenced);
      }
    }
  });

  it('declares changesState in agreement with the tool kind', () => {
    for (const tool of tools) {
      expect(tool.routing.changesState, tool.name).toBe(tool.kind === 'write');
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.kind === 'read');
    }
  });

  it('renders guidance into the description agents actually read', () => {
    const deploy = registry.get('azure_deploy_bicep');
    expect(deploy.description).toContain('CHANGES Azure state');
    expect(deploy.description).toContain('Required scope:');
    expect(deploy.description).toContain('Use when:');
    expect(deploy.description).toContain('Do not use when:');
    expect(deploy.description.startsWith(deploy.baseDescription.trim())).toBe(true);

    const read = registry.get('azure_search_resources');
    expect(read.description).toContain('read-only');
  });

  it('tells read-only tools apart from consequential ones in the rendered text', () => {
    for (const tool of tools) {
      const marker = tool.kind === 'write' ? 'CHANGES Azure state' : 'State: read-only';
      expect(tool.description, tool.name).toContain(marker);
    }
  });
});

describe('server instructions', () => {
  it('teaches the discovery, resolution, diagnosis and approval workflow', () => {
    expect(SERVER_INSTRUCTIONS).toContain('azure_list_subscriptions');
    expect(SERVER_INSTRUCTIONS).toContain('azure_list_resource_groups');
    expect(SERVER_INSTRUCTIONS).toContain('Prefer structured search over raw queries');
    expect(SERVER_INSTRUCTIONS).toContain('Resolve the exact ARM resource id');
    expect(SERVER_INSTRUCTIONS).toContain('azure_get_activity_log');
    expect(SERVER_INSTRUCTIONS).toContain('Preview, get approval, execute, verify');
    expect(SERVER_INSTRUCTIONS).toContain('confirmation hash');
  });

  it('states plainly that no shell or arbitrary REST surface exists', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/cannot run shell commands, arbitrary REST calls/);
  });

  it('forbids caller-supplied Azure credentials', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Never ask the user for Azure credentials/);
  });
});

describe('routing evals', () => {
  const positive: readonly [string, string][] = [
    ['which azure subscriptions can I use', 'azure_list_subscriptions'],
    ['list the resource groups in this subscription', 'azure_list_resource_groups'],
    ['find every storage account tagged owner in westeurope', 'azure_search_resources'],
    [
      'summarize the count of resources grouped by type with an aggregation across the tenant',
      'azure_run_graph_query',
    ],
    ['who changed this resource recently and what was the caller', 'azure_get_activity_log'],
    ['show cpu utilisation over the last six hours', 'azure_get_resource_metrics'],
    ['is anything broken right now, an incident was reported', 'azure_list_unhealthy_resources'],
    ['reboot the wedged virtual machine', 'azure_restart_virtual_machine'],
    ['the virtual machine is deallocated, bring it back up', 'azure_start_virtual_machine'],
    ['recycle the app service site to clear a fault', 'azure_restart_web_app'],
    ['label this resource with an ownership tag for cost allocation', 'azure_tag_resource'],
    ['does my bicep compile and what resource types would it create', 'azure_validate_bicep'],
    ['what would deploying this bicep change, would it delete anything', 'azure_what_if_bicep'],
    ['the user approved the plan, apply the previewed deployment', 'azure_deploy_bicep'],
    ['did the deployment finish and what were its outputs', 'azure_get_deployment'],
    [
      'which specific resource operation failed inside that deployment',
      'azure_list_deployment_operations',
    ],
    ['redeploy the earlier revision, this made things worse', 'azure_rollback_deployment'],
  ];

  it.each(positive)('routes %j to %s', (query, expected) => {
    expect(topTool(query, tools)).toBe(expected);
  });

  const negative: readonly [string, string, string][] = [
    [
      'find every storage account tagged owner in westeurope',
      'azure_run_graph_query',
      'structured search must beat the raw query escape hatch',
    ],
    [
      'the virtual machine is deallocated, bring it back up',
      'azure_restart_virtual_machine',
      'starting a stopped machine is not a restart',
    ],
    [
      'recycle the app service site to clear a fault',
      'azure_restart_virtual_machine',
      'a site is not a virtual machine',
    ],
    [
      'the user approved the plan, apply the previewed deployment',
      'azure_rollback_deployment',
      'applying an approved plan is not a rollback',
    ],
    [
      'does my bicep compile and what resource types would it create',
      'azure_deploy_bicep',
      'validation must never be confused with deployment',
    ],
    [
      'did the deployment finish and what were its outputs',
      'azure_list_deployment_operations',
      'the cheap status call must win over the paginated detail call',
    ],
  ];

  it.each(negative)('keeps %j away from %s (%s)', (query, avoided, _why) => {
    const chosen = topTool(query, tools);
    expect(chosen).not.toBe(avoided);
    expect(rankOf(avoided, query, tools)).toBeGreaterThan(0);
  });

  it('ranks the deployment preview above the deployment itself when nothing is approved yet', () => {
    const query = 'what would deploying this bicep change, would it delete anything';
    expect(rankOf('azure_what_if_bicep', query, tools)).toBeLessThan(
      rankOf('azure_deploy_bicep', query, tools),
    );
  });
});
