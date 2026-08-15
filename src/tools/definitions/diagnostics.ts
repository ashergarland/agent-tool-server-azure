import { z } from 'zod';
import { defineTool } from '../types.js';
import { limit, resourceGroup, resourceId, subscriptionId, subscriptionIds } from '../schemas.js';

export const getActivityLogTool = defineTool({
  name: 'azure_get_activity_log',
  title: 'Read the activity log',
  summary: 'Read recent control-plane activity log events for a subscription or resource.',
  description:
    'Answers "what changed recently, and who changed it?". Returns Azure Activity Log management ' +
    'events, narrowed to a resource group or a single resource when supplied. This is the first ' +
    'thing to check when something worked yesterday and does not work today.',
  kind: 'read',
  routing: {
    useWhen: [
      'A resource regressed and you need to know what control-plane change preceded it.',
      'You need the caller, correlation id or status of a recent Azure operation.',
      'You want to confirm that a deployment or restart you performed actually landed.',
    ],
    doNotUseWhen: [
      'You need performance or utilisation over time — use azure_get_resource_metrics.',
      'You want to know whether Azure itself is degraded — use azure_list_unhealthy_resources.',
    ],
    requiredScope: 'Read access to the subscription; a resource id must be inside the allow-list.',
    changesState: false,
    prerequisites: ['azure_get_resource'],
  },
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
    'Returns aggregated Azure Monitor data points for one resource, for example CpuPercentage on ' +
    'an App Service or "Percentage CPU" on a virtual machine. Use it to turn "it feels slow" into ' +
    'a measured statement before proposing any change.',
  kind: 'read',
  routing: {
    useWhen: [
      'You need utilisation, latency, throughput or error counts over a time window.',
      'You want evidence that a restart or deployment improved or worsened behaviour.',
    ],
    doNotUseWhen: [
      'You need the configuration of the resource — use azure_get_resource.',
      'You need to know who changed something — use azure_get_activity_log.',
    ],
    requiredScope: 'Read access to the subscription containing the resource.',
    changesState: false,
    prerequisites: ['azure_get_resource'],
  },
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
    'Triage entry point for an incident: returns every resource whose Azure Resource Health ' +
    'availability state is anything other than Available, with the summary Azure reported. Check ' +
    'this before blaming your own change — a platform fault needs a different response.',
  kind: 'read',
  routing: {
    useWhen: [
      'An outage or incident has been reported and you do not yet know the blast radius.',
      'You want to separate a platform-side fault from an application-side regression.',
    ],
    doNotUseWhen: [
      'You already know the specific resource and want its history — use azure_get_activity_log.',
      'Nothing is reported as broken and you are doing routine inventory — use ' +
        'azure_search_resources.',
    ],
    requiredScope: 'Read access to the searched subscriptions.',
    changesState: false,
    nextSteps: ['azure_get_activity_log', 'azure_get_resource_metrics'],
  },
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
