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

/* ------------------------------------------------------------- deployments */

export type DeploymentScopeKind = 'resourceGroup' | 'subscription' | 'managementGroup' | 'tenant';

/**
 * A validated ARM deployment scope. Exactly the fields the scope kind requires are populated, and
 * `armScope` is the canonical ARM path the REST calls are issued against.
 */
export interface DeploymentScope {
  readonly kind: DeploymentScopeKind;
  readonly subscriptionId: string | undefined;
  readonly resourceGroup: string | undefined;
  readonly managementGroupId: string | undefined;
  /** Required by subscription, management group and tenant deployments. */
  readonly location: string | undefined;
  /** e.g. `/subscriptions/{id}/resourceGroups/{rg}` or `/` for tenant. */
  readonly armScope: string;
}

export interface ArmDeploymentRequest {
  readonly scope: DeploymentScope;
  readonly deploymentName: string;
  readonly template: Record<string, unknown>;
  /** ARM parameter object form: `{ name: { value } }`. */
  readonly parameters: Record<string, unknown>;
  readonly signal?: AbortSignal | undefined;
}

export interface ArmPropertyChange {
  readonly path: string;
  readonly propertyChangeType: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ArmWhatIfChange {
  readonly changeType: string;
  readonly resourceId: string;
  readonly unsupportedReason: string | undefined;
  readonly propertyChanges: readonly ArmPropertyChange[];
}

export interface ArmWhatIfResult {
  readonly status: string;
  readonly changes: readonly ArmWhatIfChange[];
  readonly error: { readonly code: string; readonly message: string } | undefined;
}

export interface ArmDeploymentStatus {
  readonly id: string;
  readonly name: string;
  readonly provisioningState: string;
  readonly correlationId: string | undefined;
  readonly timestamp: string | undefined;
  readonly duration: string | undefined;
  readonly outputs: Record<string, unknown> | undefined;
  readonly error: { readonly code: string; readonly message: string } | undefined;
}

export interface ArmDeploymentOperation {
  readonly operationId: string;
  readonly provisioningState: string | undefined;
  readonly timestamp: string | undefined;
  readonly duration: string | undefined;
  readonly resourceType: string | undefined;
  readonly resourceName: string | undefined;
  readonly targetResourceId: string | undefined;
  readonly statusCode: string | undefined;
  readonly statusMessage: string | undefined;
}

export interface ArmDeploymentOperationPage {
  readonly operations: readonly ArmDeploymentOperation[];
  readonly skipToken: string | undefined;
}

/** Effective permissions of the calling identity at an ARM scope. */
export interface EffectivePermission {
  readonly actions: readonly string[];
  readonly notActions: readonly string[];
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
  setResourceTags(
    resourceId: string,
    tags: Readonly<Record<string, string>>,
  ): Promise<AzureResource>;

  /**
   * Effective permissions of an identity at a scope. `identity` selects which configured managed
   * identity is asked: the read/operator identity or the separate deployment identity.
   */
  getEffectivePermissions(
    armScope: string,
    identity: 'operator' | 'deployment',
  ): Promise<readonly EffectivePermission[]>;

  whatIfDeployment(request: ArmDeploymentRequest): Promise<ArmWhatIfResult>;
  /** Starts the deployment and returns immediately; callers poll with {@link getDeployment}. */
  beginDeployment(request: ArmDeploymentRequest): Promise<ArmDeploymentStatus>;
  getDeployment(scope: DeploymentScope, deploymentName: string): Promise<ArmDeploymentStatus>;
  listDeploymentOperations(
    scope: DeploymentScope,
    deploymentName: string,
    options: { readonly top: number; readonly skipToken: string | undefined },
  ): Promise<ArmDeploymentOperationPage>;
}
