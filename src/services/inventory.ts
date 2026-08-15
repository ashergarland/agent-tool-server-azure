import type {
  AzureProvider,
  AzureResource,
  ResourceGroup,
  Subscription,
} from '../provider/types.js';
import { escapeKqlString } from '../provider/azure/index.js';
import type { AppConfig } from '../config/index.js';
import type { Guardrails } from './guardrails.js';

/** A subscription plus what the server's identities can actually do in it. */
export interface SubscriptionCapability extends Subscription {
  readonly readable: boolean;
  readonly deployable: boolean;
}

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

const READ_ACTION = 'Microsoft.Resources/subscriptions/resourceGroups/read';
const DEPLOY_ACTION = 'Microsoft.Resources/deployments/write';

/** ARM permission strings support a trailing `*` wildcard on each segment. */
const matchesAction = (pattern: string, action: string): boolean => {
  if (pattern === '*') return true;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(action);
};

/**
 * Read-only inventory questions ("what exists in my environment?"). Structured search is expressed
 * as a generated KQL query so that user-supplied values are never concatenated unescaped.
 */
export class InventoryService {
  private readonly permissionCache = new Map<string, { value: boolean; expiresAt: number }>();

  public constructor(
    private readonly provider: AzureProvider,
    private readonly guardrails: Guardrails,
    private readonly config: AppConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async listSubscriptions(): Promise<readonly SubscriptionCapability[]> {
    const subscriptions = await this.provider.listSubscriptions();
    const allowed = this.guardrails.allowedSubscriptionIds;
    const visible =
      allowed.length === 0
        ? subscriptions
        : subscriptions.filter((subscription) =>
            allowed.includes(subscription.subscriptionId.toLowerCase()),
          );

    return Promise.all(visible.map((subscription) => this.withCapabilities(subscription)));
  }

  /**
   * Reports what the server can actually do in a subscription rather than what it can see.
   *
   * Resource Graph lists a subscription as soon as the identity has any read access, but a
   * deployment needs write permission held by a *different* identity. Presenting a subscription as
   * deployable when the deployment identity has no RBAC there would send an agent into a
   * guaranteed 403 halfway through a plan.
   */
  private async withCapabilities(subscription: Subscription): Promise<SubscriptionCapability> {
    const armScope = `/subscriptions/${subscription.subscriptionId}`;
    const inDeploymentScope =
      this.config.deployments.enabled &&
      this.guardrails.allowedSubscriptionIds.includes(subscription.subscriptionId.toLowerCase());

    if (!this.config.azure.verifyRbac) {
      return { ...subscription, readable: true, deployable: inDeploymentScope };
    }

    const readable = await this.canPerform(armScope, 'operator', READ_ACTION);
    const deployable = inDeploymentScope
      ? await this.canPerform(armScope, 'deployment', DEPLOY_ACTION)
      : false;
    return { ...subscription, readable, deployable };
  }

  private async canPerform(
    armScope: string,
    identity: 'operator' | 'deployment',
    action: string,
  ): Promise<boolean> {
    const key = `${identity}\u0000${armScope}\u0000${action}`;
    const cached = this.permissionCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    let value = false;
    try {
      const permissions = await this.provider.getEffectivePermissions(armScope, identity);
      value = permissions.some(
        (permission) =>
          permission.actions.some((candidate) => matchesAction(candidate, action)) &&
          !permission.notActions.some((candidate) => matchesAction(candidate, action)),
      );
    } catch {
      // A scope the identity cannot even query permissions for is, by definition, not usable.
      value = false;
    }

    this.permissionCache.set(key, {
      value,
      expiresAt: this.now() + this.config.azure.rbacCacheTtlMs,
    });
    return value;
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
