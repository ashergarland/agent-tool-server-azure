/**
 * The provider port. Services depend on this interface only, which keeps Azure SDK types out of
 * the business layer and makes the whole tool surface testable with a fake provider.
 */

export interface Subscription {
  readonly subscriptionId: string;
  readonly displayName: string;
  readonly state: string;
  readonly tenantId: string | undefined;
}

export interface ResourceGroup {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly provisioningState: string | undefined;
  readonly tags: Readonly<Record<string, string>>;
}

export interface AzureResource {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly location: string | undefined;
  readonly resourceGroup: string | undefined;
  readonly subscriptionId: string | undefined;
  readonly kind: string | undefined;
  readonly sku: unknown;
  readonly tags: Readonly<Record<string, string>>;
  readonly properties?: unknown;
}

export interface ResourceGraphPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly totalRecords: number | undefined;
  readonly skipToken: string | undefined;
}

export interface ActivityLogEntry {
  readonly eventTimestamp: string | undefined;
  readonly operationName: string | undefined;
  readonly status: string | undefined;
  readonly subStatus: string | undefined;
  readonly level: string | undefined;
  readonly caller: string | undefined;
  readonly resourceId: string | undefined;
  readonly correlationId: string | undefined;
  readonly description: string | undefined;
}

export interface MetricDataPoint {
  readonly timestamp: string;
  readonly value: number | undefined;
}

export interface MetricSeries {
  readonly name: string;
  readonly unit: string | undefined;
  readonly aggregation: string;
  readonly dataPoints: readonly MetricDataPoint[];
}

export interface ResourceGraphQueryInput {
  readonly subscriptionIds: readonly string[];
  readonly query: string;
  readonly top: number;
  readonly skipToken?: string;
}

export interface ActivityLogQueryInput {
  readonly subscriptionId: string;
  readonly since: Date;
  readonly until: Date;
  readonly resourceGroup?: string;
  readonly resourceId?: string;
  readonly top: number;
}

export interface MetricsQueryInput {
  readonly resourceId: string;
  readonly metricNames: readonly string[];
  readonly since: Date;
  readonly until: Date;
  readonly intervalIso8601: string;
  readonly aggregation: 'Average' | 'Minimum' | 'Maximum' | 'Total' | 'Count';
}

export interface ResourceRef {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly name: string;
}

export interface AzureProvider {
  listSubscriptions(): Promise<readonly Subscription[]>;
  listResourceGroups(subscriptionId: string): Promise<readonly ResourceGroup[]>;
  getResourceById(resourceId: string): Promise<AzureResource>;
  queryResourceGraph(input: ResourceGraphQueryInput): Promise<ResourceGraphPage>;
  listActivityLog(input: ActivityLogQueryInput): Promise<readonly ActivityLogEntry[]>;
  listMetrics(input: MetricsQueryInput): Promise<readonly MetricSeries[]>;

  restartVirtualMachine(ref: ResourceRef): Promise<void>;
  startVirtualMachine(ref: ResourceRef): Promise<void>;
  restartWebApp(ref: ResourceRef): Promise<void>;
  setResourceTags(resourceId: string, tags: Readonly<Record<string, string>>): Promise<AzureResource>;
}
