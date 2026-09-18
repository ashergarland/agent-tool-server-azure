import { createHash, randomUUID } from 'node:crypto';
import { TableClient } from '@azure/data-tables';
import type { TokenCredential } from '@azure/core-auth';
import { AppError, conflict, internalError, timedOut } from '@agent-tool-platform/runtime/errors';
import { azureSdkOperationOptions } from '../provider/azure/options.js';
import { applyDeploymentRecordPatch, DeploymentLeaseLostError } from './records.js';
import type {
  DeploymentRecord,
  DeploymentRecordPatch,
  DeploymentRecordPatchOptions,
  DeploymentRecordPatchResult,
  DeploymentRecordStore,
  DeploymentStoreInfo,
} from './records.js';

/** Table Storage caps a single string property; records are chunked below that. */
const CHUNK_CHARS = 28_000;
const MAX_CHUNKS = 32;

export interface AzureTableStoreOptions {
  readonly accountUrl: string;
  readonly recordsTable: string;
  readonly locksTable: string;
  readonly lockTtlMs: number;
  readonly requestTimeoutMs: number;
}

export interface AzureTableStoreLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

interface RecordEntity {
  partitionKey: string;
  rowKey: string;
  confirmationHash: string;
  scopeKey: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  chunks: number;
  [chunk: string]: unknown;
}

interface LockEntity {
  partitionKey: string;
  rowKey: string;
  ownerId: string;
  expiresAt: string;
  [property: string]: unknown;
}

const principalKey = (principal: string): string =>
  createHash('sha256').update(principal, 'utf8').digest('hex');

const scopeRowKey = (scopeKey: string): string =>
  createHash('sha256').update(scopeKey, 'utf8').digest('hex');

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;

const assertNotCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw timedOut('The request was cancelled');
};

const awaitWithCancellation = <T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (signal === undefined) return pending;
  assertNotCancelled(signal);

  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => {
      signal.removeEventListener('abort', cancelled);
      reject(new AppError('timeout', 'The request was cancelled'));
    };
    signal.addEventListener('abort', cancelled, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', cancelled);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancelled);
        reject(
          error instanceof Error
            ? error
            : internalError('The deployment record store operation failed', error),
        );
      },
    );
  });
};

/**
 * Azure Table Storage implementation.
 *
 * State lives outside the container, so the app can scale to zero between calls without losing a
 * pending preview, and two replicas see the same records. Access uses the server's managed
 * identity: no connection string or account key is ever configured.
 */
export class AzureTableDeploymentRecordStore implements DeploymentRecordStore {
  private readonly records: TableClient;
  private readonly locks: TableClient;
  private ensured: Promise<void> | undefined;

  public constructor(
    credential: TokenCredential,
    private readonly options: AzureTableStoreOptions,
    private readonly logger: AzureTableStoreLogger,
  ) {
    this.records = new TableClient(options.accountUrl, options.recordsTable, credential);
    this.locks = new TableClient(options.accountUrl, options.locksTable, credential);
  }

  private reportLockReleaseFailure(error: unknown, scopeKey: string): void {
    try {
      this.logger.warn(
        {
          err: error,
          event: 'deployment.lock.release.failed',
          scopeKey,
        },
        'distributed deployment lock release failed; TTL reclamation remains active',
      );
    } catch {
      process.emitWarning('The distributed deployment lock release and its logger both failed.', {
        code: 'AZURE_LOCK_RELEASE_LOG_FAILURE',
      });
    }
  }

  private async ensureTables(signal?: AbortSignal): Promise<void> {
    if (!this.ensured) {
      const setup = (async () => {
        await this.records
          .createTable(azureSdkOperationOptions(this.options.requestTimeoutMs))
          .catch((error: unknown) => {
            if (statusOf(error) !== 409) throw error;
          });
        await this.locks
          .createTable(azureSdkOperationOptions(this.options.requestTimeoutMs))
          .catch((error: unknown) => {
            if (statusOf(error) !== 409) throw error;
          });
      })();
      this.ensured = setup;
      void setup.catch(() => {
        if (this.ensured === setup) this.ensured = undefined;
      });
    }
    await awaitWithCancellation(this.ensured, signal);
  }

