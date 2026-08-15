import { z } from 'zod';
import { defineTool } from '../types.js';
import {
  limit,
  resourceGroup,
  resourceGroupSchema,
  resourceId,
  resourceSchema,
  skipToken,
  subscriptionId,
  subscriptionIds,
  subscriptionSchema,
} from '../schemas.js';

export const listSubscriptionsTool = defineTool({
  name: 'azure_list_subscriptions',
  title: 'List Azure subscriptions',
  summary: 'List the Azure subscriptions this server is allowed to see.',
  description:
    'Returns every Azure subscription visible to the server identity, filtered by the configured ' +
    'subscription allow-list. Each entry reports whether the read identity actually holds RBAC ' +
    'there (readable) and whether the separate deployment identity is configured for it ' +
    '(deployable), so you never plan work in a subscription the server cannot act on.',
  kind: 'read',
  routing: {
    useWhen: [
      'You do not yet know which subscription a resource lives in.',
      'You are about to plan a deployment and need to know which subscriptions are deployable.',
      'Someone names an environment ("prod", "sandbox") rather than a subscription id.',
    ],
    doNotUseWhen: [
      'You already have a fully qualified ARM resource id — use azure_get_resource instead.',
      'You need resource groups rather than subscriptions — use azure_list_resource_groups.',
      'You already hold an approved plan and a confirmationHash — apply it with azure_deploy_bicep.',
    ],
    requiredScope: 'None beyond the configured allow-list; this is the entry point.',
    changesState: false,
    nextSteps: ['azure_list_resource_groups', 'azure_search_resources'],
  },
  inputSchema: z.object({}).describe('No input.'),
  outputSchema: z.object({ subscriptions: z.array(subscriptionSchema) }),
  handler: async (_input, services) => ({
    subscriptions: [...(await services.inventory.listSubscriptions())],
  }),
});

export const listResourceGroupsTool = defineTool({
  name: 'azure_list_resource_groups',
  title: 'List resource groups',
  summary: 'List resource groups in a subscription.',
  description:
    'Lists the resource groups of a single subscription, filtered by the configured resource ' +
    'group allow-list. Use it to turn an environment name into a concrete, allowed resource ' +
    'group before searching or deploying.',
  kind: 'read',
  routing: {
    useWhen: [
      'You know the subscription and need the exact resource group name.',
      'You want to check whether a resource group is inside the configured allow-list.',
    ],
    doNotUseWhen: [
      'You want the resources themselves rather than the containers — use azure_search_resources.',
    ],
    requiredScope: 'Read access to the named subscription.',
    changesState: false,
    prerequisites: ['azure_list_subscriptions'],
    nextSteps: ['azure_search_resources'],
  },
  inputSchema: z.object({ subscriptionId }),
  outputSchema: z.object({ resourceGroups: z.array(resourceGroupSchema) }),
  handler: async (input, services) => ({
    resourceGroups: [...(await services.inventory.listResourceGroups(input.subscriptionId))],
  }),
});

export const searchResourcesTool = defineTool({
  name: 'azure_search_resources',
  title: 'Search Azure resources',
  summary: 'Find resources using structured filters (type, name, location, tag).',
  description:
    'Structured, safe search over Azure Resource Graph. The filters are compiled into an escaped ' +
    'query server-side, so user-supplied text can never alter the query shape. This is the ' +
    'default way to find a resource and the fastest route to a fully qualified ARM resource id. ' +
    'Resource Graph is eventually consistent and lags ARM by minutes, so a resource created very ' +
    'recently may not appear here yet.',
  kind: 'read',
  routing: {
    useWhen: [
      'You need to find resources by type, name substring, location or tag.',
      'You need the ARM resource id of something the user described in words.',
      'You want an inventory of a resource group or subscription.',
    ],
    doNotUseWhen: [
      'The question needs an aggregation — summarize, count or grouped totals across resource ' +
        'types — which filters cannot express; use azure_run_graph_query instead.',
      'You already have the exact ARM resource id — use azure_get_resource.',
      'You are checking whether a deployment you just ran succeeded — use azure_get_deployment, ' +
        'because a freshly created resource may not be indexed here yet.',
    ],
    requiredScope: 'Read access to the searched subscriptions.',
    changesState: false,
    prerequisites: ['azure_list_subscriptions'],
    nextSteps: ['azure_get_resource'],
  },
  inputSchema: z.object({
    subscriptionIds,
    resourceGroup: resourceGroup.optional(),
    resourceType: z
      .string()
      .max(200)
      .optional()
      .describe("ARM type, e.g. 'microsoft.web/sites' or 'microsoft.compute/virtualmachines'."),
    location: z.string().max(100).optional().describe("Azure region, e.g. 'westeurope'."),
    nameContains: z.string().max(200).optional().describe('Case-sensitive substring of the name.'),
    tagName: z.string().max(200).optional(),
    tagValue: z.string().max(500).optional(),
    limit,
    skipToken,
  }),
  outputSchema: z.object({
    resources: z.array(resourceSchema),
    totalRecords: z.number().optional(),
    skipToken: z.string().optional(),
    scope: z.array(z.string()),
  }),
  handler: async (input, services) => {
    const result = await services.inventory.searchResources({
      subscriptionIds: input.subscriptionIds,
      resourceGroup: input.resourceGroup,
      resourceType: input.resourceType,
      location: input.location,
      nameContains: input.nameContains,
      tagName: input.tagName,
      tagValue: input.tagValue,
      limit: input.limit,
      skipToken: input.skipToken,
    });
    return {
      resources: [...result.resources],
      ...(result.totalRecords === undefined ? {} : { totalRecords: result.totalRecords }),
      ...(result.skipToken === undefined ? {} : { skipToken: result.skipToken }),
      scope: [...result.scope],
    };
  },
});

