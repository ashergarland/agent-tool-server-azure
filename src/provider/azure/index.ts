import { ComputeManagementClient } from '@azure/arm-compute';
import { ResourceGraphClient } from '@azure/arm-resourcegraph';
import { ResourceManagementClient } from '@azure/arm-resources';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { MetricsQueryClient, type MetricValue } from '@azure/monitor-query';
import type { TokenCredential } from '@azure/core-auth';
import type { AppConfig } from '../../config/index.js';
import { AppError, notFound } from '../../errors.js';
import type {
  ActivityLogEntry,
  ActivityLogQueryInput,
  AzureProvider,
  AzureResource,
  MetricSeries,
  MetricsQueryInput,
  ResourceGraphPage,
  ResourceGraphQueryInput,
  ResourceGroup,
  ResourceRef,
  Subscription,
} from '../types.js';
import { ArmRestClient } from './arm-rest.js';
import { createAzureCredential } from './credential.js';
import { mapAzureError } from './errors.js';

const ACTIVITY_LOG_API_VERSION = '2015-04-01';

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asTags = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(asRecord(value))) {
    if (typeof tagValue === 'string') out[key] = tagValue;
  }
  return out;
};

export const subscriptionIdFromResourceId = (resourceId: string): string | undefined =>
  /\/subscriptions\/([^/]+)/i.exec(resourceId)?.[1];

export const resourceGroupFromResourceId = (resourceId: string): string | undefined =>
  /\/resourceGroups\/([^/]+)/i.exec(resourceId)?.[1];

const rowToResource = (row: Record<string, unknown>): AzureResource => {
  const id = asString(row['id']) ?? '';
  return {
    id,
    name: asString(row['name']) ?? '',
    type: asString(row['type']) ?? '',
    location: asString(row['location']),
    resourceGroup: asString(row['resourceGroup']) ?? resourceGroupFromResourceId(id),
    subscriptionId: asString(row['subscriptionId']) ?? subscriptionIdFromResourceId(id),
    kind: asString(row['kind']),
    sku: row['sku'] ?? undefined,
    tags: asTags(row['tags']),
    ...(row['properties'] === undefined ? {} : { properties: row['properties'] }),
  };
};

const metricValueFor = (
  point: MetricValue,
  aggregation: MetricsQueryInput['aggregation'],
): number | undefined => {
  switch (aggregation) {
    case 'Average':
      return point.average;
    case 'Minimum':
      return point.minimum;
    case 'Maximum':
      return point.maximum;
    case 'Total':
      return point.total;
    case 'Count':
      return point.count;
  }
};

interface ActivityLogResponse {
  value?: {
    eventTimestamp?: string;
    operationName?: { value?: string; localizedValue?: string };
    status?: { value?: string };
    subStatus?: { value?: string };
    level?: string;
    caller?: string;
    resourceId?: string;
    correlationId?: string;
    description?: string;
    properties?: Record<string, unknown>;
  }[];
}

/**
 * The Azure adapter. This is the only place in the codebase that knows about Azure SDK shapes;
 * everything above it consumes the {@link AzureProvider} port.
 */
export class AzureSdkProvider implements AzureProvider {
  private readonly computeClients = new Map<string, ComputeManagementClient>();
  private readonly webClients = new Map<string, WebSiteManagementClient>();
  private readonly resourceClients = new Map<string, ResourceManagementClient>();
  private readonly graphClient: ResourceGraphClient;
  private readonly metricsClient: MetricsQueryClient;
  private readonly armRest: ArmRestClient;

  public constructor(
    private readonly credential: TokenCredential,
    private readonly config: AppConfig,
  ) {
    this.graphClient = new ResourceGraphClient(this.credential);
    this.metricsClient = new MetricsQueryClient(this.credential);
    this.armRest = new ArmRestClient(
      this.credential,
      this.config.azure.armEndpoint,
      this.config.http.requestTimeoutMs,
    );
  }

  private compute(subscriptionId: string): ComputeManagementClient {
    let client = this.computeClients.get(subscriptionId);
    if (!client) {
      client = new ComputeManagementClient(this.credential, subscriptionId);
      this.computeClients.set(subscriptionId, client);
    }
    return client;
  }

  private web(subscriptionId: string): WebSiteManagementClient {
    let client = this.webClients.get(subscriptionId);
    if (!client) {
      client = new WebSiteManagementClient(this.credential, subscriptionId);
      this.webClients.set(subscriptionId, client);
    }
    return client;
  }

  private resources(subscriptionId: string): ResourceManagementClient {
    let client = this.resourceClients.get(subscriptionId);
    if (!client) {
      client = new ResourceManagementClient(this.credential, subscriptionId);
      this.resourceClients.set(subscriptionId, client);
    }
    return client;
  }

  public async listSubscriptions(): Promise<readonly Subscription[]> {
    const page = await this.queryResourceGraph({
      subscriptionIds: [],
      query: [
        'ResourceContainers',
        "| where type =~ 'microsoft.resources/subscriptions'",
        '| project subscriptionId, name, tenantId, state = tostring(properties.state)',
        '| order by name asc',
      ].join(' '),
      top: 1000,
    });

    return page.rows.map((row) => ({
      subscriptionId: asString(row['subscriptionId']) ?? '',
      displayName: asString(row['name']) ?? '',
      state: asString(row['state']) ?? 'Unknown',
      tenantId: asString(row['tenantId']),
    }));
  }

  public async listResourceGroups(subscriptionId: string): Promise<readonly ResourceGroup[]> {
    try {
      const groups: ResourceGroup[] = [];
      for await (const group of this.resources(subscriptionId).resourceGroups.list()) {
        groups.push({
          id: group.id ?? '',
          name: group.name ?? '',
          location: group.location,
          provisioningState: group.properties?.provisioningState,
          tags: asTags(group.tags),
        });
      }
      return groups;
    } catch (error) {
      throw mapAzureError(error, `list resource groups in subscription ${subscriptionId}`);
    }
  }