  private toEntity(record: DeploymentRecord): RecordEntity {
    const serialized = JSON.stringify(record);
    const chunks: string[] = [];
    for (let index = 0; index < serialized.length; index += CHUNK_CHARS) {
      chunks.push(serialized.slice(index, index + CHUNK_CHARS));
    }
    if (chunks.length > MAX_CHUNKS) {
      throw new AppError(
        'bad_request',
        'The deployment record is too large to store. Reduce the size of the template or split ' +
          'the deployment.',
      );
    }

    const entity: RecordEntity = {
      partitionKey: principalKey(record.principal),
      rowKey: record.id,
      confirmationHash: record.confirmationHash,
      scopeKey: record.scopeKey,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      chunks: chunks.length,
    };
    chunks.forEach((chunk, index) => {
      entity[`d${index}`] = chunk;
    });
    return entity;
  }

  private static fromEntity(entity: RecordEntity, principal: string): DeploymentRecord | undefined {
    const parts: string[] = [];
    for (let index = 0; index < entity.chunks; index += 1) {
      const chunk = entity[`d${index}`];
      if (typeof chunk !== 'string') return undefined;
      parts.push(chunk);
    }
    try {
      const parsed = JSON.parse(parts.join('')) as DeploymentRecord;
      // Defence in depth: the partition key already isolates principals, but a record is only ever
      // returned to the principal it claims to belong to.
      return parsed.principal === principal ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  public async put(record: DeploymentRecord, signal?: AbortSignal): Promise<void> {
    await this.ensureTables(signal);
    await awaitWithCancellation(
      this.records.upsertEntity(
        this.toEntity(record),
        'Replace',
        azureSdkOperationOptions(this.options.requestTimeoutMs, signal),
      ),
      signal,
    );
  }

  public async patch(
    id: string,
    principal: string,
    patch: DeploymentRecordPatch,
    signal?: AbortSignal,
    options?: DeploymentRecordPatchOptions,
  ): Promise<DeploymentRecordPatchResult | undefined> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const entity = await this.getRecordEntity(id, principal, signal);
      if (!entity) return undefined;
      const existing = AzureTableDeploymentRecordStore.fromEntity(entity, principal);
      if (!existing) {
        throw internalError(`Deployment record ${id} is corrupt or incomplete`);
      }
      const result = applyDeploymentRecordPatch(existing, patch, options);
      if (!result.applied) return result;

      try {
        await awaitWithCancellation(
          this.records.updateEntity(this.toEntity(result.record), 'Replace', {
            ...azureSdkOperationOptions(this.options.requestTimeoutMs, signal),
            etag: entity.etag,
          }),
          signal,
        );
        return result;
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        if (statusOf(error) !== 412) throw error;
      }
    }
    throw conflict(
      `Deployment record ${id} changed repeatedly while it was being updated. Retry the request.`,
    );
  }

