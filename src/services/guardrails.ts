import type { AppConfig } from '../config/index.js';
import { badRequest, forbidden } from '../errors.js';
import {
  resourceGroupFromResourceId,
  subscriptionIdFromResourceId,
} from '../provider/azure/index.js';

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
      throw forbidden(`Subscription ${subscriptionId} is outside the connector's allow-list`, {
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
      throw forbidden(`Resource group ${resourceGroup} is outside the connector's allow-list`, {
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
}
