import { conflict } from '../errors.js';
import type {
  DeploymentRecord,
  DeploymentRecordPatch,
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

  public put(record: DeploymentRecord): Promise<void> {
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
  ): Promise<DeploymentRecord | undefined> {
    const key = this.key(id, principal);
    const existing = this.records.get(key);
    if (!existing) return Promise.resolve(undefined);
    const updated: DeploymentRecord = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.records.set(key, updated);
    return Promise.resolve(updated);
  }

  public get(id: string, principal: string): Promise<DeploymentRecord | undefined> {
    return Promise.resolve(this.records.get(this.key(id, principal)));
  }

  public findByConfirmationHash(
    confirmationHash: string,
    principal: string,
  ): Promise<DeploymentRecord | undefined> {
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
  ): Promise<readonly DeploymentRecord[]> {
    const matches = [...this.records.values()]
      .filter((record) => record.principal === principal && record.scopeKey === scopeKey)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
    return Promise.resolve(matches);
  }

  public async withScopeLock<T>(scopeKey: string, run: () => Promise<T>): Promise<T> {
    const pending = this.locks.get(scopeKey);
    if (pending) {
      throw conflict(
        `Another deployment is already in progress for ${scopeKey}. Wait for it to finish before starting another.`,
      );
    }
    const task = run();
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

  public ping(): Promise<void> {
    return Promise.resolve();
  }
}