export const getResourceTool = defineTool({
  name: 'azure_get_resource',
  title: 'Get a resource',
  summary: 'Fetch a single Azure resource, including its properties, by ARM resource id.',
  description:
    'Returns the full Resource Graph projection of one resource. This is the confirmation step ' +
    'before any diagnosis or change: it proves the ARM id exists, is inside the allow-list, and ' +
    'has the type the intended operation expects.',
  kind: 'read',
  routing: {
    useWhen: [
      'You hold a fully qualified ARM resource id and need its current configuration.',
      'You are about to diagnose or change a resource and must confirm its exact type first.',
    ],
    doNotUseWhen: [
      'You only have a name or a description — find the id with azure_search_resources first.',
      'You want time series behaviour — use azure_get_resource_metrics.',
    ],
    requiredScope: 'Read access to the subscription that contains the resource.',
    changesState: false,
    prerequisites: ['azure_search_resources'],
  },
  inputSchema: z.object({ resourceId }),
  outputSchema: z.object({ resource: resourceSchema }),
  handler: async (input, services) => ({
    resource: await services.inventory.getResource(input.resourceId),
  }),
});

export const runGraphQueryTool = defineTool({
  name: 'azure_run_graph_query',
  title: 'Run a Resource Graph aggregation query',
  summary: 'Execute a read-only Resource Graph (KQL) query to summarize or count resources.',
  description:
    'Escape hatch for questions structured search cannot express: summarize, count, group by, ' +
    'join or project across many resource types and subscriptions at once. The query runs ' +
    'read-only against the allow-listed subscriptions, and mutating or external-data KQL ' +
    'operators are rejected before the call is made.',
  kind: 'read',
  routing: {
    useWhen: [
      'You need an aggregation: summarize, count, grouped totals or a projection across types.',
      'The question spans many resource types or the whole tenant at once.',
      'azure_search_resources has already proven insufficient for this question.',
    ],
    doNotUseWhen: [
      'A type, name, location or tag filter would answer it — use azure_search_resources, which ' +
        'is safer and cheaper.',
      'You are tempted to write a query that changes data; Resource Graph is read-only and such ' +
        'queries are rejected.',
    ],
    requiredScope: 'Read access to the queried subscriptions.',
    changesState: false,
  },
  inputSchema: z.object({
    subscriptionIds,
    query: z
      .string()
      .min(1)
      .max(8000)
      .describe('Resource Graph KQL, e.g. "Resources | summarize count() by type".'),
    limit,
    skipToken,
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    totalRecords: z.number().optional(),
    skipToken: z.string().optional(),
    scope: z.array(z.string()),
  }),
  handler: async (input, services) => {
    const result = await services.inventory.runGraphQuery({
      subscriptionIds: input.subscriptionIds,
      query: input.query,
      limit: input.limit,
      skipToken: input.skipToken,
    });
    return {
      rows: [...result.rows],
      ...(result.totalRecords === undefined ? {} : { totalRecords: result.totalRecords }),
      ...(result.skipToken === undefined ? {} : { skipToken: result.skipToken }),
      scope: [...result.scope],
    };
  },
});
