import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  /** One-line description surfaced in tool listings and the OpenAPI summary. */
  readonly summary: string;
  /** Full description used by the model to decide when the tool applies. */
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

/** Identity helper that preserves the concrete schema types when declaring a tool. */
const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

const subscriptionId = z
  .string()
  .regex(/^[0-9a-fA-F-]{36}$/, 'must be an Azure subscription GUID')
  .describe('Azure subscription id (GUID).');

const subscriptionIds = z
  .array(subscriptionId)
  .max(50)
  .default([])
  .describe('Subscriptions to target. Defaults to every subscription the connector is scoped to.');

const resourceId = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'Fully qualified ARM resource id, e.g. /subscriptions/.../providers/Microsoft.Web/sites/app',
  );

const resourceGroup = z.string().min(1).max(90).describe('Resource group name.');

const limit = z.number().int().min(1).max(1000).default(100).describe('Maximum rows to return.');

const skipToken = z
  .string()
  .min(1)
  .optional()
  .describe('Continuation token returned by a previous call.');

const mutationFields = {
  confirm: z
    .boolean()
    .default(false)
    .describe('Must be true to actually perform the change; the user has to explicitly agree.'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('When true, validate and report what would happen without changing anything.'),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('Short human-readable justification recorded in the audit log.'),
};

/* ------------------------------------------------------------------ schemas */

const subscriptionSchema = z.object({
  subscriptionId: z.string(),
  displayName: z.string(),
  state: z.string(),
  tenantId: z.string().optional(),
});

const resourceGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  provisioningState: z.string().optional(),
  tags: z.record(z.string(), z.string()),
});

const resourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  location: z.string().optional(),
  resourceGroup: z.string().optional(),
  subscriptionId: z.string().optional(),
  kind: z.string().optional(),
  sku: z.unknown().optional(),
  tags: z.record(z.string(), z.string()),
  properties: z.unknown().optional(),
});

const operationResultSchema = z.object({
  action: z.string(),
  resourceId: z.string(),
  performed: z.boolean(),
  dryRun: z.boolean(),
  message: z.string(),
});

/* -------------------------------------------------------------------- tools */

export const listSubscriptionsTool = defineTool({
  name: 'azure_list_subscriptions',
  title: 'List Azure subscriptions',
  summary: 'List the Azure subscriptions this connector is allowed to see.',
  description:
    'Returns every Azure subscription visible to the connector identity, filtered by the ' +
    'configured subscription allow-list. Start here when you do not yet know which subscription ' +
    'a resource lives in.',
  kind: 'read',
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
    'group allow-list.',
  kind: 'read',
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
    'Structured, safe search over Azure Resource Graph. Prefer this over azure_run_graph_query ' +
    'whenever the question can be expressed with these filters.',
  kind: 'read',
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
    'Returns the full Resource Graph projection of one resource. Use it to inspect configuration ' +
    'before diagnosing or acting on a resource.',
  kind: 'read',
  inputSchema: z.object({ resourceId }),
  outputSchema: z.object({ resource: resourceSchema }),
  handler: async (input, services) => ({
    resource: await services.inventory.getResource(input.resourceId),
  }),
});