  public async getResourceById(resourceId: string): Promise<AzureResource> {
    const subscriptionId = subscriptionIdFromResourceId(resourceId);
    const page = await this.queryResourceGraph({
      subscriptionIds: subscriptionId ? [subscriptionId] : [],
      query: [
        'Resources',
        '| where id =~ @resourceId',
        '| project id, name, type, location, resourceGroup, subscriptionId, kind, sku, tags, properties',
      ]
        .join(' ')
        .replace('@resourceId', `'${escapeKqlString(resourceId)}'`),
      top: 1,
    });

    const row = page.rows[0];
    if (!row) throw notFound(`Resource not found or not visible to the connector: ${resourceId}`);
    return rowToResource(row);
  }

  public async queryResourceGraph(input: ResourceGraphQueryInput): Promise<ResourceGraphPage> {
    try {
      const response = await this.graphClient.resources({
        ...(input.subscriptionIds.length > 0 ? { subscriptions: [...input.subscriptionIds] } : {}),
        query: input.query,
        options: {
          top: input.top,
          resultFormat: 'objectArray',
          ...(input.skipToken ? { skipToken: input.skipToken } : {}),
        },
      });

      const data: unknown = response.data;
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      return {
        rows,
        totalRecords: response.totalRecords,
        skipToken: response.skipToken,
      };
    } catch (error) {
      throw mapAzureError(error, 'Resource Graph query');
    }
  }

  public async listActivityLog(input: ActivityLogQueryInput): Promise<readonly ActivityLogEntry[]> {
    const filters = [
      `eventTimestamp ge '${input.since.toISOString()}'`,
      `eventTimestamp le '${input.until.toISOString()}'`,
    ];
    if (input.resourceId) filters.push(`resourceUri eq '${input.resourceId}'`);
    else if (input.resourceGroup) filters.push(`resourceGroupName eq '${input.resourceGroup}'`);

    const response = await this.armRest.get<ActivityLogResponse>(
      `subscriptions/${encodeURIComponent(input.subscriptionId)}/providers/Microsoft.Insights/eventtypes/management/values`,
      {
        query: {
          'api-version': ACTIVITY_LOG_API_VERSION,
          $filter: filters.join(' and '),
          $top: input.top,
        },
      },
    );

    return (response.value ?? []).slice(0, input.top).map((entry) => ({
      eventTimestamp: entry.eventTimestamp,
      operationName: entry.operationName?.localizedValue ?? entry.operationName?.value,
      status: entry.status?.value,
      subStatus: entry.subStatus?.value,
      level: entry.level,
      caller: entry.caller,
      resourceId: entry.resourceId,
      correlationId: entry.correlationId,
      description: entry.description,
    }));
  }

  public async listMetrics(input: MetricsQueryInput): Promise<readonly MetricSeries[]> {
    try {
      const result = await this.metricsClient.queryResource(
        input.resourceId,
        [...input.metricNames],
        {
          timespan: { startTime: input.since, endTime: input.until },
          granularity: input.intervalIso8601,
          aggregations: [input.aggregation],
        },
      );

      return result.metrics.map((metric) => ({
        name: metric.name,
        unit: metric.unit,
        aggregation: input.aggregation,
        dataPoints: (metric.timeseries[0]?.data ?? []).map((point) => ({
          timestamp: point.timeStamp.toISOString(),
          value: metricValueFor(point, input.aggregation),
        })),
      }));
    } catch (error) {
      throw mapAzureError(error, `metrics query for ${input.resourceId}`);
    }
  }

  public async restartVirtualMachine(ref: ResourceRef): Promise<void> {
    try {
      const poller = this.compute(ref.subscriptionId).virtualMachines.restart(
        ref.resourceGroup,
        ref.name,
      );
      await poller.pollUntilDone();
    } catch (error) {
      throw mapAzureError(error, `restart virtual machine ${ref.name}`);
    }
  }

  public async startVirtualMachine(ref: ResourceRef): Promise<void> {
    try {
      const poller = this.compute(ref.subscriptionId).virtualMachines.start(
        ref.resourceGroup,
        ref.name,
      );
      await poller.pollUntilDone();
    } catch (error) {
      throw mapAzureError(error, `start virtual machine ${ref.name}`);
    }
  }

  public async restartWebApp(ref: ResourceRef): Promise<void> {
    try {
      await this.web(ref.subscriptionId).webApps.restart(ref.resourceGroup, ref.name);
    } catch (error) {
      throw mapAzureError(error, `restart web app ${ref.name}`);
    }
  }

  public async setResourceTags(
    resourceId: string,
    tags: Readonly<Record<string, string>>,
  ): Promise<AzureResource> {
    const subscriptionId = subscriptionIdFromResourceId(resourceId);
    if (!subscriptionId) {
      throw new AppError(
        'bad_request',
        `Resource id is missing a subscription segment: ${resourceId}`,
      );
    }

    try {
      const poller = this.resources(subscriptionId).tagsOperations.updateAtScope(resourceId, {
        operation: 'Merge',
        properties: { tags: { ...tags } },
      });
      await poller.pollUntilDone();
    } catch (error) {
      throw mapAzureError(error, `update tags on ${resourceId}`);
    }

    return this.getResourceById(resourceId);
  }
}

/** Escape a value that will be embedded inside a single-quoted KQL string literal. */
export const escapeKqlString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const createAzureProvider = (config: AppConfig): AzureProvider =>
  new AzureSdkProvider(createAzureCredential(config), config);
