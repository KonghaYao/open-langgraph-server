import { Dialect, Kysely, sql } from 'kysely';
import type { RunnableConfig } from '@langchain/core/runnables';

import {
    BaseCheckpointSaver,
    type Checkpoint,
    type CheckpointListOptions,
    type CheckpointTuple,
    type SerializerProtocol,
    type PendingWrite,
    type CheckpointMetadata,
    TASKS,
    copyCheckpoint,
    maxChannelVersion,
    getCheckpointId,
    WRITES_IDX_MAP,
    uuid6,
} from '@langchain/langgraph-checkpoint';

/**
 * SQLite 重试配置
 */
const SQLITE_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 100,
    // 不可重试的错误模式
    nonRetryablePatterns: [
        'database disk image is malformed', // 数据库文件损坏
        'database is malformed', // 数据库损坏（短形式）
        'cannot rollback', // 事务状态错误
        'no transaction is active', // 无活动事务
        'database or disk is full', // 磁盘空间不足
    ],
    isRetryableError: (error: any): boolean => {
        const msg = error?.message?.toLowerCase() || '';

        // 检查是否为不可重试的错误
        for (const pattern of SQLITE_RETRY_CONFIG.nonRetryablePatterns) {
            if (msg.includes(pattern.toLowerCase())) {
                return false;
            }
        }

        // 只重试锁相关的错误
        return (
            msg.includes('sqlite_busy') ||
            msg.includes('database is locked') ||
            msg === 'sqlite_busy' ||
            msg === 'database is locked'
        );
    },
};

/**
 * 带重试的数据库操作包装器
 */
async function withRetry<T>(operation: () => Promise<T>, context?: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < SQLITE_RETRY_CONFIG.maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            const msg = error?.message?.toLowerCase() || '';

            // 检查是否为严重错误（不可重试）
            if (!SQLITE_RETRY_CONFIG.isRetryableError(error)) {
                // 为数据库损坏错误提供额外的诊断信息
                if (msg.includes('malformed')) {
                    const enhancedError = new Error(
                        `SQLite database is corrupted: ${error.message}\n\n` +
                            `Context: ${context || 'unknown'}\n\n` +
                            `Possible causes:\n` +
                            `1. Database file was manually deleted or modified\n` +
                            `2. Disk I/O errors during write operations\n` +
                            `3. Concurrent access without proper locking\n\n` +
                            `Recovery options:\n` +
                            `- Delete the database file to start fresh (data will be lost)\n` +
                            `- Use SQLite recovery tools: sqlite3 <db> ".recover" > recover.sql\n` +
                            `- Switch to PostgreSQL/Redis for production use`,
                    );
                    enhancedError.name = 'SQLiteCorruptError';
                    /** @ts-ignore */
                    enhancedError.cause = error;
                    throw enhancedError;
                }

                // 其他不可重试错误直接抛出
                throw error;
            }

            if (attempt < SQLITE_RETRY_CONFIG.maxRetries - 1) {
                const delay = SQLITE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
                console.warn(
                    `SQLite lock detected${context ? ` (${context})` : ''}, retrying in ${delay}ms (attempt ${
                        attempt + 1
                    }/${SQLITE_RETRY_CONFIG.maxRetries})`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

/**
 * Helper function for deterministic object comparison
 * Used for deep metadata filtering
 */
function deterministicStringify(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return JSON.stringify(obj.map((item) => deterministicStringify(item)));
    }
    const sortedObj: Record<string, any> = {};
    const sortedKeys = Object.keys(obj).sort();
    for (const key of sortedKeys) {
        sortedObj[key] = obj[key];
    }
    return JSON.stringify(sortedObj, (_, value) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const sorted: Record<string, any> = {};
            const keys = Object.keys(value).sort();
            for (const k of keys) {
                sorted[k] = value[k];
            }
            return sorted;
        }
        return value;
    });
}

// Kysely 数据库表类型定义 - 浅层模式
interface ShallowCheckpointsTable {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    parent_checkpoint_id: string | null;
    type: string | null;
    checkpoint: Uint8Array;
    metadata: Uint8Array;
    checkpoint_ts: number; // 时间戳用于排序
}

interface WritesTable {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    task_id: string;
    idx: number;
    channel: string;
    type: string | null;
    value: Uint8Array | null;
}

interface ShallowCheckpointDatabase {
    shallow_checkpoints: ShallowCheckpointsTable;
    writes: WritesTable;
}

