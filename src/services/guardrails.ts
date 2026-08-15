import type { AppConfig } from '../config/index.js';
import { badRequest, forbidden } from '../errors.js';
import {
  resourceGroupFromResourceId,
  subscriptionIdFromResourceId,
} from '../provider/azure/index.js';
import type { CrossScopeTarget, TemplateScopeKind } from '../bicep/index.js';
import type { DeploymentScope, DeploymentScopeKind } from '../provider/types.js';

const RESOURCE_ID_PATTERN =
  /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^/]+\/providers\/[^/]+\/.+$/;

/**
 * KQL operators that can mutate state or reach outside the Resource Graph read surface.
 * Resource Graph is read-only server-side, but rejecting these early gives ChatGPT a precise
 * error instead of an opaque ARM failure, and keeps the audit log honest about intent.
 */
const FORBIDDEN_QUERY_TOKENS = [
  '.create',
  '.drop',
  '.alter',
  '.set',
  '.append',
  '.ingest',
  'externaldata',
  'evaluate',
  'http_request',
];

export interface MutationRequest {
  readonly toolName: string;
  readonly confirm: boolean;
  readonly dryRun: boolean;
}

export interface DeploymentScopeInput {
  readonly kind: DeploymentScopeKind;
  readonly subscriptionId?: string | undefined;
  readonly resourceGroup?: string | undefined;
  readonly managementGroupId?: string | undefined;
  readonly location?: string | undefined;
}

const LOCATION_PATTERN = /^[a-z0-9]{2,40}$/;
const MANAGEMENT_GROUP_PATTERN = /^[-\w().]{1,90}$/;

/** Canonical, comparable identity of a deployment scope. Used for locks, records and hashes. */
export const scopeKeyOf = (scope: DeploymentScope): string =>
  `${scope.kind}:${scope.armScope.toLowerCase()}`;

/**
 * Central policy object. Every service consults it before touching Azure, so the blast radius of
 * the connector is defined in exactly one place.
 */
export class Guardrails {
  public constructor(private readonly config: AppConfig) {}

  public get allowedSubscriptionIds(): readonly string[] {
    return this.config.azure.allowedSubscriptionIds;
  }

  public get allowedResourceGroups(): readonly string[] {
    return this.config.azure.allowedResourceGroups;
  }

  public get mutationsEnabled(): boolean {
    return this.config.guardrails.mutationsEnabled;
  }

  public assertSubscriptionAllowed(subscriptionId: string): string {
    const allowed = this.config.azure.allowedSubscriptionIds;
    if (allowed.length > 0 && !allowed.includes(subscriptionId.toLowerCase())) {
      throw forbidden(`Subscription ${subscriptionId} is outside the server's allow-list`, {
        allowedSubscriptionIds: allowed,
      });
    }
    return subscriptionId;
  }

  public resolveSubscriptionScope(requested: readonly string[]): readonly string[] {
    if (requested.length > 0) {
      return requested.map((id) => this.assertSubscriptionAllowed(id));
    }
    return this.config.azure.allowedSubscriptionIds;
  }

  public assertResourceGroupAllowed(resourceGroup: string): string {
    const allowed = this.config.azure.allowedResourceGroups;
    if (allowed.length > 0 && !allowed.includes(resourceGroup.toLowerCase())) {
      throw forbidden(`Resource group ${resourceGroup} is outside the server's allow-list`, {
        allowedResourceGroups: allowed,
      });
    }
    return resourceGroup;
  }

  public assertResourceIdInScope(resourceId: string): void {
    if (!RESOURCE_ID_PATTERN.test(resourceId)) {
      throw badRequest(
        'resourceId must be a fully qualified ARM resource id ' +
          '(/subscriptions/{id}/resourceGroups/{rg}/providers/{provider}/...)',
      );
    }
    const subscriptionId = subscriptionIdFromResourceId(resourceId);
    const resourceGroup = resourceGroupFromResourceId(resourceId);
    if (subscriptionId) this.assertSubscriptionAllowed(subscriptionId);
    if (resourceGroup) this.assertResourceGroupAllowed(resourceGroup);
  }

  public assertReadOnlyQuery(query: string): void {
    const normalized = query.toLowerCase();
    const offending = FORBIDDEN_QUERY_TOKENS.find((token) => normalized.includes(token));
    if (offending) {
      throw badRequest(`Resource Graph query contains a disallowed operator: ${offending}`);
    }
  }

  /**
   * Returns true when the caller only wants a plan (dry run). Throws when the request is not
   * permitted at all.
   */
  public assertMutationAllowed(request: MutationRequest): boolean {
    if (request.dryRun) return true;
    if (!this.config.guardrails.mutationsEnabled) {
      throw forbidden(
        `Tool ${request.toolName} is a state-changing operation and MUTATIONS_ENABLED is false. ` +
          'Re-run with dryRun=true to preview the action.',
      );
    }
    if (this.config.guardrails.confirmationRequired && !request.confirm) {
      throw badRequest(
        `Tool ${request.toolName} changes Azure state and requires an explicit confirm=true from the user.`,
      );
    }
    return false;
  }

  /* ----------------------------------------------------------- deployments */

  public get deploymentsEnabled(): boolean {
    return this.config.deployments.enabled;
  }

