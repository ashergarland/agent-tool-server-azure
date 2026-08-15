import type { Logger } from 'pino';
import type { AzureProvider, AzureResource, ResourceRef } from '../provider/types.js';
import { badRequest } from '../errors.js';
import {
  resourceGroupFromResourceId,
  subscriptionIdFromResourceId,
} from '../provider/azure/index.js';
import type { Metrics } from '../util/metrics.js';
import type { Guardrails } from './guardrails.js';

export interface OperationRequest {
  readonly resourceId: string;
  readonly confirm: boolean;
  readonly dryRun: boolean;
  readonly reason?: string | undefined;
  /** Audit context supplied by the transport. */
  readonly principal?: string | undefined;
  readonly requestId?: string | undefined;
  readonly transport?: string | undefined;
}

export interface OperationResult {
  readonly action: string;
  readonly resourceId: string;
  readonly performed: boolean;
  readonly dryRun: boolean;
  readonly message: string;
}

export interface TagOperationRequest extends OperationRequest {
  readonly tags: Readonly<Record<string, string>>;
}

export interface TagOperationResult extends OperationResult {
  readonly resource: AzureResource | undefined;
}

const EXPECTED_TYPE: Record<string, string> = {
  restart_virtual_machine: 'microsoft.compute/virtualmachines',
  start_virtual_machine: 'microsoft.compute/virtualmachines',
  restart_web_app: 'microsoft.web/sites',
};

/**
 * The constrained set of state-changing operations. Each one is:
 *   - allow-list scoped,
 *   - type checked against the target resource,
 *   - dry-runnable,
 *   - confirmation gated,
 *   - and audit logged with the caller's stated reason.
 */
export class OperationsService {
  public constructor(
    private readonly provider: AzureProvider,
    private readonly guardrails: Guardrails,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  private parseRef(resourceId: string): ResourceRef {
    const subscriptionId = subscriptionIdFromResourceId(resourceId);
    const resourceGroup = resourceGroupFromResourceId(resourceId);
    const name = resourceId.split('/').pop();
    if (!subscriptionId || !resourceGroup || !name) {
      throw badRequest(`Unable to parse ARM resource id: ${resourceId}`);
    }
    return { subscriptionId, resourceGroup, name };
  }

  private async prepare(
    action: string,
    request: OperationRequest,
  ): Promise<{ ref: ResourceRef; resource: AzureResource; dryRun: boolean }> {
    this.guardrails.assertResourceIdInScope(request.resourceId);
    const dryRun = this.guardrails.assertMutationAllowed({
      toolName: action,
      confirm: request.confirm,
      dryRun: request.dryRun,
    });

    const ref = this.parseRef(request.resourceId);
    const resource = await this.provider.getResourceById(request.resourceId);

    const expectedType = EXPECTED_TYPE[action];
    if (expectedType && resource.type.toLowerCase() !== expectedType) {
      throw badRequest(
        `Tool ${action} expects a resource of type ${expectedType} but ${request.resourceId} is ${resource.type}`,
      );
    }

    return { ref, resource, dryRun };
  }

  private audit(action: string, request: OperationRequest, dryRun: boolean): void {
    this.logger.info(
      {
        event: 'azure.mutation',
        action,
        principal: request.principal ?? 'unknown',
        requestId: request.requestId ?? null,
        transport: request.transport ?? null,
        resourceId: request.resourceId,
        subscriptionId: subscriptionIdFromResourceId(request.resourceId) ?? null,
        resourceGroup: resourceGroupFromResourceId(request.resourceId) ?? null,
        dryRun,
        reason: request.reason ?? null,
        timestamp: new Date().toISOString(),
      },
      dryRun ? 'planned Azure mutation (dry run)' : 'executed Azure mutation',
    );
    this.metrics.increment('mutations_total', { action, dryRun: String(dryRun) });
  }

  private async run(
    action: string,
    request: OperationRequest,
    execute: (ref: ResourceRef) => Promise<void>,
  ): Promise<OperationResult> {
    const { ref, dryRun } = await this.prepare(action, request);
    if (!dryRun) {
      await this.metrics.time('azure_mutation_ms', { action }, () => execute(ref));
    }
    this.audit(action, request, dryRun);

    return {
      action,
      resourceId: request.resourceId,
      performed: !dryRun,
      dryRun,
      message: dryRun
        ? `Dry run: ${action} would be executed against ${request.resourceId}`
        : `${action} completed for ${request.resourceId}`,
    };
  }

  public restartVirtualMachine(request: OperationRequest): Promise<OperationResult> {
    return this.run('restart_virtual_machine', request, (ref) =>
      this.provider.restartVirtualMachine(ref),
    );
  }

  public startVirtualMachine(request: OperationRequest): Promise<OperationResult> {
    return this.run('start_virtual_machine', request, (ref) =>
      this.provider.startVirtualMachine(ref),
    );
  }

  public restartWebApp(request: OperationRequest): Promise<OperationResult> {
    return this.run('restart_web_app', request, (ref) => this.provider.restartWebApp(ref));
  }

  public async tagResource(request: TagOperationRequest): Promise<TagOperationResult> {
    const action = 'tag_resource';
    if (Object.keys(request.tags).length === 0) {
      throw badRequest('At least one tag must be supplied');
    }

    const { dryRun } = await this.prepare(action, request);
    const resource = dryRun
      ? undefined
      : await this.provider.setResourceTags(request.resourceId, request.tags);
    this.audit(action, request, dryRun);

    return {
      action,
      resourceId: request.resourceId,
      performed: !dryRun,
      dryRun,
      message: dryRun
        ? `Dry run: tags ${Object.keys(request.tags).join(', ')} would be merged onto ${request.resourceId}`
        : `Tags merged onto ${request.resourceId}`,
      resource,
    };
  }
}
