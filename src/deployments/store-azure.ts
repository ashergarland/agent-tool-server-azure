import { createHash } from 'node:crypto';
import { TableClient, type TableEntity } from '@azure/data-tables';
import type { TokenCredential } from '@azure/core-auth';
import { AppError, conflict, internalError } from '../errors.js';
import type {
  DeploymentRecord,
  DeploymentRecordPatch,
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
  expiresAt: string;
}

const principalKey = (principal: string): string =>
  createHash('sha256').update(principal, 'utf8').digest('hex');

const scopeRowKey = (scopeKey: string): string =>
  createHash('sha256').update(scopeKey, 'utf8').digest('hex');

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;

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
  ) {
    this.records = new TableClient(options.accountUrl, options.recordsTable, credential);
    this.locks = new TableClient(options.accountUrl, options.locksTable, credential);
  }

  private ensureTables(): Promise<void> {
    this.ensured ??= (async () => {
      await this.records.createTable().catch((error: unknown) => {
        if (statusOf(error) !== 409) throw error;
      });
      await this.locks.createTable().catch((error: unknown) => {
        if (statusOf(error) !== 409) throw error;
      });
    })();
    return this.ensured;
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

  public async put(record: DeploymentRecord): Promise<void> {
    await this.ensureTables();
    await this.records.upsertEntity(this.toEntity(record), 'Replace');
  }

  public async patch(
    id: string,
    principal: string,
    patch: DeploymentRecordPatch,
  ): Promise<DeploymentRecord | undefined> {
    const existing = await this.get(id, principal);
    if (!existing) return undefined;
    const updated: DeploymentRecord = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await this.put(updated);
    return updated;
  }

  public async get(id: string, principal: string): Promise<DeploymentRecord | undefined> {
    await this.ensureTables();
    try {
      const entity = await this.records.getEntity<RecordEntity>(principalKey(principal), id);
      return AzureTableDeploymentRecordStore.fromEntity(entity, principal);
    } catch (error) {
      if (statusOf(error) === 404) return undefined;
      throw error;
    }
  }

  private async query(
    principal: string,
    filter: string,
    limit: number,
  ): Promise<readonly DeploymentRecord[]> {
    await this.ensureTables();
    const found: DeploymentRecord[] = [];
    const iterator = this.records.listEntities<RecordEntity>({
      queryOptions: { filter: `PartitionKey eq '${principalKey(principal)}' and ${filter}` },
    });
    for await (const entity of iterator) {
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
  ): Promise<DeploymentRecord | undefined> {
    if (!/^[0-9a-f]{64}$/.test(confirmationHash)) return undefined;
    const matches = await this.query(principal, `confirmationHash eq '${confirmationHash}'`, 5);
    return matches[0];
  }

  public listByScope(
    scopeKey: string,
    principal: string,
    limit: number,
  ): Promise<readonly DeploymentRecord[]> {
    // scopeKey is server-built from validated identifiers, so it cannot contain a quote.
    return this.query(principal, `scopeKey eq '${scopeKey.replace(/'/g, "''")}'`, limit);
  }

  public async withScopeLock<T>(scopeKey: string, run: () => Promise<T>): Promise<T> {
    await this.ensureTables();
    const rowKey = scopeRowKey(scopeKey);
    const entity: LockEntity = {
      partitionKey: 'lock',
      rowKey,
      expiresAt: new Date(Date.now() + this.options.lockTtlMs).toISOString(),
    };

    const acquire = async (): Promise<boolean> => {
      try {
        await this.locks.createEntity(entity as unknown as TableEntity);
        return true;
      } catch (error) {
        if (statusOf(error) !== 409) throw error;
        return false;
      }
    };

    let acquired = await acquire();
    if (!acquired) {
      // A lock whose lease has expired belonged to a replica that died mid-deployment. Reclaim it
      // once, then give up: two live callers must not both proceed.
      const existing = await this.locks
        .getEntity<LockEntity>('lock', rowKey)
        .catch(() => undefined);
      if (existing && Date.parse(existing.expiresAt) < Date.now()) {
        await this.locks.deleteEntity('lock', rowKey).catch(() => undefined);
        acquired = await acquire();
      }
    }
    if (!acquired) {
      throw conflict(
        `Another deployment is already in progress for ${scopeKey}. Wait for it to finish before starting another.`,
      );
    }

    try {
      return await run();
    } finally {
      await this.locks.deleteEntity('lock', rowKey).catch(() => undefined);
    }
  }

  public describe(): DeploymentStoreInfo {
    return { kind: 'azure-table', detail: this.options.recordsTable };
  }

  public async ping(): Promise<void> {
    try {
      await this.ensureTables();
      const iterator = this.records
        .listEntities({ queryOptions: { filter: "PartitionKey eq 'probe'" } })
        .byPage({ maxPageSize: 1 });
      await iterator.next();
    } catch (error) {
      throw internalError('The deployment record store is unreachable', error);
    }
  }
}