  private async getRecordEntity(id: string, principal: string, signal?: AbortSignal) {
    await this.ensureTables(signal);
    try {
      return await awaitWithCancellation(
        this.records.getEntity<RecordEntity>(
          principalKey(principal),
          id,
          azureSdkOperationOptions(this.options.requestTimeoutMs, signal),
        ),
        signal,
      );
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
  }

  public async get(
    id: string,
    principal: string,
    signal?: AbortSignal,
  ): Promise<DeploymentRecord | undefined> {
    const entity = await this.getRecordEntity(id, principal, signal);
    return entity ? AzureTableDeploymentRecordStore.fromEntity(entity, principal) : undefined;
  }

  private async query(
    principal: string,
    filter: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DeploymentRecord[]> {
    await this.ensureTables(signal);
    const found: DeploymentRecord[] = [];
    const iterator = this.records.listEntities<RecordEntity>({
      queryOptions: { filter: `PartitionKey eq '${principalKey(principal)}' and ${filter}` },
      ...azureSdkOperationOptions(this.options.requestTimeoutMs, signal),
    });
    for await (const entity of iterator) {
      assertNotCancelled(signal);
      const record = AzureTableDeploymentRecordStore.fromEntity(entity, principal);
      if (record) found.push(record);
      if (found.length >= limit) break;
    }
    return found.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  public async findByConfirmationHash(
    confirmationHash: string,
    principal: string,
    signal?: AbortSignal,
  ): Promise<DeploymentRecord | undefined> {
    if (!/^[0-9a-f]{64}$/.test(confirmationHash)) return undefined;
    const matches = await this.query(
      principal,
      `confirmationHash eq '${confirmationHash}'`,
      5,
      signal,
    );
    return matches[0];
  }

  public listByScope(
    scopeKey: string,
    principal: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DeploymentRecord[]> {
    // scopeKey is server-built from validated identifiers, so it cannot contain a quote.
    return this.query(principal, `scopeKey eq '${scopeKey.replace(/'/g, "''")}'`, limit, signal);
  }

  public async withScopeLock<T>(
    scopeKey: string,
    run: (leaseSignal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.ensureTables(signal);
    const rowKey = scopeRowKey(scopeKey);
    const ownerId = randomUUID();
    const operationOptions = (abortSignal?: AbortSignal) =>
      azureSdkOperationOptions(this.options.requestTimeoutMs, abortSignal);

    const acquire = async (): Promise<string | undefined> => {
      const entity: LockEntity = {
        partitionKey: 'lock',
        rowKey,
        ownerId,
        expiresAt: new Date(Date.now() + this.options.lockTtlMs).toISOString(),
      };
      try {
        const created = await this.locks.createEntity(entity, operationOptions());
        if (created.etag) return created.etag;
        const current = await this.locks.getEntity<LockEntity>('lock', rowKey, operationOptions());
        if (current.ownerId !== ownerId) {
          throw conflict(`The distributed deployment lock for ${scopeKey} changed owners.`);
        }
        return current.etag;
      } catch (error) {
        if (statusOf(error) !== 409) throw error;
        return undefined;
      }
    };

    assertNotCancelled(signal);
    let lockEtag = await acquire();
    if (!lockEtag) {
      // A lock whose lease has expired belonged to a replica that died mid-deployment. Reclaim it
      // conditionally, then give up: two live callers must not both proceed.
      const existing = await this.locks
        .getEntity<LockEntity>('lock', rowKey, operationOptions())
        .catch((error: unknown) => {
          if (statusOf(error) === 404) return undefined;
          throw error;
        });
      if (existing && Date.parse(existing.expiresAt) < Date.now()) {
        try {
          await this.locks.deleteEntity('lock', rowKey, {
            ...operationOptions(),
            etag: existing.etag,
          });
          lockEtag = await acquire();
        } catch (error) {
          if (statusOf(error) !== 404 && statusOf(error) !== 412) throw error;
        }
      }
    }
    if (!lockEtag) {
      assertNotCancelled(signal);
      throw conflict(
        `Another deployment is already in progress for ${scopeKey}. Wait for it to finish before starting another.`,
      );
    }
    let currentEtag = lockEtag;

    const leaseController = new AbortController();
    let stopped = false;
    let renewalPending = Promise.resolve();
    const renew = async (): Promise<void> => {
      if (stopped || leaseController.signal.aborted) return;
      try {
        const renewed = await this.locks.updateEntity(
          {
            partitionKey: 'lock',
            rowKey,
            ownerId,
            expiresAt: new Date(Date.now() + this.options.lockTtlMs).toISOString(),
          },
          'Replace',
          {
            ...operationOptions(),
            etag: currentEtag,
          },
        );
        if (renewed.etag) {
          currentEtag = renewed.etag;
        } else {
          const current = await this.locks.getEntity<LockEntity>(
            'lock',
            rowKey,
            operationOptions(),
          );
          if (current.ownerId !== ownerId) {
            throw conflict(`The distributed deployment lock for ${scopeKey} changed owners.`);
          }
          currentEtag = current.etag;
        }
      } catch (error) {
        leaseController.abort(new DeploymentLeaseLostError(scopeKey, error));
      }
    };
    const renewalTimer = setInterval(
      () => {
        renewalPending = renewalPending.then(renew);
      },
      Math.floor(this.options.lockTtlMs / 3),
    );

    try {
      assertNotCancelled(signal);
      return await run(leaseController.signal);
    } finally {
      stopped = true;
      clearInterval(renewalTimer);
      await renewalPending;
      try {
        const current = await this.locks.getEntity<LockEntity>('lock', rowKey, operationOptions());
        if (current.ownerId === ownerId) {
          await this.locks.deleteEntity('lock', rowKey, {
            ...operationOptions(),
            etag: current.etag,
          });
        }
      } catch (error) {
        if (statusOf(error) !== 404 && statusOf(error) !== 412) {
          this.reportLockReleaseFailure(error, scopeKey);
        }
      }
    }
  }

  public describe(): DeploymentStoreInfo {
    return { kind: 'azure-table', detail: this.options.recordsTable };
  }

  public async ping(signal?: AbortSignal): Promise<void> {
    try {
      await this.ensureTables(signal);
      const iterator = this.records
        .listEntities({
          queryOptions: { filter: "PartitionKey eq 'probe'" },
          ...azureSdkOperationOptions(this.options.requestTimeoutMs, signal),
        })
        .byPage({ maxPageSize: 1 });
      await awaitWithCancellation(iterator.next(), signal);
    } catch (error) {
      if (signal?.aborted) throw timedOut('The request was cancelled');
      throw internalError('The deployment record store is unreachable', error);
    }
  }
}
