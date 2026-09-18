import { conflict, timedOut } from '@agent-tool-platform/runtime/errors';
import { applyDeploymentRecordPatch } from './records.js';
import type {
  DeploymentRecord,
  DeploymentRecordPatch,
  DeploymentRecordPatchOptions,
  DeploymentRecordPatchResult,
  DeploymentRecordStore,
  DeploymentStoreInfo,
} from './records.js';

/**
 * Local-development and test implementation.
 *
 * Records live only in this process, so a restart forgets every preview. That is correct for a
 * developer laptop and unacceptable in Azure, which is why the Azure implementation exists and why
 * production configuration refuses this one.
 */
export class InMemoryDeploymentRecordStore implements DeploymentRecordStore {
  private readonly records = new Map<string, DeploymentRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();

  public constructor(private readonly maxRecords = 500) {}

  private key(id: string, principal: string): string {
    return `${principal}\u0000${id}`;
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw timedOut('The request was cancelled');
  }

  public put(record: DeploymentRecord, signal?: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    this.records.set(this.key(record.id, record.principal), record);
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.records.delete(oldest.value);
    }
    return Promise.resolve();
  }

  public patch(
    id: string,
    principal: string,
    patch: DeploymentRecordPatch,
    signal?: AbortSignal,
    options?: DeploymentRecordPatchOptions,
  ): Promise<DeploymentRecordPatchResult | undefined> {
    this.assertNotCancelled(signal);
    const key = this.key(id, principal);
    const existing = this.records.get(key);
    if (!existing) return Promise.resolve(undefined);
    const result = applyDeploymentRecordPatch(existing, patch, options);
    if (result.applied) this.records.set(key, result.record);
    return Promise.resolve(result);
  }

  public get(
    id: string,
    principal: string,
    signal?: AbortSignal,
  ): Promise<DeploymentRecord | undefined> {
    this.assertNotCancelled(signal);
    return Promise.resolve(this.records.get(this.key(id, principal)));
  }

  public findByConfirmationHash(
    confirmationHash: string,
    principal: string,
    signal?: AbortSignal,
  ): Promise<DeploymentRecord | undefined> {
    this.assertNotCancelled(signal);
    for (const record of [...this.records.values()].reverse()) {
      if (record.principal === principal && record.confirmationHash === confirmationHash) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(undefined);
  }

  public listByScope(
    scopeKey: string,
    principal: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DeploymentRecord[]> {
    this.assertNotCancelled(signal);
    const matches = [...this.records.values()]
      .filter((record) => record.principal === principal && record.scopeKey === scopeKey)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
    return Promise.resolve(matches);
  }

  public async withScopeLock<T>(
    scopeKey: string,
    run: (leaseSignal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertNotCancelled(signal);
    const pending = this.locks.get(scopeKey);
    if (pending) {
      throw conflict(
        `Another deployment is already in progress for ${scopeKey}. Wait for it to finish before starting another.`,
      );
    }
    const task = run(new AbortController().signal);
    this.locks.set(
      scopeKey,
      task.catch(() => undefined),
    );
    try {
      return await task;
    } finally {
      this.locks.delete(scopeKey);
    }
  }

  public describe(): DeploymentStoreInfo {
    return { kind: 'memory', detail: `${this.records.size} records held in this process` };
  }

  public ping(signal?: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    return Promise.resolve();
  }
}