  public assertDeploymentsEnabled(): void {
    if (!this.config.deployments.enabled) {
      throw forbidden(
        'Generic Bicep deployment is disabled on this server. azure_validate_bicep still works, ' +
          'so a template can be checked without deploying it.',
      );
    }
  }

  /**
   * Turns caller-supplied scope fields into a validated {@link DeploymentScope}.
   *
   * Unlike the read allow-lists, an empty subscription allow-list does not mean "everything" here:
   * deploying into an unenumerated subscription is a scope escape, so the allow-list must be set.
   */
  public resolveDeploymentScope(input: DeploymentScopeInput): DeploymentScope {
    const location = input.location?.trim().toLowerCase();
    if (location !== undefined && !LOCATION_PATTERN.test(location)) {
      throw badRequest(`location must be an Azure region name, got ${input.location ?? ''}`);
    }

    switch (input.kind) {
      case 'resourceGroup': {
        const subscriptionId = this.requireAllowedSubscription(input.subscriptionId);
        if (!input.resourceGroup) {
          throw badRequest('A resourceGroup scope requires resourceGroup');
        }
        const resourceGroup = this.assertResourceGroupAllowed(input.resourceGroup);
        return {
          kind: 'resourceGroup',
          subscriptionId,
          resourceGroup,
          managementGroupId: undefined,
          location,
          armScope: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`,
        };
      }
      case 'subscription': {
        const subscriptionId = this.requireAllowedSubscription(input.subscriptionId);
        return {
          kind: 'subscription',
          subscriptionId,
          resourceGroup: undefined,
          managementGroupId: undefined,
          location: this.requireLocation(location, 'subscription'),
          armScope: `/subscriptions/${subscriptionId}`,
        };
      }
      case 'managementGroup': {
        const allowed = this.config.azure.allowedManagementGroupIds;
        if (allowed.length === 0) {
          throw forbidden(
            'Management group deployments require AZURE_ALLOWED_MANAGEMENT_GROUP_IDS to be set',
          );
        }
        const id = input.managementGroupId?.trim();
        if (!id || !MANAGEMENT_GROUP_PATTERN.test(id)) {
          throw badRequest('A managementGroup scope requires a valid managementGroupId');
        }
        if (!allowed.includes(id.toLowerCase())) {
          throw forbidden(`Management group ${id} is outside the server's allow-list`, {
            allowedManagementGroupIds: allowed,
          });
        }
        return {
          kind: 'managementGroup',
          subscriptionId: undefined,
          resourceGroup: undefined,
          managementGroupId: id,
          location: this.requireLocation(location, 'management group'),
          armScope: `/providers/Microsoft.Management/managementGroups/${id}`,
        };
      }
      case 'tenant': {
        if (!this.config.azure.tenantDeploymentsEnabled) {
          throw forbidden(
            'Tenant scope deployments are disabled. Set AZURE_TENANT_DEPLOYMENTS_ENABLED=true to ' +
              'allow them.',
          );
        }
        return {
          kind: 'tenant',
          subscriptionId: undefined,
          resourceGroup: undefined,
          managementGroupId: undefined,
          location: this.requireLocation(location, 'tenant'),
          armScope: '/',
        };
      }
    }
  }

  private requireAllowedSubscription(subscriptionId: string | undefined): string {
    if (!subscriptionId) throw badRequest('This deployment scope requires subscriptionId');
    if (this.config.azure.allowedSubscriptionIds.length === 0) {
      throw forbidden(
        'Deployments require an explicit AZURE_SUBSCRIPTION_IDS allow-list; an empty allow-list ' +
          'is not treated as "every subscription" for state-changing work.',
      );
    }
    return this.assertSubscriptionAllowed(subscriptionId);
  }

  private requireLocation(location: string | undefined, kind: string): string {
    if (!location) {
      throw badRequest(
        `A ${kind} scope deployment requires location, because the deployment resource itself has ` +
          'to live in a region.',
      );
    }
    return location;
  }

  /**
   * The compiled template's own scope must match the scope the caller asked to deploy into. A
   * subscription-scoped template applied at a resource group (or the reverse) fails in ARM, but by
   * then the caller has already been shown a preview that means something different.
   */
  public assertTemplateScopeMatches(
    templateScope: TemplateScopeKind,
    scope: DeploymentScope,
  ): void {
    if (templateScope !== scope.kind) {
      throw badRequest(
        `The template targets ${templateScope} scope but the request asked to deploy at ` +
          `${scope.kind} scope.`,
      );
    }
  }

  /**
   * Nested deployments may retarget another subscription or resource group. Every such target is
   * checked against the same allow-lists as the top-level scope.
   */
  public assertCrossScopeTargetsAllowed(targets: readonly CrossScopeTarget[]): void {
    for (const target of targets) {
      if (target.subscriptionId) this.assertSubscriptionAllowed(target.subscriptionId);
      if (target.resourceGroup) this.assertResourceGroupAllowed(target.resourceGroup);
      if (target.managementGroupId) {
        const allowed = this.config.azure.allowedManagementGroupIds;
        if (!allowed.includes(target.managementGroupId.toLowerCase())) {
          throw forbidden(
            `The template deploys into management group ${target.managementGroupId}, which is ` +
              'outside the allow-list',
          );
        }
      }
    }
  }
}
