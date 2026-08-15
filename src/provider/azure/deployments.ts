import { AppError } from '../../errors.js';
import type {
  ArmDeploymentOperation,
  ArmDeploymentOperationPage,
  ArmDeploymentRequest,
  ArmDeploymentStatus,
  ArmWhatIfChange,
  ArmWhatIfResult,
  DeploymentScope,
  EffectivePermission,
} from '../types.js';
import type { ArmRestClient } from './arm-rest.js';

export const DEPLOYMENTS_API_VERSION = '2024-03-01';
export const PERMISSIONS_API_VERSION = '2022-04-01';

interface ArmError {
  code?: string;
  message?: string;
}

interface DeploymentResponse {
  id?: string;
  name?: string;
  properties?: {
    provisioningState?: string;
    correlationId?: string;
    timestamp?: string;
    duration?: string;
    outputs?: Record<string, unknown>;
    error?: ArmError;
  };
}

interface WhatIfResponse {
  status?: string;
  error?: ArmError;
  properties?: {
    changes?: {
      changeType?: string;
      resourceId?: string;
      unsupportedReason?: string;
      delta?: { path?: string; propertyChangeType?: string; before?: unknown; after?: unknown }[];
    }[];
    error?: ArmError;
  };
}

interface OperationsResponse {
  value?: {
    operationId?: string;
    properties?: {
      provisioningState?: string;
      timestamp?: string;
      duration?: string;
      statusCode?: string;
      statusMessage?: unknown;
      targetResource?: { id?: string; resourceType?: string; resourceName?: string };
    };
  }[];
  nextLink?: string;
}

interface PermissionsResponse {
  value?: { actions?: string[]; notActions?: string[] }[];
}

const asError = (error: ArmError | undefined): ArmWhatIfResult['error'] =>
  error === undefined
    ? undefined
    : { code: error.code ?? 'Unknown', message: error.message ?? 'Azure reported an error' };

/** Canonical ARM path a deployment of this scope lives under. */
export const deploymentBasePath = (scope: DeploymentScope): string => {
  switch (scope.kind) {
    case 'resourceGroup':
      return `subscriptions/${encodeURIComponent(scope.subscriptionId ?? '')}/resourcegroups/${encodeURIComponent(
        scope.resourceGroup ?? '',
      )}/providers/Microsoft.Resources/deployments`;
    case 'subscription':
      return `subscriptions/${encodeURIComponent(
        scope.subscriptionId ?? '',
      )}/providers/Microsoft.Resources/deployments`;
    case 'managementGroup':
      return `providers/Microsoft.Management/managementGroups/${encodeURIComponent(
        scope.managementGroupId ?? '',
      )}/providers/Microsoft.Resources/deployments`;
    case 'tenant':
      return 'providers/Microsoft.Resources/deployments';
  }
};

const skipTokenFrom = (nextLink: string | undefined): string | undefined => {
  if (!nextLink) return undefined;
  try {
    const parsed = new URL(nextLink);
    return (
      parsed.searchParams.get('$skiptoken') ?? parsed.searchParams.get('$skipToken') ?? undefined
    );
  } catch {
    return undefined;
  }
};

const toStatus = (response: DeploymentResponse, scope: DeploymentScope): ArmDeploymentStatus => ({
  id:
    response.id ??
    `${scope.armScope}/providers/Microsoft.Resources/deployments/${response.name ?? ''}`,
  name: response.name ?? '',
  provisioningState: response.properties?.provisioningState ?? 'Unknown',
  correlationId: response.properties?.correlationId,
  timestamp: response.properties?.timestamp,
  duration: response.properties?.duration,
  outputs: response.properties?.outputs,
  error: asError(response.properties?.error),
});

export interface ArmDeploymentClientOptions {
  /** Wall-clock bound for the what-if long-running operation. */
  readonly whatIfTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** Configured ARM endpoint; poll locations outside it are refused. */
  readonly armEndpoint: string;
}

/**
 * ARM deployment operations across the four deployment scopes.
 *
 * Deployments are always started with `Incremental` mode. Complete mode is never issued: it
 * deletes every resource in the scope that is absent from the template, which is not a change a
 * preview can meaningfully bound.
 */