export const runGraphQueryTool = defineTool({
  name: 'azure_run_graph_query',
  title: 'Run a Resource Graph query',
  summary: 'Execute a read-only Azure Resource Graph (KQL) query.',
  description:
    'Escape hatch for questions that structured search cannot express. The query is executed ' +
    'read-only against the allow-listed subscriptions; mutating KQL operators are rejected.',
  kind: 'read',
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

export const getActivityLogTool = defineTool({
  name: 'azure_get_activity_log',
  title: 'Read the activity log',
  summary: 'Read recent control-plane activity log events for a subscription or resource.',
  description:
    'Answers "what changed recently?". Returns Azure Activity Log management events ordered by ' +
    'the service, narrowed to a resource group or resource when supplied.',
  kind: 'read',
  inputSchema: z.object({
    subscriptionId,
    resourceGroup: resourceGroup.optional(),
    resourceId: resourceId.optional(),
    lookbackHours: z.number().int().min(1).max(168).default(24),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  outputSchema: z.object({
    events: z.array(
      z.object({
        eventTimestamp: z.string().optional(),
        operationName: z.string().optional(),
        status: z.string().optional(),
        subStatus: z.string().optional(),
        level: z.string().optional(),
        caller: z.string().optional(),
        resourceId: z.string().optional(),
        correlationId: z.string().optional(),
        description: z.string().optional(),
      }),
    ),
  }),
  handler: async (input, services) => ({
    events: [
      ...(await services.diagnostics.getActivityLog({
        subscriptionId: input.subscriptionId,
        resourceGroup: input.resourceGroup,
        resourceId: input.resourceId,
        lookbackHours: input.lookbackHours,
        limit: input.limit,
      })),
    ],
  }),
});

export const getMetricsTool = defineTool({
  name: 'azure_get_resource_metrics',
  title: 'Read resource metrics',
  summary: 'Read Azure Monitor metric time series for a resource.',
  description:
    'Returns aggregated metric data points for one resource, e.g. CpuPercentage for an App ' +
    'Service or "Percentage CPU" for a virtual machine.',
  kind: 'read',
  inputSchema: z.object({
    resourceId,
    metricNames: z.array(z.string().min(1).max(200)).min(1).max(10),
    lookbackHours: z.number().int().min(1).max(168).default(6),
    interval: z
      .string()
      .regex(/^P(T.+|\d+D.*)$/, 'must be an ISO-8601 duration such as PT5M or PT1H')
      .default('PT5M'),
    aggregation: z.enum(['Average', 'Minimum', 'Maximum', 'Total', 'Count']).default('Average'),
  }),
  outputSchema: z.object({
    resourceId: z.string(),
    timespan: z.object({ start: z.string(), end: z.string() }),
    series: z.array(
      z.object({
        name: z.string(),
        unit: z.string().optional(),
        aggregation: z.string(),
        dataPoints: z.array(z.object({ timestamp: z.string(), value: z.number().optional() })),
      }),
    ),
  }),
  handler: async (input, services) => {
    const result = await services.diagnostics.getMetrics({
      resourceId: input.resourceId,
      metricNames: input.metricNames,
      lookbackHours: input.lookbackHours,
      intervalIso8601: input.interval,
      aggregation: input.aggregation,
    });
    return {
      resourceId: result.resourceId,
      timespan: result.timespan,
      series: result.series.map((entry) => ({
        name: entry.name,
        ...(entry.unit === undefined ? {} : { unit: entry.unit }),
        aggregation: entry.aggregation,
        dataPoints: entry.dataPoints.map((point) => ({
          timestamp: point.timestamp,
          ...(point.value === undefined ? {} : { value: point.value }),
        })),
      })),
    };
  },
});

export const getUnhealthyResourcesTool = defineTool({
  name: 'azure_list_unhealthy_resources',
  title: 'List unhealthy resources',
  summary: 'List resources that Azure Resource Health currently reports as not available.',
  description:
    'Triage entry point for incidents: returns resources whose availability state is anything ' +
    'other than Available, with the reported summary.',
  kind: 'read',
  inputSchema: z.object({
    subscriptionIds,
    resourceGroup: resourceGroup.optional(),
    limit,
  }),
  outputSchema: z.object({
    unhealthyResources: z.array(
      z.object({
        resourceId: z.string(),
        availabilityState: z.string(),
        summary: z.string().optional(),
        reportedTime: z.string().optional(),
      }),
    ),
  }),
  handler: async (input, services) => ({
    unhealthyResources: [
      ...(await services.diagnostics.getUnhealthyResources({
        subscriptionIds: input.subscriptionIds,
        resourceGroup: input.resourceGroup,
        limit: input.limit,
      })),
    ],
  }),
});

export const restartVirtualMachineTool = defineTool({
  name: 'azure_restart_virtual_machine',
  title: 'Restart a virtual machine',
  summary: 'Restart an Azure virtual machine (state-changing).',
  description:
    'Restarts a virtual machine. Requires confirm=true and a connector deployed with mutations ' +
    'enabled. Always preview with dryRun=true first.',
  kind: 'write',
  inputSchema: z.object({ resourceId, ...mutationFields }),
  outputSchema: operationResultSchema,
  handler: (input, services) =>
    services.operations.restartVirtualMachine({
      resourceId: input.resourceId,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
    }),
});

export const startVirtualMachineTool = defineTool({
  name: 'azure_start_virtual_machine',
  title: 'Start a virtual machine',
  summary: 'Start a stopped or deallocated Azure virtual machine (state-changing).',
  description:
    'Starts a virtual machine. Requires confirm=true and a connector deployed with mutations ' +
    'enabled.',
  kind: 'write',
  inputSchema: z.object({ resourceId, ...mutationFields }),
  outputSchema: operationResultSchema,
  handler: (input, services) =>
    services.operations.startVirtualMachine({
      resourceId: input.resourceId,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
    }),
});

export const restartWebAppTool = defineTool({
  name: 'azure_restart_web_app',
  title: 'Restart an App Service app',
  summary: 'Restart an Azure App Service / Function App (state-changing).',
  description:
    'Restarts a Microsoft.Web/sites resource. Requires confirm=true and a connector deployed ' +
    'with mutations enabled.',
  kind: 'write',
  inputSchema: z.object({ resourceId, ...mutationFields }),
  outputSchema: operationResultSchema,
  handler: (input, services) =>
    services.operations.restartWebApp({
      resourceId: input.resourceId,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
    }),
});

export const tagResourceTool = defineTool({
  name: 'azure_tag_resource',
  title: 'Tag a resource',
  summary: 'Merge tags onto an Azure resource (state-changing).',
  description:
    'Merges the supplied tags onto a resource, leaving existing tags untouched. Requires ' +
    'confirm=true and a connector deployed with mutations enabled.',
  kind: 'write',
  inputSchema: z.object({
    resourceId,
    tags: z.record(z.string().min(1).max(512), z.string().max(256)),
    ...mutationFields,
  }),
  outputSchema: operationResultSchema.extend({ resource: resourceSchema.optional() }),
  handler: async (input, services) => {
    const result = await services.operations.tagResource({
      resourceId: input.resourceId,
      tags: input.tags,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
    });
    return {
      action: result.action,
      resourceId: result.resourceId,
      performed: result.performed,
      dryRun: result.dryRun,
      message: result.message,
      ...(result.resource === undefined ? {} : { resource: result.resource }),
    };
  },
});

export const toolDefinitions = [
  listSubscriptionsTool,
  listResourceGroupsTool,
  searchResourcesTool,
  getResourceTool,
  runGraphQueryTool,
  getActivityLogTool,
  getMetricsTool,
  getUnhealthyResourcesTool,
  restartVirtualMachineTool,
  startVirtualMachineTool,
  restartWebAppTool,
  tagResourceTool,
] as const satisfies readonly ToolDefinition[];