// Valid metadata keys for filtering
const checkpointMetadataKeys = ['source', 'step', 'parents'] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [keyof T]
    ? [keyof T] extends [K[number]]
        ? K
        : never
    : never;

function validateKeys<T, K extends readonly (keyof T)[]>(keys: CheckKeys<T, K>): K {
    return keys;
}

const validCheckpointMetadataKeys = validateKeys<CheckpointMetadata, typeof checkpointMetadataKeys>(
    checkpointMetadataKeys,
);

/**
 * SqliteShallowSaver - SQLite 浅层检查点存储器
 *
 * 特性:
 * - 每个 thread_id + checkpoint_ns 组合只保留最新的 checkpoint
 * - 新 checkpoint 写入时自动清理旧 checkpoint 的 writes
 * - 使用 checkpoint_ts 时间戳排序
 * - 大幅减少存储数据量
 */
export class SqliteShallowSaver extends BaseCheckpointSaver {
    db: Kysely<ShallowCheckpointDatabase>;
    protected isSetup: boolean;

    constructor(dialect: Dialect, serde?: SerializerProtocol) {
        super(serde);
        this.db = new Kysely<ShallowCheckpointDatabase>({
            dialect,
        });
        this.isSetup = false;
    }

    static async fromConnStringAsync(connStringOrLocalPath: string): Promise<SqliteShallowSaver> {
        let saver: SqliteShallowSaver;
        /** @ts-ignore */
        if (globalThis.Bun) {
            console.log('LG | Using BunSqliteDialect ' + connStringOrLocalPath);
            const { BunSqliteDialect } = await import('kysely-bun-worker/normal');
            // 使用 BunSqliteDialect（非 Worker 模式）避免 Worker 事务状态同步问题
            // BunWorkerDialect 在高并发下可能出现 "cannot rollback - no transaction is active"
            saver = new SqliteShallowSaver(new BunSqliteDialect({ url: connStringOrLocalPath }));
        } else {
            /** @ts-ignore */
            console.log('LG | Using NodeWasmDialect');
            const { default: SqliteDatabase } = await import('node-sqlite3-wasm');
            const { NodeWasmDialect } = await import('kysely-wasm');
            console.log(connStringOrLocalPath);
            const wasm = new NodeWasmDialect({
                database: new SqliteDatabase.Database(connStringOrLocalPath),
            });
            saver = new SqliteShallowSaver(wasm);
        }
        await saver.setup();
        return saver;
    }

    protected async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        // 锁等待超时 5 秒
        await sql`PRAGMA busy_timeout = 5000`.execute(this.db as any);

        // WAL 模式 - 允许读写并发
        await sql`PRAGMA journal_mode = WAL`.execute(this.db as any);

        // NORMAL 模式 - 平衡数据安全与性能
        await sql`PRAGMA synchronous = NORMAL`.execute(this.db as any);

        // WAL 自动检查点
        await sql`PRAGMA wal_autocheckpoint = 1000`.execute(this.db as any);

        // 创建浅层 checkpoints 表 - 使用复合主键 (thread_id, checkpoint_ns)
        await sql`
CREATE TABLE IF NOT EXISTS shallow_checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  checkpoint_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, checkpoint_ns)
)`.execute(this.db as any);

        // 创建 checkpoint_ts 索引用于排序
        await sql`
CREATE INDEX IF NOT EXISTS idx_shallow_checkpoints_ts 
ON shallow_checkpoints(checkpoint_ts DESC)`.execute(this.db as any);

        // 创建 writes 表
        await sql`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
)`.execute(this.db as any);

