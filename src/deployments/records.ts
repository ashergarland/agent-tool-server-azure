import type { DeploymentScope } from '../provider/types.js';

export type DeploymentRecordStatus =
  'previewed' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'superseded';

export interface PreviewSummary {
  readonly totalChanges: number;
  readonly countsByChangeType: Readonly<Record<string, number>>;
  readonly deletes: readonly string[];
  readonly unsupported: readonly string[];
  readonly truncated: boolean;
}

/**
 * The durable record of one deployment attempt.
 *
 * Everything needed to bind a preview to an execution, to report status later, and to redeploy a
 * previously successful revision is here. Nothing secret is: secure parameter values are replaced
 * before the record is written, and outputs are reduced to names and types.
 */
export interface DeploymentRecord {
  readonly id: string;
  /** Owning caller. Records are never visible across principals. */
  readonly principal: string;
  readonly scopeKey: string;
  readonly scope: DeploymentScope;
  readonly mode: 'Incremental';
  readonly sourceHash: string;
  readonly templateHash: string;
  readonly parametersHash: string;
  readonly previewHash: string;
  readonly confirmationHash: string;
  readonly previewSummary: PreviewSummary;
  readonly resourceTypes: readonly string[];
  /** Parameters with every secure value replaced by a redaction marker. */
  readonly sanitizedParameters: Readonly<Record<string, unknown>>;
  readonly secureParameterNames: readonly string[];
  /** Compiled ARM template, retained so a prior revision can be redeployed. */
  readonly template: Record<string, unknown> | undefined;
  readonly status: DeploymentRecordStatus;
  readonly armDeploymentId: string | undefined;
  readonly armDeploymentName: string | undefined;
  readonly correlationId: string | undefined;
  readonly outputsMetadata: readonly { readonly name: string; readonly type: string }[] | undefined;
  /** The most recent successful deployment at this scope when the preview was taken. */
  readonly previousSuccessfulRecordId: string | undefined;
  /**
   * Set only on a rollback preview, naming the record being redeployed.
   *
   * This is deliberately distinct from {@link previousSuccessfulRecordId}, which every preview
   * carries: a rollback confirmation must not be satisfiable by an ordinary preview that happens to
   * follow the same successful deployment.
   */
  readonly rollbackOfRecordId: string | undefined;
  readonly reason: string | undefined;
  readonly requestId: string | undefined;
  readonly error: { readonly code: string; readonly message: string } | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** After this instant the preview is stale and can no longer authorise a deployment. */
  readonly expiresAt: string;
}

export type DeploymentRecordPatch = Partial<
  Pick<
    DeploymentRecord,
    | 'status'
    | 'armDeploymentId'
    | 'armDeploymentName'
    | 'correlationId'
    | 'outputsMetadata'
    | 'previousSuccessfulRecordId'
    | 'reason'
    | 'error'
    | 'updatedAt'
  >
>;

export interface DeploymentRecordPatchResult {
  readonly record: DeploymentRecord;
  readonly applied: boolean;
}

export interface DeploymentRecordPatchOptions {
  readonly expectedStatuses?: readonly DeploymentRecordStatus[];
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<DeploymentRecordStatus, readonly DeploymentRecordStatus[]>
> = {
  previewed: ['submitting', 'superseded'],
  submitting: ['running', 'succeeded', 'failed', 'canceled'],
  running: ['succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
  superseded: [],
};

/**
 * Applies a record patch without allowing stale writers to regress or replace a terminal state.
 * Stores call this again after every optimistic-concurrency retry.
 */
export const applyDeploymentRecordPatch = (
  existing: DeploymentRecord,
  patch: DeploymentRecordPatch,
  options: DeploymentRecordPatchOptions = {},
): DeploymentRecordPatchResult => {
  if (
    options.expectedStatuses !== undefined &&
    !options.expectedStatuses.includes(existing.status)
  ) {
    return { record: existing, applied: false };
  }
  if (patch.status !== undefined) {
    if (patch.status === existing.status) return { record: existing, applied: false };
    if (!ALLOWED_STATUS_TRANSITIONS[existing.status].includes(patch.status)) {
      return { record: existing, applied: false };
    }
  }
  return {
    record: {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    },
    applied: true,
  };
};

export interface DeploymentStoreInfo {
  readonly kind: string;
  readonly detail: string | undefined;
}

/**
 * Port for deployment records. The in-memory implementation backs local development and tests; the
 * Azure implementation keeps records outside the container so a scale-to-zero app loses nothing.
 */
export interface DeploymentRecordStore {
  put(record: DeploymentRecord, signal?: AbortSignal): Promise<void>;
  patch(
    id: string,
    principal: string,
    patch: DeploymentRecordPatch,
    signal?: AbortSignal,
    options?: DeploymentRecordPatchOptions,
  ): Promise<DeploymentRecordPatchResult | undefined>;
  get(id: string, principal: string, signal?: AbortSignal): Promise<DeploymentRecord | undefined>;
  findByConfirmationHash(
    confirmationHash: string,
    principal: string,
    signal?: AbortSignal,
  ): Promise<DeploymentRecord | undefined>;
  /** Most recent first. */
  listByScope(
    scopeKey: string,
    principal: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DeploymentRecord[]>;
  /** Serialises concurrent work against one scope. */
  withScopeLock<T>(
    scopeKey: string,
    run: (leaseSignal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  describe(): DeploymentStoreInfo;
  /** Readiness probe. Must reject when the store is unusable. */
  ping(signal?: AbortSignal): Promise<void>;
}
