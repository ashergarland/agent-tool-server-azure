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
  public afterCreate: ((entity: Readonly<Record<string, unknown>>) => Promise<void>) | undefined;
  public beforeUpdate: ((entity: Readonly<Record<string, unknown>>) => Promise<void>) | undefined;
  public beforeGet: ((partitionKey: string, rowKey: string) => Promise<void>) | undefined;
  public beforeDelete: ((partitionKey: string, rowKey: string) => Promise<void>) | undefined;
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

  public async createEntity(entity: Record<string, unknown>): Promise<{ etag: string }> {
    const partitionKey = String(entity['partitionKey']);
    const rowKey = String(entity['rowKey']);
    const key = this.key(partitionKey, rowKey);
    if (this.entities.has(key)) throw tableError(409);
    const etag = this.nextEtag();
    this.entities.set(key, { ...entity, partitionKey, rowKey, etag });
    await this.afterCreate?.(entity);
    return { etag };
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

  public async getEntity(partitionKey: string, rowKey: string): Promise<StoredEntity> {
    await this.beforeGet?.(partitionKey, rowKey);
    const entity = this.entities.get(this.key(partitionKey, rowKey));
    if (!entity) throw tableError(404);
    return { ...entity };
  }

  public async deleteEntity(
    partitionKey: string,
    rowKey: string,
    options: { readonly etag?: string },
  ): Promise<void> {
    await this.beforeDelete?.(partitionKey, rowKey);
    const key = this.key(partitionKey, rowKey);
    const existing = this.entities.get(key);
    if (!existing) throw tableError(404);
    if (options.etag !== existing.etag) throw tableError(412);
    this.entities.delete(key);
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
  const logger = { warn: vi.fn() };
  const create = (overrides: { readonly lockTtlMs?: number } = {}) =>
    new AzureTableDeploymentRecordStore(
      credential,
      {
        accountUrl: 'https://example.invalid',
        recordsTable: 'records',
        locksTable: 'locks',
        lockTtlMs: overrides.lockTtlMs ?? 900_000,
        requestTimeoutMs: 30_000,
      },
      logger,
    );
  return { create, tables, logger };
};

afterEach(() => {
  vi.doUnmock('@azure/data-tables');
  vi.resetModules();
});

describe('AzureTableDeploymentRecordStore concurrency', () => {
  it.each([401, 429])(
    'replaces a Table %i renewal failure with a status-free lease marker',
    async (statusCode) => {
      const { create, tables } = await loadStore();
      const store = create({ lockTtlMs: 30 });
      const locks = tables.get('locks');
      if (!locks) throw new Error('lock table was not created');
      locks.beforeUpdate = () => Promise.reject(tableError(statusCode));

      const reason = await store.withScopeLock(
        'scope',
        (signal) =>
          new Promise<unknown>((resolve) => {
            if (signal.aborted) resolve(signal.reason);
            else signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
          }),
      );

      expect(reason).toMatchObject({
        name: 'DeploymentLeaseLostError',
        code: 'LEASE_LOST',
        cause: { statusCode },
      });
      expect(reason).not.toHaveProperty('statusCode');
    },
  );

  it('renews and releases an ordinary lease without changing the protected result', async () => {
    const { create, tables } = await loadStore();
    const store = create({ lockTtlMs: 30 });
    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');
    let markRenewed = (): void => undefined;
    const renewed = new Promise<void>((resolve) => {
      markRenewed = resolve;
    });
    locks.beforeUpdate = () => {
      markRenewed();
      return Promise.resolve();
    };

    await expect(
      store.withScopeLock('scope', async () => {
        await renewed;
        return 'accepted';
      }),
    ).resolves.toBe('accepted');
    expect(locks.entities.size).toBe(0);
  });

  it('preserves success and leaves TTL reclamation available when release lookup fails', async () => {
    const { create, tables, logger } = await loadStore();
    const store = create();
    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');

    await expect(
      store.withScopeLock('scope', () => {
        locks.beforeGet = () => Promise.reject(tableError(503));
        return Promise.resolve('accepted');
      }),
    ).resolves.toBe('accepted');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'deployment.lock.release.failed', scopeKey: 'scope' }),
      expect.any(String),
    );
    expect(locks.entities.size).toBe(1);

    locks.beforeGet = undefined;
    const held = [...locks.entities.values()][0];
    if (!held) throw new Error('scope lock was not retained');
    held.expiresAt = '2000-01-01T00:00:00.000Z';
    await expect(create().withScopeLock('scope', () => Promise.resolve('reclaimed'))).resolves.toBe(
      'reclaimed',
    );
    expect(locks.entities.size).toBe(0);
  });

  it('preserves success when conditional release deletion fails', async () => {
    const { create, tables, logger } = await loadStore();
    const store = create();
    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');

    await expect(
      store.withScopeLock('scope', () => {
        locks.beforeDelete = () => Promise.reject(tableError(503));
        return Promise.resolve('accepted');
      }),
    ).resolves.toBe('accepted');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'deployment.lock.release.failed', scopeKey: 'scope' }),
      expect.any(String),
    );
    expect(locks.entities.size).toBe(1);
  });

  it('preserves the protected error when release also fails', async () => {
    const { create, tables, logger } = await loadStore();
    const store = create();
    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');
    const operationError = new Error('ARM submission failed');

    const protectedOperation = store.withScopeLock('scope', () => {
      locks.beforeGet = () => Promise.reject(tableError(503));
      return Promise.reject(operationError);
    });

    await expect(protectedOperation).rejects.toBe(operationError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'deployment.lock.release.failed', scopeKey: 'scope' }),
      expect.any(String),
    );
  });

  it('preserves success when reporting the release failure also throws', async () => {
    const { create, tables, logger } = await loadStore();
    const store = create();
    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    logger.warn.mockImplementation(() => {
      throw new Error('logger failed');
    });

    await expect(
      store.withScopeLock('scope', () => {
        locks.beforeGet = () => Promise.reject(tableError(503));
        return Promise.resolve('accepted');
      }),
    ).resolves.toBe('accepted');
    expect(warning).toHaveBeenCalledWith(
      'The distributed deployment lock release and its logger both failed.',
      { code: 'AZURE_LOCK_RELEASE_LOG_FAILURE' },
    );
    warning.mockRestore();
  });

  it('releases a committed acquisition when caller cancellation wins before admission', async () => {
    const { create, tables } = await loadStore();
    const store = create();
    const locks = tables.get('locks');
    if (!locks) throw new Error('lock table was not created');
    let markCreated = (): void => undefined;
    const created = new Promise<void>((resolve) => {
      markCreated = resolve;
    });
    let finishCreate = (): void => undefined;
    locks.afterCreate = async () => {
      markCreated();
      await new Promise<void>((resolve) => {
        finishCreate = resolve;
      });
    };
    const cancellation = new AbortController();
    const run = vi.fn(() => Promise.resolve());

    const acquiring = store.withScopeLock('scope', run, cancellation.signal);
    await created;
    cancellation.abort();
    finishCreate();

    await expect(acquiring).rejects.toMatchObject({ code: 'timeout' });
    expect(run).not.toHaveBeenCalled();
    expect(locks.entities.size).toBe(0);
  });

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
