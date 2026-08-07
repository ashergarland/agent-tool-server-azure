import type { ActivityLogEntry, AzureProvider, MetricSeries } from '../provider/types.js';
import { escapeKqlString, subscriptionIdFromResourceId } from '../provider/azure/index.js';
import { badRequest } from '../errors.js';
import type { Guardrails } from './guardrails.js';

export interface ActivityLogInput {
  readonly subscriptionId: string;
  readonly resourceGroup?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly lookbackHours: number;
  readonly limit: number;
}

export interface MetricsInput {
  readonly resourceId: string;
  readonly metricNames: readonly string[];
  readonly lookbackHours: number;
  readonly intervalIso8601: string;
  readonly aggregation: 'Average' | 'Minimum' | 'Maximum' | 'Total' | 'Count';
}

export interface MetricsResult {
  readonly resourceId: string;
  readonly timespan: { readonly start: string; readonly end: string };
  readonly series: readonly MetricSeries[];
}

export interface HealthEvent {
  readonly resourceId: string;
  readonly availabilityState: string;
  readonly summary: string | undefined;
  readonly reportedTime: string | undefined;
}

/**
 * Diagnostic reads: "what changed?", "how is it behaving?", "is it healthy?".
 */
export class DiagnosticsService {
  public constructor(
    private readonly provider: AzureProvider,
    private readonly guardrails: Guardrails,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getActivityLog(input: ActivityLogInput): Promise<readonly ActivityLogEntry[]> {
    this.guardrails.assertSubscriptionAllowed(input.subscriptionId);
    if (input.resourceGroup) this.guardrails.assertResourceGroupAllowed(input.resourceGroup);
    if (input.resourceId) this.guardrails.assertResourceIdInScope(input.resourceId);

    const until = this.now();
    const since = new Date(until.getTime() - input.lookbackHours * 3_600_000);

    return this.provider.listActivityLog({
      subscriptionId: input.subscriptionId,
      since,
      until,
      ...(input.resourceGroup ? { resourceGroup: input.resourceGroup } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      top: input.limit,
    });
  }

  public async getMetrics(input: MetricsInput): Promise<MetricsResult> {
    this.guardrails.assertResourceIdInScope(input.resourceId);
    if (input.metricNames.length === 0) {
      throw badRequest('At least one metric name is required');
    }

    const until = this.now();
    const since = new Date(until.getTime() - input.lookbackHours * 3_600_000);

    const series = await this.provider.listMetrics({
      resourceId: input.resourceId,
      metricNames: input.metricNames,
      since,
      until,
      intervalIso8601: input.intervalIso8601,
      aggregation: input.aggregation,
    });

    return {
      resourceId: input.resourceId,
      timespan: { start: since.toISOString(), end: until.toISOString() },
      series,
    };
  }

  /**
   * Resource Health snapshot from the Resource Graph `healthresources` table. Returns only
   * resources that Azure currently reports as anything other than Available.
   */
  public async getUnhealthyResources(input: {
    readonly subscriptionIds: readonly string[];
    readonly resourceGroup?: string | undefined;
    readonly limit: number;
  }): Promise<readonly HealthEvent[]> {
    const scope = this.guardrails.resolveSubscriptionScope(input.subscriptionIds);
    if (input.resourceGroup) this.guardrails.assertResourceGroupAllowed(input.resourceGroup);

    const clauses = [
      'healthresources',
      "| where type =~ 'microsoft.resourcehealth/availabilitystatuses'",
      '| extend targetResourceId = tolower(tostring(properties.targetResourceId))',
      '| extend availabilityState = tostring(properties.availabilityState)',
      '| extend summary = tostring(properties.summary)',
      // Resource Health exposes this as `occurredTime`; older payloads carry the misspelled
      // `occuredTime`, so accept either rather than silently reporting an empty timestamp.
      '| extend reportedTime = tostring(coalesce(properties.occurredTime, properties.occuredTime))',
      "| where availabilityState !~ 'Available'",
    ];
    if (input.resourceGroup) {
      clauses.push(`| where resourceGroup =~ '${escapeKqlString(input.resourceGroup)}'`);
    }
    clauses.push('| project targetResourceId, availabilityState, summary, reportedTime');

    const page = await this.provider.queryResourceGraph({
      subscriptionIds: scope,
      query: clauses.join(' '),
      top: input.limit,
    });

    return page.rows.map((row) => ({
      resourceId: typeof row['targetResourceId'] === 'string' ? row['targetResourceId'] : '',
      availabilityState:
        typeof row['availabilityState'] === 'string' ? row['availabilityState'] : 'Unknown',
      summary: typeof row['summary'] === 'string' ? row['summary'] : undefined,
      reportedTime: typeof row['reportedTime'] === 'string' ? row['reportedTime'] : undefined,
    }));
  }

  public subscriptionForResource(resourceId: string): string {
    const subscriptionId = subscriptionIdFromResourceId(resourceId);
    if (!subscriptionId) throw badRequest(`Resource id has no subscription segment: ${resourceId}`);
    return subscriptionId;
  }
}