        this.isSetup = true;
    }

    /**
     * 获取 checkpoint（便捷方法）
     */
    async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
        const tuple = await this.getTuple(config);
        return tuple?.checkpoint;
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        await this.setup();
        const threadId = config.configurable?.thread_id;
        const checkpointNs = config.configurable?.checkpoint_ns ?? '';
        const requestedCheckpointId = getCheckpointId(config);

        if (threadId === undefined) {
            return undefined;
        }

        let query = this.db
            .selectFrom('shallow_checkpoints')
            .select([
                'thread_id',
                'checkpoint_ns',
                'checkpoint_id',
                'parent_checkpoint_id',
                'type',
                'checkpoint',
                'metadata',
                'checkpoint_ts',
                sql<string>`(
                    SELECT json_group_array(
                        json_object(
                            'task_id', pw.task_id,
                            'channel', pw.channel,
                            'type', pw.type,
                            'value', CAST(pw.value AS TEXT)
                        )
                    )
                    FROM writes as pw
                    WHERE pw.thread_id = shallow_checkpoints.thread_id
                        AND pw.checkpoint_ns = shallow_checkpoints.checkpoint_ns
                        AND pw.checkpoint_id = shallow_checkpoints.checkpoint_id
                )`.as('pending_writes'),
                sql<string>`(
                    SELECT json_group_array(
                        json_object(
                            'type', ps.type,
                            'value', CAST(ps.value AS TEXT)
                        )
                    )
                    FROM writes as ps
                    WHERE ps.thread_id = shallow_checkpoints.thread_id
                        AND ps.checkpoint_ns = shallow_checkpoints.checkpoint_ns
                        AND ps.checkpoint_id = shallow_checkpoints.parent_checkpoint_id
                        AND ps.channel = ${TASKS}
                    ORDER BY ps.idx
                )`.as('pending_sends'),
            ])
            .where('thread_id', '=', threadId)
            .where('checkpoint_ns', '=', checkpointNs);

        // 如果指定了 checkpoint_id，需要验证是否匹配
        if (requestedCheckpointId) {
            query = query.where('checkpoint_id', '=', requestedCheckpointId);
        }

        const row = await query.executeTakeFirst();
        if (!row) return undefined;

        // 如果请求了特定的 checkpoint_id 但不匹配（在 shallow 模式下只有一条记录）
        if (requestedCheckpointId && row.checkpoint_id !== requestedCheckpointId) {
            return undefined;
        }

        // 反序列化 pending writes
        const pendingWrites = await Promise.all(
            (
                JSON.parse(row.pending_writes || '[]') as Array<{
                    task_id: string;
                    channel: string;
                    type: string;
                    value: string;
                }>
            ).map(async (write) => {
                return [
                    write.task_id,
                    write.channel,
                    await this.serde.loadsTyped(write.type ?? 'json', write.value ?? ''),
                ] as [string, string, unknown];
            }),
        );

        // 反序列化 checkpoint
        const checkpoint = (await this.serde.loadsTyped(
            row.type ?? 'json',
            new TextDecoder().decode(row.checkpoint),
        )) as Checkpoint;

        // 处理 v < 4 迁移
        if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
            await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
        }

        const finalConfig: RunnableConfig = {
            configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.checkpoint_id,
            },
        };

        return {
            checkpoint,
            config: finalConfig,
            metadata: (await this.serde.loadsTyped(
                row.type ?? 'json',
                new TextDecoder().decode(row.metadata),
            )) as CheckpointMetadata,
            parentConfig: row.parent_checkpoint_id
                ? {
                      configurable: {
                          thread_id: row.thread_id,
                          checkpoint_ns: row.checkpoint_ns,
                          checkpoint_id: row.parent_checkpoint_id,
                      },
                  }
                : undefined,
            pendingWrites,
        };
    }

    async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
        await this.setup();
        const { limit, before, filter } = options ?? {};
        const threadId = config.configurable?.thread_id;
        const checkpointNs = config.configurable?.checkpoint_ns;

        let query = this.db.selectFrom('shallow_checkpoints').select([
            'thread_id',
            'checkpoint_ns',
            'checkpoint_id',
            'parent_checkpoint_id',
            'type',
            'checkpoint',
            'metadata',
            'checkpoint_ts',
            sql<string>`(
                    SELECT json_group_array(
                        json_object(
                            'task_id', pw.task_id,
                            'channel', pw.channel,
                            'type', pw.type,
                            'value', CAST(pw.value AS TEXT)
                        )
                    )
                    FROM writes as pw
                    WHERE pw.thread_id = shallow_checkpoints.thread_id
                        AND pw.checkpoint_ns = shallow_checkpoints.checkpoint_ns
                        AND pw.checkpoint_id = shallow_checkpoints.checkpoint_id
                )`.as('pending_writes'),
        ]);

        if (threadId) {
            query = query.where('thread_id', '=', threadId);
        }

        if (checkpointNs !== undefined && checkpointNs !== null) {
            query = query.where('checkpoint_ns', '=', checkpointNs);
        }

        if (before?.configurable?.checkpoint_id !== undefined) {
            query = query.where('checkpoint_id', '<', before.configurable.checkpoint_id);
        }

        // 按时间戳降序（最新的在前）
        query = query.orderBy('checkpoint_ts', 'desc');

        const rows = await query.execute();
        let count = 0;

        for (const row of rows) {
            // 先反序列化 metadata 以便在应用层过滤
            const metadata = (await this.serde.loadsTyped(
                row.type ?? 'json',
                new TextDecoder().decode(row.metadata),
            )) as CheckpointMetadata;

            // 应用层 metadata 过滤（与 ShallowMemorySaver 保持一致）
            if (filter && !this._checkMetadataFilterMatch(metadata, filter as CheckpointMetadata)) {
                continue;
            }

            // 应用 limit
            if (limit !== undefined && count >= limit) {
                return;
            }

            const pendingWrites = await Promise.all(
                (
                    JSON.parse(row.pending_writes || '[]') as Array<{
                        task_id: string;
                        channel: string;
                        type: string;
                        value: string;
                    }>
                ).map(async (write) => {
                    return [
                        write.task_id,
                        write.channel,
                        await this.serde.loadsTyped(write.type ?? 'json', write.value ?? ''),
                    ] as [string, string, unknown];
                }),
            );

            const checkpoint = (await this.serde.loadsTyped(
                row.type ?? 'json',
                new TextDecoder().decode(row.checkpoint),
            )) as Checkpoint;

            if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
                await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
            }

            count++;
            yield {
                config: {
                    configurable: {
                        thread_id: row.thread_id,
                        checkpoint_ns: row.checkpoint_ns,
                        checkpoint_id: row.checkpoint_id,
                    },
                },
                checkpoint,
                metadata,
                parentConfig: row.parent_checkpoint_id
                    ? {
                          configurable: {
                              thread_id: row.thread_id,
                              checkpoint_ns: row.checkpoint_ns,
                              checkpoint_id: row.parent_checkpoint_id,
                          },
                      }
                    : undefined,
                pendingWrites,
            };
        }
    }

    /**
     * Check metadata filter matches (with deep comparison support)
     * Matches ShallowMemorySaver behavior
     */
    private _checkMetadataFilterMatch(metadata: any, filter: CheckpointMetadata): boolean {
        for (const [key, value] of Object.entries(filter)) {
            const metadataValue = metadata?.[key];

            if (value === null) {
                // For null filter value, check if key doesn't exist or value is null
                if (!(key in (metadata || {})) || metadataValue !== null) {
                    return false;
                }
            } else if (typeof value === 'object' && !Array.isArray(value)) {
                // Deep comparison for objects with deterministic key ordering
                if (typeof metadataValue !== 'object' || metadataValue === null) {
                    return false;
                }
                if (deterministicStringify(value) !== deterministicStringify(metadataValue)) {
                    return false;
                }
            } else if (metadataValue !== value) {
                return false;
            }
        }
        return true;
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        _newVersions?: Record<string, string | number>,
    ): Promise<RunnableConfig> {
        await this.setup();

        const threadId = config.configurable?.thread_id;
        const checkpointNs = config.configurable?.checkpoint_ns ?? '';
        const parentCheckpointId = config.configurable?.checkpoint_id;

        if (!threadId) {
            throw new Error('thread_id is required');
        }

        // 使用 checkpoint.id 或生成新的
        const checkpointId = checkpoint.id || uuid6(0);

        const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);

        // 序列化
        const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
            this.serde.dumpsTyped(preparedCheckpoint),
            this.serde.dumpsTyped(metadata),
        ]);

        if (type1 !== type2) {
            throw new Error('Failed to serialize checkpoint and metadata to the same type.');
        }

        const threadId_ = threadId;
        const checkpointNs_ = checkpointNs;
        const checkpointId_ = checkpointId;

        // 带重试的数据库操作
        await withRetry(async () => {
            await this.db.transaction().execute(async (trx) => {
                // 获取旧的 checkpoint_id 用于清理 writes
                const oldCheckpoint = await trx
                    .selectFrom('shallow_checkpoints')
                    .select(['checkpoint_id'])
                    .where('thread_id', '=', threadId_)
                    .where('checkpoint_ns', '=', checkpointNs_)
                    .executeTakeFirst();

                // 如果存在旧的 checkpoint 且 id 不同，清理旧的 writes
                if (oldCheckpoint && oldCheckpoint.checkpoint_id !== checkpointId_) {
                    await trx
                        .deleteFrom('writes')
                        .where('thread_id', '=', threadId_)
                        .where('checkpoint_ns', '=', checkpointNs_)
                        .where('checkpoint_id', '=', oldCheckpoint.checkpoint_id)
                        .execute();
                }

                // 使用 INSERT OR REPLACE (UPSERT) 覆盖写入
                await trx
                    .insertInto('shallow_checkpoints')
                    .values({
                        thread_id: threadId_,
                        checkpoint_ns: checkpointNs_,
                        checkpoint_id: checkpointId_,
                        parent_checkpoint_id: parentCheckpointId ?? null,
                        type: type1,
                        checkpoint: new Uint8Array(Buffer.from(serializedCheckpoint)),
                        metadata: new Uint8Array(Buffer.from(serializedMetadata)),
                        checkpoint_ts: Date.now(),
                    })
                    .onConflict((oc) =>
                        oc.columns(['thread_id', 'checkpoint_ns']).doUpdateSet({
                            checkpoint_id: checkpointId_,
                            parent_checkpoint_id: parentCheckpointId ?? null,
                            type: type1,
                            checkpoint: new Uint8Array(Buffer.from(serializedCheckpoint)),
                            metadata: new Uint8Array(Buffer.from(serializedMetadata)),
                            checkpoint_ts: Date.now(),
                        }),
                    )
                    .execute();
            });
        }, `put(${threadId}/${checkpointId})`);

        return {
            configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNs,
                checkpoint_id: checkpointId,
            },
        };
    }

    async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
        await this.setup();

        const threadId = config.configurable?.thread_id;
        const checkpointNs = config.configurable?.checkpoint_ns ?? '';
        const checkpointId = config.configurable?.checkpoint_id;

        if (!threadId || !checkpointId) {
            throw new Error('thread_id and checkpoint_id are required');
        }

        // 预先序列化
        const values = await Promise.all(
            writes.map(async (write, idx) => {
                const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
                return {
                    thread_id: threadId,
                    checkpoint_ns: checkpointNs,
                    checkpoint_id: checkpointId,
                    task_id: taskId,
                    idx: WRITES_IDX_MAP[write[0]] ?? idx,
                    channel: write[0],
                    type,
                    value: new Uint8Array(Buffer.from(serializedWrite)),
                };
            }),
        );

        if (values.length === 0) return;

        // 带重试的批量插入
        await withRetry(async () => {
            await this.db.transaction().execute(async (trx) => {
                // 先删除已存在的记录
                await trx
                    .deleteFrom('writes')
                    .where('thread_id', '=', threadId)
                    .where('checkpoint_ns', '=', checkpointNs)
                    .where('checkpoint_id', '=', checkpointId)
                    .where('task_id', '=', taskId)
                    .execute();

                // 批量插入
                for (const value of values) {
                    await trx.insertInto('writes').values(value).execute();
                }
            });
        }, `putWrites(${threadId}/${checkpointId}/${taskId})`);
    }

    async deleteThread(threadId: string): Promise<void> {
        await withRetry(async () => {
            await this.db.transaction().execute(async (trx) => {
                await trx.deleteFrom('shallow_checkpoints').where('thread_id', '=', threadId).execute();
                await trx.deleteFrom('writes').where('thread_id', '=', threadId).execute();
            });
        }, `deleteThread(${threadId})`);
    }

    protected async migratePendingSends(checkpoint: Checkpoint, threadId: string, parentCheckpointId: string) {
        const result = await this.db
            .selectFrom('writes as ps')
            .select([
                'ps.checkpoint_id',
                sql<string>`json_group_array(
                    json_object(
                        'type', ps.type,
                        'value', CAST(ps.value AS TEXT)
                    )
                )`.as('pending_sends'),
            ])
            .where('ps.thread_id', '=', threadId)
            .where('ps.checkpoint_id', '=', parentCheckpointId)
            .where('ps.channel', '=', TASKS)
            .orderBy('ps.idx')
            .executeTakeFirst();

        if (!result) return;

        const mutableCheckpoint = checkpoint;

        mutableCheckpoint.channel_values ??= {};
        mutableCheckpoint.channel_values[TASKS] = await Promise.all(
            JSON.parse(result.pending_sends || '[]').map(({ type, value }: { type: string; value: string }) =>
                this.serde.loadsTyped(type, value),
            ),
        );

        mutableCheckpoint.channel_versions[TASKS] =
            Object.keys(checkpoint.channel_versions).length > 0
                ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
                : this.getNextVersion(undefined);
    }
}
