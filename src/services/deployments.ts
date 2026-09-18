import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  timedOut,
} from '@agent-tool-platform/runtime/errors';
import { BoundedQueue } from '@agent-tool-platform/runtime/concurrency';
import type { AppConfig } from '../config/index.js';
import {
  assertBundleSourceAllowed,
  computeConfirmationHash,
  hashJson,
  inspectTemplate,
  normalizeBundle,
  type BicepBundle,
  type BicepCompiler,
  type BicepDiagnostic,
  type NormalizedBundle,
  type TemplateInspection,
} from '../bicep/index.js';
import type {
  ArmDeploymentStatus,
  ArmWhatIfChange,
  AzureProvider,
  DeploymentScope,
} from '../provider/types.js';
import type {
  DeploymentRecord,
  DeploymentRecordStatus,
  DeploymentRecordStore,
  PreviewSummary,
} from '../deployments/records.js';
import type { Metrics } from '../util/metrics.js';
import { scopeKeyOf, type DeploymentScopeInput, type Guardrails } from './guardrails.js';

const REDACTED = '[redacted]';

/** Names that conventionally carry secrets even when the template did not mark them secure. */
const SENSITIVE_NAME = /(password|secret|token|key|credential|connectionstring|sas|pfx)/i;

const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw timedOut('The request was cancelled');
};

const assertLeaseHeld = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw conflict(
      'The distributed deployment lock could not be renewed. No new ARM submission was started.',
    );
  }
};

const deploymentStatus = (provisioningState: string): DeploymentRecordStatus => {
  const state = provisioningState.toLowerCase();
  return state === 'succeeded'
    ? 'succeeded'
    : state === 'failed'
      ? 'failed'
      : state === 'canceled' || state === 'cancelled'
        ? 'canceled'
        : 'running';
};

const statusFromErrorDetails = (error: AppError): number | undefined => {
  const details = error.details;
  return typeof details === 'object' &&
    details !== null &&
    'status' in details &&
    typeof details.status === 'number'
    ? details.status
    : undefined;
};

const isDefinitiveSubmissionFailure = (error: unknown): error is AppError => {
  if (!(error instanceof AppError)) return false;
  if (
    error.code === 'bad_request' ||
    error.code === 'forbidden' ||
    error.code === 'not_found' ||
    error.code === 'rate_limited'
  ) {
    return true;
  }
  return [400, 401, 403, 404, 422, 429].includes(statusFromErrorDetails(error) ?? 0);
};

export type BicepInput = BicepBundle;

export interface ValidateInput {
  readonly bundle: BicepInput;
}

export interface ValidateResult {
  readonly valid: boolean;
  readonly diagnostics: readonly BicepDiagnostic[];
  readonly sourceHash: string;
  readonly templateHash: string | undefined;
  readonly templateScope: string | undefined;
  readonly resourceTypes: readonly string[];
  readonly resourceCount: number | undefined;
  readonly nestedDeploymentCount: number | undefined;
  readonly parameterNames: readonly string[];
  readonly secureParameterNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export interface WhatIfInput {
  readonly bundle: BicepInput;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly scope: DeploymentScopeInput;
}

export interface NormalizedChange {
  readonly changeType: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly propertyChanges: readonly { readonly path: string; readonly changeType: string }[];
  readonly propertyChangesTruncated: boolean;
  readonly unsupportedReason: string | undefined;
}

export interface WhatIfResult {
  readonly previewId: string;
  readonly confirmationHash: string;
  readonly expiresAt: string;
  readonly scope: DeploymentScope;
  readonly mode: 'Incremental';
  readonly sourceHash: string;
  readonly templateHash: string;
  readonly summary: PreviewSummary;
  readonly changes: readonly NormalizedChange[];
  readonly diagnostics: readonly BicepDiagnostic[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly resourceTypes: readonly string[];
  readonly secureParameterNames: readonly string[];
}

export interface DeployInput {
  readonly bundle: BicepInput;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly scope: DeploymentScopeInput;
  readonly confirmationHash: string;
  readonly confirm: boolean;
  readonly reason: string;
}

export interface DeployResult {
  readonly recordId: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly status: string;
  readonly scope: DeploymentScope;
  readonly confirmationHash: string;
  readonly templateHash: string;
  readonly correlationId: string | undefined;
  readonly startedAt: string;
  readonly alreadyStarted: boolean;
  readonly message: string;
}

export interface DeploymentOperationSummary {
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

export interface DeploymentStatusResult {
  readonly recordId: string | undefined;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly scope: DeploymentScope;
  readonly provisioningState: string;
  readonly correlationId: string | undefined;
  readonly timestamp: string | undefined;
  readonly duration: string | undefined;
  readonly outputs: readonly { readonly name: string; readonly value: unknown }[];
  readonly redactedOutputNames: readonly string[];
  readonly error: { readonly code: string; readonly message: string } | undefined;
}

export interface RollbackInput {
  readonly recordId: string;
  readonly confirm: boolean;
  readonly reason: string;
  readonly confirmationHash?: string | undefined;
  readonly secureParameters?: Readonly<Record<string, string>> | undefined;
}

export interface DeploymentServiceDeps {
  readonly provider: AzureProvider;
  readonly guardrails: Guardrails;
  readonly config: AppConfig;
  readonly store: DeploymentRecordStore;
  readonly compiler: BicepCompiler;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const toArmParameters = (parameters: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, { value }]));

const sanitizeParameters = (
  parameters: Readonly<Record<string, unknown>>,
  secureNames: readonly string[],
): Record<string, unknown> => {
  const secure = new Set(secureNames.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [
      name,
      secure.has(name.toLowerCase()) || SENSITIVE_NAME.test(name) ? REDACTED : value,
    ]),
  );
};

export class DeploymentService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly concurrency: BoundedQueue;

