import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenCredential } from '@azure/core-auth';
import type { DeploymentRecord } from '../../src/deployments/records.js';

interface StoredEntity extends Record<string, unknown> {
  partitionKey: string;
  rowKey: string;
  etag: string;
}

const tableError = (statusCode: number): Error & { statusCode: number } =>
  Object.assign(new Error(`table status ${statusCode}`), { statusCode });

class FakeTable {
  public readonly entities = new Map<string, StoredEntity>();
  public beforeUpdate: ((entity: Readonly<Record<string, unknown>>) => Promise<void>) | undefined;
  private version = 0;

  private key(partitionKey: string, rowKey: string): string {
    return `${partitionKey}\u0000${rowKey}`;
  }

  private nextEtag(): string {
    this.version += 1;
    return `etag-${this.version}`;
  }

  public createTable(): Promise<void> {
    return Promise.resolve();
  }

  public createEntity(entity: Record<string, unknown>): Promise<{ etag: string }> {
    const partitionKey = String(entity['partitionKey']);
    const rowKey = String(entity['rowKey']);
    const key = this.key(partitionKey, rowKey);
    if (this.entities.has(key)) return Promise.reject(tableError(409));
    const etag = this.nextEtag();
    this.entities.set(key, { ...entity, partitionKey, rowKey, etag });
    return Promise.resolve({ etag });
  }

  public upsertEntity(entity: Record<string, unknown>): Promise<void> {
    const partitionKey = String(entity['partitionKey']);
    const rowKey = String(entity['rowKey']);
    this.entities.set(this.key(partitionKey, rowKey), {
      ...entity,
      partitionKey,
      rowKey,
      etag: this.nextEtag(),
    });
    return Promise.resolve();
  }

  public async updateEntity(
    entity: Record<string, unknown>,
    _mode: string,
    options: { readonly etag?: string },
  ): Promise<{ etag: string }> {
    await this.beforeUpdate?.(entity);
    const partitionKey = String(entity['partitionKey']);
    const rowKey = String(entity['rowKey']);
    const key = this.key(partitionKey, rowKey);
    const existing = this.entities.get(key);
    if (!existing) throw tableError(404);
    if (options.etag !== existing.etag) throw tableError(412);
    const etag = this.nextEtag();
    this.entities.set(key, { ...entity, partitionKey, rowKey, etag });
    return { etag };
  }

  public getEntity(partitionKey: string, rowKey: string): Promise<StoredEntity> {
    const entity = this.entities.get(this.key(partitionKey, rowKey));
    return entity ? Promise.resolve({ ...entity }) : Promise.reject(tableError(404));
  }

  public deleteEntity(
    partitionKey: string,
    rowKey: string,
    options: { readonly etag?: string },
  ): Promise<void> {
    const key = this.key(partitionKey, rowKey);
    const existing = this.entities.get(key);
    if (!existing) return Promise.reject(tableError(404));
    if (options.etag !== existing.etag) return Promise.reject(tableError(412));
    this.entities.delete(key);
    return Promise.resolve();
  }
}

const credential: TokenCredential = {
  getToken: () =>
    Promise.resolve({
      token: 'synthetic-test-token',
      expiresOnTimestamp: Date.now() + 60_000,
    }),
};

const record = (status: DeploymentRecord['status']): DeploymentRecord => ({
  id: 'record-1',
  principal: 'principal',
  scopeKey: 'subscription:sub/resourceGroup:rg',
  scope: {
    kind: 'resourceGroup',
    subscriptionId: 'sub',
    resourceGroup: 'rg',
    managementGroupId: undefined,
    location: undefined,
    armScope: '/subscriptions/sub/resourceGroups/rg',
  },
  mode: 'Incremental',
  sourceHash: 'source',
  templateHash: 'template',
  parametersHash: 'parameters',
  previewHash: 'preview',
  confirmationHash: 'a'.repeat(64),
  previewSummary: {
    totalChanges: 0,
    countsByChangeType: {},
    deletes: [],
    unsupported: [],
    truncated: false,
  },
  resourceTypes: [],
  sanitizedParameters: {},
  secureParameterNames: [],
  template: {},
  status,
  armDeploymentId: undefined,
  armDeploymentName: 'atsa-record-1',
  correlationId: undefined,
  outputsMetadata: undefined,
  previousSuccessfulRecordId: undefined,
  rollbackOfRecordId: undefined,
  reason: undefined,
  requestId: 'request',
  error: undefined,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:15:00.000Z',
});

const loadStore = async () => {
  vi.resetModules();
  const tables = new Map<string, FakeTable>();
  vi.doMock('@azure/data-tables', () => ({
    TableClient: class {
      public constructor(_accountUrl: string, tableName: string) {
        const table = tables.get(tableName) ?? new FakeTable();
        tables.set(tableName, table);
        return table;
      }
    },
  }));
  const { AzureTableDeploymentRecordStore } = await import('../../src/deployments/store-azure.js');
  const create = () =>
    new AzureTableDeploymentRecordStore(credential, {
      accountUrl: 'https://example.invalid',
      recordsTable: 'records',
      locksTable: 'locks',
      lockTtlMs: 900_000,
      requestTimeoutMs: 30_000,
    });
  return { create, tables };
};

afterEach(() => {
  vi.doUnmock('@azure/data-tables');
  vi.resetModules();
});

describe('AzureTableDeploymentRecordStore concurrency', () => {
  it('does not let an expired holder delete a newer owner lock', async () => {
    const { create, tables } = await loadStore();
    const firstStore = create();
    const secondStore = create();
    let releaseFirst = (): void => undefined;
    let markFirst = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirst = resolve;
    });
    const first = firstStore.withScopeLock('scope', async () => {
      markFirst();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstEntered;

    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');
    const held = [...locks.entities.values()][0];
    if (!held) throw new Error('scope lock was not created');
    held.expiresAt = '2000-01-01T00:00:00.000Z';

    let releaseSecond = (): void => undefined;
    let markSecond = (): void => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      markSecond = resolve;
    });
    const second = secondStore.withScopeLock('scope', async () => {
      markSecond();
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    });
    await secondEntered;

    releaseFirst();
    await first;
    await expect(firstStore.withScopeLock('scope', () => Promise.resolve())).rejects.toMatchObject({
      code: 'conflict',
    });

    releaseSecond();
    await second;
    await expect(
      firstStore.withScopeLock('scope', () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });

  it('uses optimistic concurrency so a delayed running patch cannot regress success', async () => {
    const { create, tables } = await loadStore();
    const store = create();
    await store.put(record('submitting'));
    const records = tables.get('records');
    if (!records) throw new Error('record table was not created');

    let releaseRunning = (): void => undefined;
    let markRunning = (): void => undefined;
    const runningBlocked = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    let blocked = false;
    records.beforeUpdate = async (entity) => {
      if (entity['status'] !== 'running' || blocked) return;
      blocked = true;
      markRunning();
      await new Promise<void>((resolve) => {
        releaseRunning = resolve;
      });
    };

    const running = store.patch('record-1', 'principal', { status: 'running' }, undefined, {
      expectedStatuses: ['submitting'],
    });
    await runningBlocked;
    await expect(
      store.patch('record-1', 'principal', { status: 'succeeded' }, undefined, {
        expectedStatuses: ['submitting'],
      }),
    ).resolves.toMatchObject({ applied: true, record: { status: 'succeeded' } });
    releaseRunning();

    await expect(running).resolves.toMatchObject({
      applied: false,
      record: { status: 'succeeded' },
    });
    await expect(store.get('record-1', 'principal')).resolves.toMatchObject({
      status: 'succeeded',
    });
  });
});