export class ArmDeploymentClient {
  public constructor(
    private readonly rest: ArmRestClient,
    private readonly options: ArmDeploymentClientOptions,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private get armEndpoint(): string {
    return this.options.armEndpoint;
  }

  private body(request: ArmDeploymentRequest): Record<string, unknown> {
    const properties: Record<string, unknown> = {
      mode: 'Incremental',
      template: request.template,
      parameters: request.parameters,
    };
    // Subscription, management group and tenant deployments are themselves located somewhere; ARM
    // rejects them without a location.
    return request.scope.kind === 'resourceGroup'
      ? { properties }
      : { location: request.scope.location, properties };
  }

  public async whatIf(request: ArmDeploymentRequest): Promise<ArmWhatIfResult> {
    const path = `${deploymentBasePath(request.scope)}/${encodeURIComponent(request.deploymentName)}/whatIf`;
    const response = await this.rest.post<WhatIfResponse>(path, {
      query: { 'api-version': DEPLOYMENTS_API_VERSION },
      body: this.body(request),
      signal: request.signal,
    });

    const settled =
      response.status === 202
        ? await this.pollWhatIf(
            response.headers['location'] ?? response.headers['azure-asyncoperation'],
            request.signal,
          )
        : response.body;

    const error = asError(settled?.error ?? settled?.properties?.error);
    const changes: ArmWhatIfChange[] = (settled?.properties?.changes ?? []).map((change) => ({
      changeType: change.changeType ?? 'Unknown',
      resourceId: change.resourceId ?? '',
      unsupportedReason: change.unsupportedReason,
      propertyChanges: (change.delta ?? []).map((delta) => ({
        path: delta.path ?? '',
        propertyChangeType: delta.propertyChangeType ?? 'Unknown',
        before: delta.before,
        after: delta.after,
      })),
    }));

    return { status: settled?.status ?? 'Succeeded', changes, error };
  }

  private async pollWhatIf(
    location: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WhatIfResponse | undefined> {
    if (!location) {
      throw new AppError(
        'upstream_error',
        'Azure accepted the what-if request but returned no poll location',
      );
    }
    this.assertArmUrl(location);
    const deadline = this.now() + this.options.whatIfTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(this.options.pollIntervalMs);
      if (signal?.aborted) throw new AppError('timeout', 'The what-if preview was cancelled');
      const result = await this.rest.getRaw<WhatIfResponse>(location, { signal });
      if (result.status !== 202) return result.body;
    }
    throw new AppError(
      'timeout',
      'Azure did not finish the what-if preview within the allowed time',
    );
  }

  /**
   * Poll locations come from a response header. They are only ever followed when they point at the
   * configured ARM endpoint, so a redirected or spoofed header cannot make the server fetch an
   * attacker-chosen URL with an Azure token attached.
   */
  private assertArmUrl(candidate: string): void {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new AppError('upstream_error', 'Azure returned an unusable poll location');
    }
    if (url.origin !== new URL(this.armEndpoint).origin) {
      throw new AppError(
        'upstream_error',
        'Azure returned a poll location outside the ARM endpoint',
      );
    }
  }

  public async begin(request: ArmDeploymentRequest): Promise<ArmDeploymentStatus> {
    const path = `${deploymentBasePath(request.scope)}/${encodeURIComponent(request.deploymentName)}`;
    // PUT returns as soon as ARM has accepted the deployment. The request is never held open while
    // resources are created: callers poll azure_get_deployment instead.
    const response = await this.rest.put<DeploymentResponse>(path, {
      query: { 'api-version': DEPLOYMENTS_API_VERSION },
      body: this.body(request),
      signal: request.signal,
    });
    return toStatus(response.body ?? { name: request.deploymentName }, request.scope);
  }

  public async get(scope: DeploymentScope, deploymentName: string): Promise<ArmDeploymentStatus> {
    const path = `${deploymentBasePath(scope)}/${encodeURIComponent(deploymentName)}`;
    const body = await this.rest.get<DeploymentResponse>(path, {
      query: { 'api-version': DEPLOYMENTS_API_VERSION },
    });
    return toStatus(body ?? { name: deploymentName }, scope);
  }

  public async listOperations(
    scope: DeploymentScope,
    deploymentName: string,
    options: { readonly top: number; readonly skipToken: string | undefined },
  ): Promise<ArmDeploymentOperationPage> {
    const path = `${deploymentBasePath(scope)}/${encodeURIComponent(deploymentName)}/operations`;
    const body = await this.rest.get<OperationsResponse>(path, {
      query: {
        'api-version': DEPLOYMENTS_API_VERSION,
        $top: options.top,
        ...(options.skipToken === undefined ? {} : { $skiptoken: options.skipToken }),
      },
    });

    const operations: ArmDeploymentOperation[] = (body?.value ?? [])
      .slice(0, options.top)
      .map((entry) => ({
        operationId: entry.operationId ?? '',
        provisioningState: entry.properties?.provisioningState,
        timestamp: entry.properties?.timestamp,
        duration: entry.properties?.duration,
        resourceType: entry.properties?.targetResource?.resourceType,
        resourceName: entry.properties?.targetResource?.resourceName,
        targetResourceId: entry.properties?.targetResource?.id,
        statusCode: entry.properties?.statusCode,
        statusMessage:
          typeof entry.properties?.statusMessage === 'string'
            ? entry.properties.statusMessage
            : entry.properties?.statusMessage === undefined
              ? undefined
              : JSON.stringify(entry.properties.statusMessage).slice(0, 2000),
      }));

    return { operations, skipToken: skipTokenFrom(body?.nextLink) };
  }

  public async effectivePermissions(armScope: string): Promise<readonly EffectivePermission[]> {
    const path = `${armScope.replace(/^\//, '')}/providers/Microsoft.Authorization/permissions`;
    const body = await this.rest.get<PermissionsResponse>(path, {
      query: { 'api-version': PERMISSIONS_API_VERSION },
    });
    return (body?.value ?? []).map((entry) => ({
      actions: entry.actions ?? [],
      notActions: entry.notActions ?? [],
    }));
  }
}