  public constructor(private readonly deps: DeploymentServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.newId = deps.newId ?? ((): string => randomUUID());
    this.concurrency = new BoundedQueue(
      deps.config.deployments.maxConcurrent,
      deps.config.deployments.maxConcurrent * 4,
      'Azure deployment work',
    );
  }

  /* ------------------------------------------------------------- compiling */

  private async compile(
    bundleInput: BicepInput,
    signal?: AbortSignal,
  ): Promise<{
    bundle: NormalizedBundle;
    diagnostics: readonly BicepDiagnostic[];
    template: Record<string, unknown> | undefined;
    inspection: TemplateInspection | undefined;
  }> {
    assertNotCancelled(signal);
    const bundle = normalizeBundle(bundleInput, this.deps.config.bicep.bundleLimits);
    // Module policy is enforced here, in the policy layer, rather than only inside the CLI adapter.
    // A different compiler adapter must not be able to widen what a caller may reference.
    assertBundleSourceAllowed(bundle, this.deps.config.bicep.modulePolicy);

    const compiled = await this.deps.metrics.time('bicep_compile_ms', {}, () =>
      this.deps.compiler.compile({ bundle, signal }),
    );
    this.deps.metrics.observe('bicep_compile_duration_ms', compiled.durationMs);

    if (!compiled.template) {
      return {
        bundle,
        diagnostics: compiled.diagnostics,
        template: undefined,
        inspection: undefined,
      };
    }
    const inspection = inspectTemplate(compiled.template, this.deps.config.bicep.inspectionLimits);
    return {
      bundle,
      diagnostics: compiled.diagnostics,
      template: compiled.template,
      inspection,
    };
  }

  public async validate(input: ValidateInput, signal?: AbortSignal): Promise<ValidateResult> {
    const { bundle, diagnostics, inspection } = await this.compile(input.bundle, signal);
    return {
      valid: inspection !== undefined,
      diagnostics,
      sourceHash: bundle.sourceHash,
      templateHash: inspection?.templateHash,
      templateScope: inspection?.templateScope,
      resourceTypes: inspection?.resourceTypes ?? [],
      resourceCount: inspection?.resourceCount,
      nestedDeploymentCount: inspection?.nestedDeploymentCount,
      parameterNames: inspection?.parameterNames ?? [],
      secureParameterNames: inspection?.secureParameterNames ?? [],
      outputNames: inspection?.outputNames ?? [],
      warnings: inspection?.warnings ?? [],
    };
  }

  /* -------------------------------------------------------------- previews */

  private normalizeChanges(changes: readonly ArmWhatIfChange[]): {
    normalized: readonly NormalizedChange[];
    summary: PreviewSummary;
  } {
    const { maxPreviewChanges, maxPropertyChanges } = this.deps.config.deployments;
    const counts: Record<string, number> = {};
    const deletes: string[] = [];
    const unsupported: string[] = [];

    for (const change of changes) {
      counts[change.changeType] = (counts[change.changeType] ?? 0) + 1;
      if (change.changeType.toLowerCase() === 'delete') deletes.push(change.resourceId);
      if (change.unsupportedReason) unsupported.push(change.resourceId);
    }

    const normalized: NormalizedChange[] = changes.slice(0, maxPreviewChanges).map((change) => {
      const propertyChanges = change.propertyChanges.slice(0, maxPropertyChanges);
      return {
        changeType: change.changeType,
        resourceId: change.resourceId,
        resourceType: resourceTypeOf(change.resourceId),
        // Only the path and the kind of change are reported. `before` and `after` come from live
        // Azure resources and can contain configuration the caller is not entitled to read.
        propertyChanges: propertyChanges.map((property) => ({
          path: property.path,
          changeType: property.propertyChangeType,
        })),
        propertyChangesTruncated: change.propertyChanges.length > propertyChanges.length,
        unsupportedReason: change.unsupportedReason,
      };
    });

    return {
      normalized,
      summary: {
        totalChanges: changes.length,
        countsByChangeType: counts,
        deletes: deletes.slice(0, maxPreviewChanges),
        unsupported: unsupported.slice(0, maxPreviewChanges),
        truncated: changes.length > normalized.length,
      },
    };
  }

