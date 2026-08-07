import type { AzureProvider, AzureResource, ResourceGroup, Subscription } from '../provider/types.js';
import { escapeKqlString } from '../provider/azure/index.js';
import type { Guardrails } from './guardrails.js';

export interface ResourceSearchInput {
  readonly subscriptionIds: readonly string[];
  readonly resourceGroup?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly location?: string | undefined;
  readonly nameContains?: string | undefined;
  readonly tagName?: string | undefined;
  readonly tagValue?: string | undefined;
  readonly limit: number;
  readonly skipToken?: string | undefined;
}

export interface ResourceSearchResult {
  readonly resources: readonly AzureResource[];
  readonly totalRecords: number | undefined;
  readonly skipToken: string | undefined;
  readonly scope: readonly string[];
}

export interface RawGraphQueryInput {
  readonly subscriptionIds: readonly string[];
  readonly query: string;
  readonly limit: number;
  readonly skipToken?: string | undefined;
}

export interface RawGraphQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly totalRecords: number | undefined;
  readonly skipToken: string | undefined;
  readonly scope: readonly string[];
}

const PROJECTION =
  '| project id, name, type, location, resourceGroup, subscriptionId, kind, sku, tags';

/**
 * Read-only inventory questions ("what exists in my environment?"). Structured search is expressed
 * as a generated KQL query so that user-supplied values are never concatenated unescaped.
 */
export class InventoryService {
  public constructor(
    private readonly provider: AzureProvider,
    private readonly guardrails: Guardrails,
  ) {}

  public async listSubscriptions(): Promise<readonly Subscription[]> {
    const subscriptions = await this.provider.listSubscriptions();
    const allowed = this.guardrails.allowedSubscriptionIds;
    if (allowed.length === 0) return subscriptions;
    return subscriptions.filter((subscription) =>
      allowed.includes(subscription.subscriptionId.toLowerCase()),
    );
  }

  public async listResourceGroups(subscriptionId: string): Promise<readonly ResourceGroup[]> {
    this.guardrails.assertSubscriptionAllowed(subscriptionId);
    const groups = await this.provider.listResourceGroups(subscriptionId);
    const allowed = this.guardrails.allowedResourceGroups;
    if (allowed.length === 0) return groups;
    return groups.filter((group) => allowed.includes(group.name.toLowerCase()));
  }

  public async getResource(resourceId: string): Promise<AzureResource> {
    this.guardrails.assertResourceIdInScope(resourceId);
    return this.provider.getResourceById(resourceId);
  }

  public async searchResources(input: ResourceSearchInput): Promise<ResourceSearchResult> {
    const scope = this.guardrails.resolveSubscriptionScope(input.subscriptionIds);
    if (input.resourceGroup) this.guardrails.assertResourceGroupAllowed(input.resourceGroup);

    const clauses = ['Resources'];
    const allowedGroups = this.guardrails.allowedResourceGroups;
    if (input.resourceGroup) {
      clauses.push(`| where resourceGroup =~ '${escapeKqlString(input.resourceGroup)}'`);
    } else if (allowedGroups.length > 0) {
      const list = allowedGroups.map((name) => `'${escapeKqlString(name)}'`).join(', ');
      clauses.push(`| where tolower(resourceGroup) in (${list})`);
    }
    if (input.resourceType) {
      clauses.push(`| where type =~ '${escapeKqlString(input.resourceType)}'`);
    }
    if (input.location) {
      clauses.push(`| where location =~ '${escapeKqlString(input.location)}'`);
    }
    if (input.nameContains) {
      clauses.push(`| where name contains '${escapeKqlString(input.nameContains)}'`);
    }
    if (input.tagName) {
      const tagName = escapeKqlString(input.tagName);
      clauses.push(
        input.tagValue === undefined
          ? `| where isnotempty(tags['${tagName}'])`
          : `| where tags['${tagName}'] =~ '${escapeKqlString(input.tagValue)}'`,
      );
    }
    clauses.push(PROJECTION, '| order by name asc');

    const page = await this.provider.queryResourceGraph({
      subscriptionIds: scope,
      query: clauses.join(' '),
      top: input.limit,
      ...(input.skipToken ? { skipToken: input.skipToken } : {}),
    });

    return {
      resources: page.rows.map(toResource),
      totalRecords: page.totalRecords,
      skipToken: page.skipToken,
      scope,
    };
  }

  public async runGraphQuery(input: RawGraphQueryInput): Promise<RawGraphQueryResult> {
    this.guardrails.assertReadOnlyQuery(input.query);
    const scope = this.guardrails.resolveSubscriptionScope(input.subscriptionIds);

    const page = await this.provider.queryResourceGraph({
      subscriptionIds: scope,
      query: input.query,
      top: input.limit,
      ...(input.skipToken ? { skipToken: input.skipToken } : {}),
    });

    return {
      rows: page.rows,
      totalRecords: page.totalRecords,
      skipToken: page.skipToken,
      scope,
    };
  }
}

const toResource = (row: Record<string, unknown>): AzureResource => ({
  id: typeof row['id'] === 'string' ? row['id'] : '',
  name: typeof row['name'] === 'string' ? row['name'] : '',
  type: typeof row['type'] === 'string' ? row['type'] : '',
  location: typeof row['location'] === 'string' ? row['location'] : undefined,
  resourceGroup: typeof row['resourceGroup'] === 'string' ? row['resourceGroup'] : undefined,
  subscriptionId: typeof row['subscriptionId'] === 'string' ? row['subscriptionId'] : undefined,
  kind: typeof row['kind'] === 'string' ? row['kind'] : undefined,
  sku: row['sku'],
  tags:
    typeof row['tags'] === 'object' && row['tags'] !== null
      ? (row['tags'] as Record<string, string>)
      : {},
});
