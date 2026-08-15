import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  assertModuleReferencesAllowed,
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
  DeploymentRecordStore,
  PreviewSummary,
} from '../deployments/records.js';
import type { Metrics } from '../util/metrics.js';
import { Semaphore } from '../util/semaphore.js';
import { scopeKeyOf, type DeploymentScopeInput, type Guardrails } from './guardrails.js';

const REDACTED = '[redacted]';

/** Names that conventionally carry secrets even when the template did not mark them secure. */
const SENSITIVE_NAME = /(password|secret|token|key|credential|connectionstring|sas|pfx)/i;

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
  private readonly concurrency: Semaphore;

  public constructor(private readonly deps: DeploymentServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.newId = deps.newId ?? ((): string => randomUUID());
    this.concurrency = new Semaphore(deps.config.deployments.maxConcurrent);
  }

  /* ------------------------------------------------------------- compiling */

  private async compile(bundleInput: BicepInput): Promise<{
    bundle: NormalizedBundle;
    diagnostics: readonly BicepDiagnostic[];
    template: Record<string, unknown> | undefined;
    inspection: TemplateInspection | undefined;
  }> {
    const bundle = normalizeBundle(bundleInput, this.deps.config.bicep.bundleLimits);
    // Module policy is enforced here, in the policy layer, rather than only inside the CLI adapter.
    // A different compiler adapter must not be able to widen what a caller may reference.
    assertModuleReferencesAllowed(bundle, this.deps.config.bicep.modulePolicy);

    const compiled = await this.deps.metrics.time('bicep_compile_ms', {}, () =>
      this.deps.compiler.compile({ bundle }),
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

  public async validate(input: ValidateInput): Promise<ValidateResult> {
    const { bundle, diagnostics, inspection } = await this.compile(input.bundle);
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
  }): Promise<{ normalized: readonly NormalizedChange[]; summary: PreviewSummary }> {
    const result = await this.deps.metrics.time(
      'arm_whatif_ms',
      { scope: options.scope.kind },
      () =>
        this.deps.provider.whatIfDeployment({
          scope: options.scope,
          deploymentName: `atsa-whatif-${this.newId()}`,
          template: options.template,
          parameters: toArmParameters(options.parameters),
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
  ): Promise<WhatIfResult> {
    this.deps.guardrails.assertDeploymentsEnabled();
    const scope = this.deps.guardrails.resolveDeploymentScope(input.scope);

    const { bundle, diagnostics, template, inspection } = await this.compile(input.bundle);
    if (!template || !inspection) {
      throw badRequest('The Bicep source did not compile, so it cannot be previewed.', {
        diagnostics: diagnostics.filter((entry) => entry.level === 'error').slice(0, 20),
      });
    }

    this.deps.guardrails.assertTemplateScopeMatches(inspection.templateScope, scope);
    this.deps.guardrails.assertCrossScopeTargetsAllowed(inspection.crossScopeTargets);

    const { normalized, summary } = await this.concurrency.run(() =>
      this.preview({ scope, template, parameters: input.parameters }),
    );

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
      previousSuccessfulRecordId: await this.findPreviousSuccessful(scopeKey, principal),
      reason: undefined,
      requestId,
      error: undefined,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + this.deps.config.deployments.previewTtlMs,
      ).toISOString(),
    };
    await this.deps.store.put(record);

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
  ): Promise<string | undefined> {
    const history = await this.deps.store.listByScope(scopeKey, principal, 20);
    return history.find((entry) => entry.status === 'succeeded')?.id;
  }

  /* -------------------------------------------------------------- deploying */

  public async deploy(
    input: DeployInput,
    principal: string,
    requestId: string,
  ): Promise<DeployResult> {
    this.deps.guardrails.assertDeploymentsEnabled();
    if (!input.confirm) {
      throw badRequest(
        'azure_deploy_bicep requires confirm=true. Show the user the what-if preview and obtain ' +
          'explicit approval first.',
      );
    }
    if (input.reason.trim().length === 0) {
      throw badRequest('azure_deploy_bicep requires a reason, which is recorded in the audit log.');
    }

    const scope = this.deps.guardrails.resolveDeploymentScope(input.scope);
    const record = await this.deps.store.findByConfirmationHash(input.confirmationHash, principal);
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
    const { bundle, template, inspection } = await this.compile(input.bundle);
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
    if (record.status !== 'previewed') {
      throw conflict(`This preview is in state ${record.status} and cannot be deployed again.`);
    }

    return this.start(record, template, input.parameters, input.reason, requestId);
  }

  private async start(
    record: DeploymentRecord,
    template: Record<string, unknown>,
    parameters: Readonly<Record<string, unknown>>,
    reason: string,
    requestId: string,
  ): Promise<DeployResult> {
    const deploymentName = `atsa-${record.id}`.slice(0, 64);

    const started = await this.deps.store.withScopeLock(record.scopeKey, () =>
      this.concurrency.run(() =>
        this.deps.metrics.time('arm_deploy_start_ms', { scope: record.scope.kind }, () =>
          this.deps.provider.beginDeployment({
            scope: record.scope,
            deploymentName,
            template,
            parameters: toArmParameters(parameters),
          }),
        ),
      ),
    );

    const updated = await this.deps.store.patch(record.id, record.principal, {
      status: 'running',
      armDeploymentId: started.id,
      armDeploymentName: deploymentName,
      correlationId: started.correlationId,
      reason,
      updatedAt: this.now().toISOString(),
    });

    this.deps.metrics.increment('deployments_started_total', { scope: record.scope.kind });
    this.audit('deployment.started', updated ?? record, {
      deploymentName,
      reason,
      requestId,
    });

    return this.describeStarted(updated ?? record, false);
  }

  private describeStarted(record: DeploymentRecord, alreadyStarted: boolean): DeployResult {
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
      message: alreadyStarted
        ? 'This deployment was already started; reporting the existing deployment rather than starting another.'
        : 'The deployment was accepted by Azure. Poll azure_get_deployment for progress.',
    };
  }

  /* ----------------------------------------------------------------- status */

  private async resolveTarget(
    input: {
      readonly recordId?: string | undefined;
      readonly scope?: DeploymentScopeInput | undefined;
      readonly deploymentName?: string | undefined;
    },
    principal: string,
  ): Promise<{
    scope: DeploymentScope;
    deploymentName: string;
    record: DeploymentRecord | undefined;
  }> {
    if (input.recordId) {
      const record = await this.deps.store.get(input.recordId, principal);
      if (!record) throw notFound(`No deployment record ${input.recordId} for this caller`);
      if (!record.armDeploymentName) {
        throw badRequest(
          `Record ${record.id} is a preview that was never deployed, so it has no Azure status.`,
        );
      }
      return { scope: record.scope, deploymentName: record.armDeploymentName, record };
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
  ): Promise<DeploymentStatusResult> {
    this.deps.guardrails.assertDeploymentsEnabled();
    const target = await this.resolveTarget(input, principal);
    const status = await this.deps.provider.getDeployment(target.scope, target.deploymentName);

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

  private async reconcile(record: DeploymentRecord, status: ArmDeploymentStatus): Promise<void> {
    const state = status.provisioningState.toLowerCase();
    const mapped =
      state === 'succeeded'
        ? 'succeeded'
        : state === 'failed'
          ? 'failed'
          : state === 'canceled' || state === 'cancelled'
            ? 'canceled'
            : 'running';
    if (mapped === record.status) return;

    await this.deps.store.patch(record.id, record.principal, {
      status: mapped,
      correlationId: status.correlationId ?? record.correlationId,
      outputsMetadata: outputsMetadata(status.outputs),
      error: status.error,
      updatedAt: this.now().toISOString(),
    });
    this.deps.metrics.increment('deployments_completed_total', {
      scope: record.scope.kind,
      outcome: mapped,
    });
    this.audit(
      'deployment.state',
      { ...record, status: mapped },
      { provisioningState: status.provisioningState },
    );
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
  ): Promise<{
    readonly recordId: string | undefined;
    readonly deploymentName: string;
    readonly operations: readonly DeploymentOperationSummary[];
    readonly skipToken: string | undefined;
  }> {
    this.deps.guardrails.assertDeploymentsEnabled();
    const target = await this.resolveTarget(input, principal);
    const top = Math.min(input.limit, this.deps.config.deployments.maxOperations);
    const page = await this.deps.provider.listDeploymentOperations(
      target.scope,
      target.deploymentName,
      { top, skipToken: input.skipToken },
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
  ): Promise<
    | { readonly phase: 'preview'; readonly preview: WhatIfResult; readonly rollbackOf: string }
    | { readonly phase: 'deployed'; readonly result: DeployResult; readonly rollbackOf: string }
  > {
    this.deps.guardrails.assertDeploymentsEnabled();

    const target = await this.deps.store.get(input.recordId, principal);
    if (!target) throw notFound(`No deployment record ${input.recordId} for this caller`);
    if (target.status !== 'succeeded') {
      throw badRequest(
        `Record ${target.id} is in state ${target.status}. Only a previously successful ` +
          'deployment can be redeployed.',
      );
    }
    if (!target.template) {
      throw badRequest(`Record ${target.id} does not retain a template and cannot be redeployed.`);
    }

    const parameters = this.rebuildParameters(target, input.secureParameters);

    if (!input.confirm || !input.confirmationHash) {
      return {
        phase: 'preview',
        rollbackOf: target.id,
        preview: await this.previewRollback(target, parameters, principal, requestId),
      };
    }

    const record = await this.deps.store.findByConfirmationHash(input.confirmationHash, principal);
    if (!record || record.previousSuccessfulRecordId !== target.id) {
      throw badRequest(
        'confirmationHash does not match a recent rollback preview for this record. Re-run ' +
          'azure_rollback_deployment without confirm to produce a fresh preview.',
      );
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      throw badRequest(`The rollback preview expired at ${record.expiresAt}. Produce a new one.`);
    }
    if (record.status === 'running' || record.status === 'succeeded') {
      return {
        phase: 'deployed',
        rollbackOf: target.id,
        result: this.describeStarted(record, true),
      };
    }
    if (record.status !== 'previewed') {
      throw conflict(`This rollback preview is in state ${record.status} and cannot be applied.`);
    }
    if (input.reason.trim().length === 0) {
      throw badRequest('azure_rollback_deployment requires a reason.');
    }

    return {
      phase: 'deployed',
      rollbackOf: target.id,
      result: await this.start(record, target.template, parameters, input.reason, requestId),
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
  ): Promise<WhatIfResult> {
    const template = target.template;
    if (!template) throw badRequest(`Record ${target.id} does not retain a template.`);

    const { normalized, summary } = await this.concurrency.run(() =>
      this.preview({ scope: target.scope, template, parameters }),
    );

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
    await this.deps.store.put(record);
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