  private async preview(options: {
    readonly scope: DeploymentScope;
    readonly template: Record<string, unknown>;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ normalized: readonly NormalizedChange[]; summary: PreviewSummary }> {
    assertNotCancelled(options.signal);
    const result = await this.deps.metrics.time(
      'arm_whatif_ms',
      { scope: options.scope.kind },
      () =>
        this.deps.provider.whatIfDeployment({
          scope: options.scope,
          deploymentName: `atsa-whatif-${this.newId()}`,
          template: options.template,
          parameters: toArmParameters(options.parameters),
          signal: options.signal,
        }),
    );

    if (result.error) {
      throw badRequest(`Azure rejected the what-if preview: ${result.error.message}`, {
        code: result.error.code,
      });
    }
    return this.normalizeChanges(result.changes);
  }

  public async whatIf(
    input: WhatIfInput,
    principal: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<WhatIfResult> {
    this.deps.guardrails.assertDeploymentsEnabled();
    const scope = this.deps.guardrails.resolveDeploymentScope(input.scope);

    const { bundle, diagnostics, template, inspection } = await this.compile(input.bundle, signal);
    if (!template || !inspection) {
      throw badRequest('The Bicep source did not compile, so it cannot be previewed.', {
        diagnostics: diagnostics.filter((entry) => entry.level === 'error').slice(0, 20),
      });
    }

    this.deps.guardrails.assertTemplateScopeMatches(inspection.templateScope, scope);
    this.deps.guardrails.assertCrossScopeTargetsAllowed(inspection.crossScopeTargets);

    const { normalized, summary } = await this.concurrency.run(
      () => this.preview({ scope, template, parameters: input.parameters, signal }),
      signal,
    );
    assertNotCancelled(signal);

    const scopeKey = scopeKeyOf(scope);
    const parametersHash = hashJson(input.parameters);
    const previewHash = hashJson({ summary, changes: normalized });
    const confirmationHash = computeConfirmationHash({
      sourceHash: bundle.sourceHash,
      templateHash: inspection.templateHash,
      parametersHash,
      scopeKey,
      mode: 'Incremental',
      previewHash,
    });

    const createdAt = this.now();
    const previousSuccessfulRecordId = await this.findPreviousSuccessful(
      scopeKey,
      principal,
      signal,
    );
    const record: DeploymentRecord = {
      id: this.newId(),
      principal,
      scopeKey,
      scope,
      mode: 'Incremental',
      sourceHash: bundle.sourceHash,
      templateHash: inspection.templateHash,
      parametersHash,
      previewHash,
      confirmationHash,
      previewSummary: summary,
      resourceTypes: inspection.resourceTypes,
      sanitizedParameters: sanitizeParameters(input.parameters, inspection.secureParameterNames),
      secureParameterNames: inspection.secureParameterNames,
      template,
      status: 'previewed',
      armDeploymentId: undefined,
      armDeploymentName: undefined,
      correlationId: undefined,
      outputsMetadata: undefined,
      previousSuccessfulRecordId,
      rollbackOfRecordId: undefined,
      reason: undefined,
      requestId,
      error: undefined,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + this.deps.config.deployments.previewTtlMs,
      ).toISOString(),
    };
    assertNotCancelled(signal);
    await this.deps.store.put(record, signal);
    assertNotCancelled(signal);

    this.audit('deployment.preview', record, {
      changeCount: summary.totalChanges,
      deleteCount: summary.deletes.length,
    });

    return {
      previewId: record.id,
      confirmationHash,
      expiresAt: record.expiresAt,
      scope,
      mode: 'Incremental',
      sourceHash: bundle.sourceHash,
      templateHash: inspection.templateHash,
      summary,
      changes: normalized,
      diagnostics,
      warnings: inspection.warnings,
      resourceTypes: inspection.resourceTypes,
      secureParameterNames: inspection.secureParameterNames,
    };
  }

  private async findPreviousSuccessful(
    scopeKey: string,
    principal: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    assertNotCancelled(signal);
    const history = await this.deps.store.listByScope(scopeKey, principal, 20, signal);
    assertNotCancelled(signal);
    return history.find((entry) => entry.status === 'succeeded')?.id;
  }

  /* -------------------------------------------------------------- deploying */

  public async deploy(
    input: DeployInput,
    principal: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<DeployResult> {
    this.deps.guardrails.assertDeploymentsEnabled();
    this.deps.guardrails.assertMutationAllowed({
      toolName: 'azure_deploy_bicep',
      confirm: input.confirm,
      dryRun: false,
    });
    if (!input.confirm) {
      throw badRequest(
        'azure_deploy_bicep requires confirm=true. Show the user the what-if preview and obtain ' +
          'explicit approval first.',
      );
    }
    if (input.reason.trim().length === 0) {
      throw badRequest('azure_deploy_bicep requires a reason, which is recorded in the audit log.');
    }

    assertNotCancelled(signal);
    const scope = this.deps.guardrails.resolveDeploymentScope(input.scope);
    const record = await this.deps.store.findByConfirmationHash(
      input.confirmationHash,
      principal,
      signal,
    );
    assertNotCancelled(signal);
    if (!record) {
      throw badRequest(
        'No recent what-if preview matches this confirmationHash for this caller. Run ' +
          'azure_what_if_bicep again and show the user the new plan.',
      );
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw badRequest(
        `The preview expired at ${record.expiresAt}. Run azure_what_if_bicep again: Azure state ` +
          'may have changed since the plan was produced.',
      );
    }

    // Recompile the source the caller just sent and require it to be byte-identical, in effect, to
    // what was previewed. This is what makes the confirmation meaningful: an approval covers one
    // exact template, one exact parameter set, one scope and one mode.
    const { bundle, template, inspection } = await this.compile(input.bundle, signal);
    if (!template || !inspection) {
      throw badRequest(
        'The Bicep source no longer compiles, so the approved plan cannot be applied.',
      );
    }

    const scopeKey = scopeKeyOf(scope);
    const parametersHash = hashJson(input.parameters);
    const recomputed = computeConfirmationHash({
      sourceHash: bundle.sourceHash,
      templateHash: inspection.templateHash,
      parametersHash,
      scopeKey,
      mode: 'Incremental',
      previewHash: record.previewHash,
    });

    if (recomputed !== input.confirmationHash || recomputed !== record.confirmationHash) {
      throw conflict(
        'The source, parameters, scope or mode differ from the previewed deployment. Re-run ' +
          'azure_what_if_bicep and obtain approval for the new plan.',
        {
          sourceMatches: bundle.sourceHash === record.sourceHash,
          templateMatches: inspection.templateHash === record.templateHash,
          parametersMatch: parametersHash === record.parametersHash,
          scopeMatches: scopeKey === record.scopeKey,
        },
      );
    }

    if (record.status === 'running' || record.status === 'succeeded') {
      // A retried call for an already-started deployment reports the existing one rather than
      // starting a second deployment against the same scope.
      return this.describeStarted(record, true);
    }
    if (record.status !== 'previewed' && record.status !== 'submitting') {
      throw conflict(`This preview is in state ${record.status} and cannot be deployed again.`);
    }

    return this.start(record, template, input.parameters, input.reason, requestId, signal);
  }

  private async start(
    record: DeploymentRecord,
    template: Record<string, unknown>,
    parameters: Readonly<Record<string, unknown>>,
    reason: string,
    requestId: string,
    signal?: AbortSignal,
    authorizedScope?: DeploymentScope,
  ): Promise<DeployResult> {
    const deploymentName = `atsa-${record.id}`.slice(0, 64);

    assertNotCancelled(signal);
    const outcome = await this.concurrency.run(
      () =>
        this.deps.store.withScopeLock(
          record.scopeKey,
          async (leaseSignal) => {
            assertNotCancelled(signal);
            const current = await this.deps.store.get(record.id, record.principal, signal);
            assertNotCancelled(signal);
            if (!current) {
              throw conflict('The approved deployment preview no longer exists.');
            }
            if (
              current.status === 'running' ||
              current.status === 'succeeded' ||
              current.status === 'failed' ||
              current.status === 'canceled'
            ) {
              return { record: current, alreadyStarted: true };
            }
            if (current.status !== 'previewed' && current.status !== 'submitting') {
              throw conflict(
                `This preview is in state ${current.status} and cannot be deployed again.`,
              );
            }
            const submissionScope = authorizedScope ?? current.scope;
            const submissionScopeKey = scopeKeyOf(submissionScope);
            if (submissionScopeKey !== record.scopeKey || submissionScopeKey !== current.scopeKey) {
              throw conflict('The approved deployment scope no longer matches its durable record.');
            }

            const resumingUncertainSubmission = current.status === 'submitting';
            let submitted = current;
            if (resumingUncertainSubmission) {
              try {
                const existing = await this.deps.provider.getDeployment(
                  submissionScope,
                  deploymentName,
                  leaseSignal,
                );
                return {
                  record: await this.reconcile(current, existing),
                  alreadyStarted: true,
                };
              } catch (error) {
                if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
                this.audit('deployment.reconcileMissing', current, {
                  deploymentName,
                  reason,
                  requestId,
                });
              }
            } else {
              // This is the final caller-cancellation boundary. From the durable transition onward,
              // finish submission and tracking even if the caller disconnects: ARM may accept PUT.
              assertNotCancelled(signal);
              assertLeaseHeld(leaseSignal);
              const transition = await this.deps.store.patch(
                current.id,
                current.principal,
                {
                  status: 'submitting',
                  armDeploymentName: deploymentName,
                  reason,
                  updatedAt: this.now().toISOString(),
                },
                undefined,
                { expectedStatuses: ['previewed'] },
              );
              if (!transition) {
                throw conflict('The approved deployment preview no longer exists.');
              }
              if (!transition.applied || transition.record.status !== 'submitting') {
                return { record: transition.record, alreadyStarted: true };
              }
              submitted = transition.record;
              this.audit('deployment.submitting', submitted, {
                deploymentName,
                reason,
                requestId,
              });
            }

            assertLeaseHeld(leaseSignal);
            let started: ArmDeploymentStatus;
            try {
              started = await this.deps.metrics.time(
                'arm_deploy_start_ms',
                { scope: submissionScope.kind },
                () =>
                  this.deps.provider.beginDeployment({
                    scope: submissionScope,
                    deploymentName,
                    template,
                    parameters: toArmParameters(parameters),
                    signal: leaseSignal,
                  }),
              );
            } catch (error) {
              const leaseLost = leaseSignal.aborted;
              await this.recordSubmissionFailure(
                submitted,
                error,
                requestId,
                !resumingUncertainSubmission && !leaseLost,
              );
              if (leaseLost) {
                throw conflict(
                  'The distributed deployment lease was lost while Azure submission acceptance ' +
                    'was uncertain. Retry the exact approved deployment to reconcile its ' +
                    'deterministic deployment name.',
                  { recordId: submitted.id, deploymentName },
                );
              }
              throw error;
            }
            this.deps.metrics.increment('deployments_started_total', {
              scope: submissionScope.kind,
            });
            this.audit('deployment.accepted', submitted, {
              deploymentName,
              deploymentId: started.id,
              correlationId: started.correlationId,
              reason,
              requestId,
            });

            const updated = await this.reconcile(submitted, started);
            this.audit('deployment.started', updated, {
              deploymentName,
              reason,
              requestId,
            });
            return { record: updated, alreadyStarted: false };
          },
          signal,
        ),
      signal,
    );

    return this.describeStarted(outcome.record, outcome.alreadyStarted);
  }

  private async recordSubmissionFailure(
    submitted: DeploymentRecord,
    error: unknown,
    requestId: string,
    definitiveFailureAllowed: boolean,
  ): Promise<void> {
    if (definitiveFailureAllowed && isDefinitiveSubmissionFailure(error)) {
      const transition = await this.deps.store.patch(
        submitted.id,
        submitted.principal,
        {
          status: 'failed',
          error: { code: error.code, message: error.message },
          updatedAt: this.now().toISOString(),
        },
        undefined,
        { expectedStatuses: ['submitting'] },
      );
      if (transition?.applied) {
        this.audit('deployment.rejected', transition.record, {
          errorCode: error.code,
          requestId,
        });
      }
      return;
    }

    const transition = await this.deps.store.patch(
      submitted.id,
      submitted.principal,
      {
        error: {
          code: 'submission_uncertain',
          message:
            'Azure submission acceptance could not be confirmed. Retry the exact approved ' +
            'deployment to reconcile its deterministic deployment name.',
        },
        updatedAt: this.now().toISOString(),
      },
      undefined,
      { expectedStatuses: ['submitting'] },
    );
    if (transition?.applied) {
      this.audit('deployment.uncertain', transition.record, {
        deploymentName: submitted.armDeploymentName,
        errorCode: error instanceof AppError ? error.code : 'unknown',
        requestId,
      });
    }
  }

  private describeStarted(record: DeploymentRecord, alreadyStarted: boolean): DeployResult {
    const terminal = record.status === 'failed' || record.status === 'canceled';
    return {
      recordId: record.id,
      deploymentId: record.armDeploymentId ?? '',
      deploymentName: record.armDeploymentName ?? '',
      status: record.status,
      scope: record.scope,
      confirmationHash: record.confirmationHash,
      templateHash: record.templateHash,
      correlationId: record.correlationId,
      startedAt: record.updatedAt,
      alreadyStarted,
      message: terminal
        ? `Azure reports this deployment as ${record.status}. Inspect azure_get_deployment and its operations for details.`
        : alreadyStarted
          ? 'This deployment was already started; reporting the existing deployment rather than starting another.'
          : 'The deployment was accepted by Azure. Poll azure_get_deployment for progress.',
    };
  }

  /* ----------------------------------------------------------------- status */

  private resolveStoredScope(record: DeploymentRecord): DeploymentScope {
    const scope = this.deps.guardrails.resolveDeploymentScope({
      kind: record.scope.kind,
      subscriptionId: record.scope.subscriptionId,
      resourceGroup: record.scope.resourceGroup,
      managementGroupId: record.scope.managementGroupId,
      location: record.scope.location,
    });
    if (
      scopeKeyOf(scope) !== record.scopeKey ||
      scope.armScope.toLowerCase() !== record.scope.armScope.toLowerCase()
    ) {
      throw conflict(`Deployment record ${record.id} contains an inconsistent scope.`);
    }
    return scope;
  }

  private authorizeRollbackRecord(
    record: DeploymentRecord,
  ): DeploymentRecord & { readonly template: Record<string, unknown> } {
    if (!record.template) {
      throw badRequest(`Record ${record.id} does not retain a template and cannot be redeployed.`);
    }
    const scope = this.resolveStoredScope(record);
    const inspection = inspectTemplate(record.template, this.deps.config.bicep.inspectionLimits);
    if (inspection.templateHash !== record.templateHash) {
      throw conflict(`Deployment record ${record.id} contains an inconsistent template.`);
    }
    this.deps.guardrails.assertTemplateScopeMatches(inspection.templateScope, scope);
    this.deps.guardrails.assertCrossScopeTargetsAllowed(inspection.crossScopeTargets);
    return { ...record, scope, template: record.template };
  }

  private async resolveTarget(
    input: {
      readonly recordId?: string | undefined;
      readonly scope?: DeploymentScopeInput | undefined;
      readonly deploymentName?: string | undefined;
    },
    principal: string,
    signal?: AbortSignal,
  ): Promise<{
    scope: DeploymentScope;
    deploymentName: string;
    record: DeploymentRecord | undefined;
  }> {
    assertNotCancelled(signal);
    if (input.recordId) {
      const record = await this.deps.store.get(input.recordId, principal, signal);
      assertNotCancelled(signal);
      if (!record) throw notFound(`No deployment record ${input.recordId} for this caller`);
      if (!record.armDeploymentName) {
        throw badRequest(
          `Record ${record.id} is a preview that was never deployed, so it has no Azure status.`,
        );
      }
      return {
        scope: this.resolveStoredScope(record),
        deploymentName: record.armDeploymentName,
        record,
      };
    }

    if (!input.scope || !input.deploymentName) {
      throw badRequest('Supply either recordId, or both scope and deploymentName.');
    }
    if (!/^[-\w.()]{1,64}$/.test(input.deploymentName)) {
      throw badRequest('deploymentName contains characters ARM does not accept.');
    }
    return {
      scope: this.deps.guardrails.resolveDeploymentScope(input.scope),
      deploymentName: input.deploymentName,
      record: undefined,
    };
  }

  public async getDeployment(
    input: {
      readonly recordId?: string | undefined;
      readonly scope?: DeploymentScopeInput | undefined;
      readonly deploymentName?: string | undefined;
    },
    principal: string,
    signal?: AbortSignal,
  ): Promise<DeploymentStatusResult> {
    this.deps.guardrails.assertDeploymentsEnabled();
    const target = await this.resolveTarget(input, principal, signal);
    let status: ArmDeploymentStatus;
    try {
      status = await this.deps.provider.getDeployment(target.scope, target.deploymentName, signal);
    } catch (error) {
      if (target.record?.status === 'submitting' && error instanceof AppError) {
        if (error.code === 'not_found') {
          throw conflict(
            'Azure does not currently expose the submitted deployment. Retry azure_deploy_bicep ' +
              'with the exact approved source, parameters, scope and confirmationHash to reconcile ' +
              'the deterministic deployment name.',
            { recordId: target.record.id },
          );
        }
      }
      throw error;
    }

    if (target.record) await this.reconcile(target.record, status);

    const { outputs, redacted } = summarizeOutputs(status.outputs);
    return {
      recordId: target.record?.id,
      deploymentId: status.id,
      deploymentName: status.name || target.deploymentName,
      scope: target.scope,
      provisioningState: status.provisioningState,
      correlationId: status.correlationId,
      timestamp: status.timestamp,
      duration: status.duration,
      outputs,
      redactedOutputNames: redacted,
      error: status.error,
    };
  }

  private async reconcile(
    record: DeploymentRecord,
    status: ArmDeploymentStatus,
  ): Promise<DeploymentRecord> {
    const mapped = deploymentStatus(status.provisioningState);
    if (mapped === record.status) return record;

    const transition = await this.deps.store.patch(
      record.id,
      record.principal,
      {
        status: mapped,
        armDeploymentId: status.id,
        armDeploymentName: record.armDeploymentName ?? status.name,
        correlationId: status.correlationId ?? record.correlationId,
        outputsMetadata: outputsMetadata(status.outputs),
        error: status.error,
        updatedAt: this.now().toISOString(),
      },
      undefined,
      { expectedStatuses: [record.status] },
    );
    if (!transition) {
      throw conflict(`Deployment record ${record.id} disappeared during status reconciliation.`);
    }
    if (!transition.applied) return transition.record;

    if (
      transition.record.status === 'succeeded' ||
      transition.record.status === 'failed' ||
      transition.record.status === 'canceled'
    ) {
      this.deps.metrics.increment('deployments_completed_total', {
        scope: record.scope.kind,
        outcome: transition.record.status,
      });
    }
    this.audit('deployment.state', transition.record, {
      provisioningState: status.provisioningState,
    });
    return transition.record;
  }

  public async listOperations(
    input: {
      readonly recordId?: string | undefined;
      readonly scope?: DeploymentScopeInput | undefined;
      readonly deploymentName?: string | undefined;
      readonly limit: number;
      readonly skipToken?: string | undefined;
    },
    principal: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly recordId: string | undefined;
    readonly deploymentName: string;
    readonly operations: readonly DeploymentOperationSummary[];
    readonly skipToken: string | undefined;
  }> {
    this.deps.guardrails.assertDeploymentsEnabled();
    const target = await this.resolveTarget(input, principal, signal);
    const top = Math.min(input.limit, this.deps.config.deployments.maxOperations);
    const page = await this.deps.provider.listDeploymentOperations(
      target.scope,
      target.deploymentName,
      { top, skipToken: input.skipToken },
      signal,
    );

    return {
      recordId: target.record?.id,
      deploymentName: target.deploymentName,
      operations: page.operations.map((operation) => ({
        operationId: operation.operationId,
        provisioningState: operation.provisioningState,
        timestamp: operation.timestamp,
        duration: operation.duration,
        resourceType: operation.resourceType,
        resourceName: operation.resourceName,
        targetResourceId: operation.targetResourceId,
        statusCode: operation.statusCode,
        statusMessage: operation.statusMessage?.slice(0, 1000),
      })),
      skipToken: page.skipToken,
    };
  }

  /* --------------------------------------------------------------- rollback */

  public async rollback(
    input: RollbackInput,
    principal: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly phase: 'preview'; readonly preview: WhatIfResult; readonly rollbackOf: string }
    | { readonly phase: 'deployed'; readonly result: DeployResult; readonly rollbackOf: string }
  > {
    this.deps.guardrails.assertDeploymentsEnabled();
    const previewOnly = !input.confirm || !input.confirmationHash;
    this.deps.guardrails.assertMutationAllowed({
      toolName: 'azure_rollback_deployment',
      confirm: input.confirm,
      dryRun: previewOnly,
    });

    assertNotCancelled(signal);
    const storedTarget = await this.deps.store.get(input.recordId, principal, signal);
    assertNotCancelled(signal);
    if (!storedTarget) throw notFound(`No deployment record ${input.recordId} for this caller`);
    if (storedTarget.status !== 'succeeded') {
      throw badRequest(
        `Record ${storedTarget.id} is in state ${storedTarget.status}. Only a previously successful ` +
          'deployment can be redeployed.',
      );
    }
    const target = this.authorizeRollbackRecord(storedTarget);

    const parameters = this.rebuildParameters(target, input.secureParameters);

    if (previewOnly) {
      return {
        phase: 'preview',
        rollbackOf: target.id,
        preview: await this.previewRollback(target, parameters, principal, requestId, signal),
      };
    }

    const record = await this.deps.store.findByConfirmationHash(
      input.confirmationHash,
      principal,
      signal,
    );
    assertNotCancelled(signal);
    if (!record || record.rollbackOfRecordId !== target.id) {
      throw badRequest(
        'confirmationHash does not match a recent rollback preview for this record. Re-run ' +
          'azure_rollback_deployment without confirm to produce a fresh preview.',
      );
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw badRequest(`The rollback preview expired at ${record.expiresAt}. Produce a new one.`);
    }

    // The same binding deploy() enforces: the template, the parameters (including the secure values
    // supplied on *this* call), the scope and the mode must be exactly what the preview covered.
    // Without this, a caller could preview a rollback with one set of secure values and apply it
    // with another.
    const recomputed = computeConfirmationHash({
      sourceHash: target.sourceHash,
      templateHash: target.templateHash,
      parametersHash: hashJson(parameters),
      scopeKey: target.scopeKey,
      mode: 'Incremental',
      previewHash: record.previewHash,
    });
    if (recomputed !== input.confirmationHash || recomputed !== record.confirmationHash) {
      throw conflict(
        'The parameters differ from the previewed rollback. Re-run azure_rollback_deployment ' +
          'without confirm and obtain approval for the new plan.',
      );
    }

    if (record.status === 'running' || record.status === 'succeeded') {
      return {
        phase: 'deployed',
        rollbackOf: target.id,
        result: this.describeStarted(record, true),
      };
    }
    if (record.status !== 'previewed' && record.status !== 'submitting') {
      throw conflict(`This rollback preview is in state ${record.status} and cannot be applied.`);
    }
    if (input.reason.trim().length === 0) {
      throw badRequest('azure_rollback_deployment requires a reason.');
    }

    assertNotCancelled(signal);
    const refreshedTarget = await this.deps.store.get(target.id, principal, signal);
    assertNotCancelled(signal);
    if (!refreshedTarget) {
      throw conflict('The rollback target disappeared before the operation was admitted.');
    }
    if (refreshedTarget.status !== 'succeeded') {
      throw conflict(
        `The rollback target changed to ${refreshedTarget.status} before the operation was admitted.`,
      );
    }
    const currentTarget = this.authorizeRollbackRecord(refreshedTarget);
    const confirmedScope = this.resolveStoredScope(record);
    if (
      scopeKeyOf(confirmedScope) !== currentTarget.scopeKey ||
      record.templateHash !== currentTarget.templateHash ||
      record.sourceHash !== currentTarget.sourceHash
    ) {
      throw conflict(
        'The rollback preview no longer matches the currently authorized deployment record. ' +
          'Produce a new rollback preview.',
      );
    }

    return {
      phase: 'deployed',
      rollbackOf: target.id,
      result: await this.start(
        record,
        currentTarget.template,
        parameters,
        input.reason,
        requestId,
        signal,
        confirmedScope,
      ),
    };
  }

  /**
   * Rebuilds the parameter set for a redeploy. Secure values were never stored, so the caller has
   * to supply them again — a rollback cannot silently reuse a secret the server does not hold.
   */
  private rebuildParameters(
    target: DeploymentRecord,
    supplied: Readonly<Record<string, string>> | undefined,
  ): Record<string, unknown> {
    const parameters: Record<string, unknown> = {};
    const missing: string[] = [];

    for (const [name, value] of Object.entries(target.sanitizedParameters)) {
      if (value !== REDACTED) {
        parameters[name] = value;
        continue;
      }
      const replacement = supplied?.[name];
      if (replacement === undefined) missing.push(name);
      else parameters[name] = replacement;
    }

    if (missing.length > 0) {
      throw badRequest(
        'This deployment used secure parameters, whose values are never stored. Supply them again ' +
          'in secureParameters to redeploy.',
        { missingSecureParameters: missing },
      );
    }
    return parameters;
  }

  private async previewRollback(
    target: DeploymentRecord,
    parameters: Record<string, unknown>,
    principal: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<WhatIfResult> {
    const template = target.template;
    if (!template) throw badRequest(`Record ${target.id} does not retain a template.`);

    const { normalized, summary } = await this.concurrency.run(
      () => this.preview({ scope: target.scope, template, parameters, signal }),
      signal,
    );
    assertNotCancelled(signal);

    const parametersHash = hashJson(parameters);
    const previewHash = hashJson({ summary, changes: normalized });
    const confirmationHash = computeConfirmationHash({
      sourceHash: target.sourceHash,
      templateHash: target.templateHash,
      parametersHash,
      scopeKey: target.scopeKey,
      mode: 'Incremental',
      previewHash,
    });

    const createdAt = this.now();
    const record: DeploymentRecord = {
      ...target,
      id: this.newId(),
      parametersHash,
      previewHash,
      confirmationHash,
      previewSummary: summary,
      sanitizedParameters: sanitizeParameters(parameters, target.secureParameterNames),
      status: 'previewed',
      armDeploymentId: undefined,
      armDeploymentName: undefined,
      correlationId: undefined,
      outputsMetadata: undefined,
      previousSuccessfulRecordId: target.id,
      rollbackOfRecordId: target.id,
      reason: undefined,
      requestId,
      error: undefined,
      principal,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + this.deps.config.deployments.previewTtlMs,
      ).toISOString(),
    };
    assertNotCancelled(signal);
    await this.deps.store.put(record, signal);
    assertNotCancelled(signal);
    this.audit('deployment.rollbackPreview', record, { rollbackOf: target.id });

    return {
      previewId: record.id,
      confirmationHash,
      expiresAt: record.expiresAt,
      scope: target.scope,
      mode: 'Incremental',
      sourceHash: target.sourceHash,
      templateHash: target.templateHash,
      summary,
      changes: normalized,
      diagnostics: [],
      warnings: [
        {
          code: 'rollback_is_a_redeploy',
          message:
            'Rollback redeploys a previously successful template. It does not undo data-plane ' +
            'changes, restore deleted resources, or revert changes made outside this server.',
        },
      ],
      resourceTypes: target.resourceTypes,
      secureParameterNames: target.secureParameterNames,
    };
  }

  /* ------------------------------------------------------------------ audit */

  private audit(event: string, record: DeploymentRecord, extra: Record<string, unknown>): void {
    this.deps.logger.info(
      {
        event,
        principal: record.principal,
        recordId: record.id,
        requestId: record.requestId,
        scope: record.scopeKey,
        mode: record.mode,
        status: record.status,
        sourceHash: record.sourceHash,
        templateHash: record.templateHash,
        parametersHash: record.parametersHash,
        confirmationHash: record.confirmationHash,
        resourceTypes: record.resourceTypes,
        armDeploymentId: record.armDeploymentId,
        correlationId: record.correlationId,
        reason: record.reason ?? null,
        ...extra,
      },
      event,
    );
  }
}

const resourceTypeOf = (resourceId: string): string => {
  const match = /\/providers\/([^/]+)\/(.+)$/i.exec(resourceId);
  if (!match) return '';
  const [, provider, rest] = match;
  const segments = (rest ?? '').split('/');
  const types = segments.filter((_, index) => index % 2 === 0);
  return `${provider ?? ''}/${types.join('/')}`.toLowerCase();
};

const outputsMetadata = (
  outputs: Record<string, unknown> | undefined,
): readonly { readonly name: string; readonly type: string }[] | undefined =>
  outputs === undefined
    ? undefined
    : Object.entries(outputs).map(([name, value]) => ({
        name,
        type:
          typeof value === 'object' && value !== null && 'type' in value
            ? String(value.type)
            : 'unknown',
      }));

/**
 * Deployment outputs can carry connection strings and keys. Secure-typed outputs and
 * conventionally sensitive names are reported by name only.
 */
const summarizeOutputs = (
  outputs: Record<string, unknown> | undefined,
): {
  outputs: readonly { readonly name: string; readonly value: unknown }[];
  redacted: readonly string[];
} => {
  if (!outputs) return { outputs: [], redacted: [] };
  const safe: { name: string; value: unknown }[] = [];
  const redacted: string[] = [];

  for (const [name, entry] of Object.entries(outputs)) {
    const type =
      typeof entry === 'object' && entry !== null && 'type' in entry
        ? String(entry.type).toLowerCase()
        : 'unknown';
    const value =
      typeof entry === 'object' && entry !== null && 'value' in entry ? entry.value : entry;

    if (type.startsWith('secure') || SENSITIVE_NAME.test(name)) {
      redacted.push(name);
      continue;
    }
    const serialized = JSON.stringify(value ?? null);
    safe.push({ name, value: serialized.length > 4096 ? '[truncated]' : value });
  }
  return { outputs: safe, redacted };
};

export const __testing = { sanitizeParameters, summarizeOutputs, resourceTypeOf };
