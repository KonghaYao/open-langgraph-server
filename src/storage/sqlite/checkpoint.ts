import { Dialect, Kysely, SqliteDialect, sql } from 'kysely';
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
} from '@langchain/langgraph-checkpoint';

/**
 * SQLite 重试配置
 */
const SQLITE_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 100,
    // 不可重试的错误模式
    nonRetryablePatterns: [
        'database disk image is malformed',  // 数据库文件损坏
        'database is malformed',               // 数据库损坏（短形式）
        'cannot rollback',                     // 事务状态错误
        'no transaction is active',            // 无活动事务
        'database or disk is full',           // 磁盘空间不足
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
                        `- Switch to PostgreSQL/Redis for production use`
                    );
                    enhancedError.name = 'SQLiteCorruptError';
                    enhancedError.cause = error;
                    throw enhancedError;
                }

                // 其他不可重试错误直接抛出
                throw error;
            }

            if (attempt < SQLITE_RETRY_CONFIG.maxRetries - 1) {
                const delay = SQLITE_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
                console.warn(
                    `SQLite lock detected${context ? ` (${context})` : ''}, retrying in ${delay}ms (attempt ${attempt + 1}/${SQLITE_RETRY_CONFIG.maxRetries})`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

// Kysely 数据库表类型定义
interface CheckpointsTable {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    parent_checkpoint_id: string | null;
    type: string | null;
    checkpoint: Uint8Array;
    metadata: Uint8Array;
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

interface CheckpointDatabase {
    checkpoints: CheckpointsTable;
    writes: WritesTable;
}

interface CheckpointRow {
    checkpoint: string;
    metadata: string;
    parent_checkpoint_id?: string;
    thread_id: string;
    checkpoint_id: string;
    checkpoint_ns?: string;
    type?: string;
    pending_writes: string;
}

interface PendingWriteColumn {
    task_id: string;
    channel: string;
    type: string;
    value: string;
}

interface PendingSendColumn {
    type: string;
    value: string;
}

// In the `SqliteSaver.list` method, we need to sanitize the `options.filter` argument to ensure it only contains keys
// that are part of the `CheckpointMetadata` type. The lines below ensure that we get compile-time errors if the list
// of keys that we use is out of sync with the `CheckpointMetadata` type.
const checkpointMetadataKeys = ['source', 'step', 'parents'] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [keyof T]
    ? [keyof T] extends [K[number]]
        ? K
        : never
    : never;

function validateKeys<T, K extends readonly (keyof T)[]>(keys: CheckKeys<T, K>): K {
    return keys;
}

// If this line fails to compile, the list of keys that we use in the `SqliteSaver.list` method is out of sync with the
// `CheckpointMetadata` type. In that case, just update `checkpointMetadataKeys` to contain all the keys in
// `CheckpointMetadata`
const validCheckpointMetadataKeys = validateKeys<CheckpointMetadata, typeof checkpointMetadataKeys>(
    checkpointMetadataKeys,
);

export class SqliteSaver extends BaseCheckpointSaver {
    db: Kysely<CheckpointDatabase>;

    protected isSetup: boolean;

    constructor(dialect: Dialect, serde?: SerializerProtocol) {
        super(serde);
        this.db = new Kysely<CheckpointDatabase>({
            dialect,
        });
        this.isSetup = false;
    }

    static async fromConnStringAsync(connStringOrLocalPath: string): Promise<SqliteSaver> {
        let saver: SqliteSaver;
        /** @ts-ignore */
        if (globalThis.Bun) {
            console.log('LG | Using BunWorkerDialect ' + connStringOrLocalPath);
            const { BunSqliteDialect } = await import('kysely-bun-worker/normal');
            // 使用 BunSqliteDialect（非 Worker 模式）避免 Worker 事务状态同步问题
            // BunWorkerDialect 在高并发下可能出现 "cannot rollback - no transaction is active"
            saver = new SqliteSaver(new BunSqliteDialect({ url: connStringOrLocalPath }));
        } else {
            /** @ts-ignore */
            console.log('LG | Using NodeWasmDialect');
            const { default: SqliteDatabase } = await import('node-sqlite3-wasm');
            const { NodeWasmDialect } = await import('kysely-wasm');
            console.log(connStringOrLocalPath);
            const wasm = new NodeWasmDialect({
                database: new SqliteDatabase.Database(connStringOrLocalPath),
            });
            saver = new SqliteSaver(wasm);
        }
        await saver.setup();
        return saver;
    }

    protected async setup(): Promise<void> {
        if (this.isSetup) {
            return;
        }

        // 锁等待超时 5 秒，避免立即返回 SQLITE_BUSY
        await sql`PRAGMA busy_timeout = 5000`.execute(this.db);

        // WAL 模式 - 允许读写并发
        await sql`PRAGMA journal_mode = WAL`.execute(this.db);

        // NORMAL 模式 - 平衡数据安全与性能
        await sql`PRAGMA synchronous = NORMAL`.execute(this.db);

        // WAL 自动检查点 - 每 1000 页执行一次，避免 WAL 文件无限增长
        await sql`PRAGMA wal_autocheckpoint = 1000`.execute(this.db);

        await sql`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
)`.execute(this.db);

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
)`.execute(this.db);
        this.isSetup = true;
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        await this.setup();
        const { thread_id, checkpoint_ns = '', checkpoint_id } = config.configurable ?? {};

        let query = this.db
            .selectFrom('checkpoints')
            .select([
                'thread_id',
                'checkpoint_ns',
                'checkpoint_id',
                'parent_checkpoint_id',
                'type',
                'checkpoint',
                'metadata',
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
                    WHERE pw.thread_id = checkpoints.thread_id
                        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
                        AND pw.checkpoint_id = checkpoints.checkpoint_id
                )`.as('pending_writes'),
                sql<string>`(
                    SELECT json_group_array(
                        json_object(
                            'type', ps.type,
                            'value', CAST(ps.value AS TEXT)
                        )
                    )
                    FROM writes as ps
                    WHERE ps.thread_id = checkpoints.thread_id
                        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
                        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
                        AND ps.channel = ${TASKS}
                    ORDER BY ps.idx
                )`.as('pending_sends'),
            ])
            .where('thread_id', '=', thread_id)
            .where('checkpoint_ns', '=', checkpoint_ns);

        if (checkpoint_id) {
            query = query.where('checkpoint_id', '=', checkpoint_id);
        } else {
            query = query.orderBy('checkpoint_id', 'desc').limit(1);
        }

        const row = await query.executeTakeFirst();
        if (!row) return undefined;

        let finalConfig = config;

        if (!checkpoint_id) {
            finalConfig = {
                configurable: {
                    thread_id: row.thread_id,
                    checkpoint_ns,
                    checkpoint_id: row.checkpoint_id,
                },
            };
        }

        if (
            finalConfig.configurable?.thread_id === undefined ||
            finalConfig.configurable?.checkpoint_id === undefined
        ) {
            throw new Error('Missing thread_id or checkpoint_id');
        }

        const pendingWrites = await Promise.all(
            (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(async (write) => {
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
                          checkpoint_ns,
                          checkpoint_id: row.parent_checkpoint_id,
                      },
                  }
                : undefined,
            pendingWrites,
        };
    }

    async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
        const { limit, before, filter } = options ?? {};
        await this.setup();
        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns;

        let query = this.db.selectFrom('checkpoints').select([
            'thread_id',
            'checkpoint_ns',
            'checkpoint_id',
            'parent_checkpoint_id',
            'type',
            'checkpoint',
            'metadata',
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
                    WHERE pw.thread_id = checkpoints.thread_id
                        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
                        AND pw.checkpoint_id = checkpoints.checkpoint_id
                )`.as('pending_writes'),
            sql<string>`(
                    SELECT json_group_array(
                        json_object(
                            'type', ps.type,
                            'value', CAST(ps.value AS TEXT)
                        )
                    )
                    FROM writes as ps
                    WHERE ps.thread_id = checkpoints.thread_id
                        AND ps.checkpoint_ns = checkpoints.checkpoint_ns
                        AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
                        AND ps.channel = ${TASKS}
                    ORDER BY ps.idx
                )`.as('pending_sends'),
        ]);

        if (thread_id) {
            query = query.where('thread_id', '=', thread_id);
        }

        if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
            query = query.where('checkpoint_ns', '=', checkpoint_ns);
        }

        if (before?.configurable?.checkpoint_id !== undefined) {
            query = query.where('checkpoint_id', '<', before.configurable.checkpoint_id);
        }

        const sanitizedFilter = Object.fromEntries(
            Object.entries(filter ?? {}).filter(
                ([key, value]) =>
                    value !== undefined && validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata),
            ),
        );

        for (const [key, value] of Object.entries(sanitizedFilter)) {
            query = query.where(
                sql`json_extract(CAST(metadata AS TEXT), ${sql.lit('$.' + key)})`,
                '=',
                sql.lit(JSON.stringify(value)),
            );
        }

        query = query.orderBy('checkpoint_id', 'desc');

        if (limit) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            query = query.limit(parseInt(limit as any, 10));
        }

        const rows = await query.execute();

        for (const row of rows) {
            const pendingWrites = await Promise.all(
                (JSON.parse(row.pending_writes) as PendingWriteColumn[]).map(async (write) => {
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

            yield {
                config: {
                    configurable: {
                        thread_id: row.thread_id,
                        checkpoint_ns: row.checkpoint_ns,
                        checkpoint_id: row.checkpoint_id,
                    },
                },
                checkpoint,
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
    }

    async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
        await this.setup();

        if (!config.configurable) {
            throw new Error('Empty configuration supplied.');
        }

        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
        const parent_checkpoint_id = config.configurable?.checkpoint_id;

        if (!thread_id) {
            throw new Error(`Missing "thread_id" field in passed "config.configurable".`);
        }

        const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);

        // 序列化在事务外完成
        const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
            this.serde.dumpsTyped(preparedCheckpoint),
            this.serde.dumpsTyped(metadata),
        ]);

        if (type1 !== type2) {
            throw new Error('Failed to serialized checkpoint and metadata to the same type.');
        }

        // 带重试的数据库操作
        await withRetry(
            async () => {
                await this.db
                    .insertInto('checkpoints')
                    .values({
                        thread_id,
                        checkpoint_ns,
                        checkpoint_id: checkpoint.id,
                        parent_checkpoint_id: parent_checkpoint_id ?? null,
                        type: type1,
                        checkpoint: new Uint8Array(Buffer.from(serializedCheckpoint)),
                        metadata: new Uint8Array(Buffer.from(serializedMetadata)),
                    })
                    .onConflict((oc) =>
                        oc.columns(['thread_id', 'checkpoint_ns', 'checkpoint_id']).doUpdateSet({
                            parent_checkpoint_id: parent_checkpoint_id ?? null,
                            type: type1,
                            checkpoint: new Uint8Array(Buffer.from(serializedCheckpoint)),
                            metadata: new Uint8Array(Buffer.from(serializedMetadata)),
                        }),
                    )
                    .execute();
            },
            `put(${thread_id}/${checkpoint.id})`,
        );

        return {
            configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: checkpoint.id,
            },
        };
    }

    async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
        await this.setup();

        if (!config.configurable) {
            throw new Error('Empty configuration supplied.');
        }

        if (!config.configurable?.thread_id) {
            throw new Error('Missing thread_id field in config.configurable.');
        }

        if (!config.configurable?.checkpoint_id) {
            throw new Error('Missing checkpoint_id field in config.configurable.');
        }

        // 预先序列化所有数据（在事务外完成，减少锁持有时间）
        const values = await Promise.all(
            writes.map(async (write, idx) => {
                const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
                return {
                    thread_id: config.configurable!.thread_id,
                    checkpoint_ns: config.configurable!.checkpoint_ns ?? '',
                    checkpoint_id: config.configurable!.checkpoint_id,
                    task_id: taskId,
                    idx,
                    channel: write[0],
                    type,
                    value: new Uint8Array(Buffer.from(serializedWrite)),
                };
            }),
        );

        if (values.length === 0) return;

        const threadId = config.configurable.thread_id;
        const checkpointId = config.configurable.checkpoint_id;

        // 带重试的批量插入
        await withRetry(
            async () => {
                await this.db.transaction().execute(async (trx) => {
                    // 先删除已存在的记录（比逐条 ON CONFLICT 更快）
                    await trx
                        .deleteFrom('writes')
                        .where('thread_id', '=', threadId)
                        .where('checkpoint_ns', '=', values[0].checkpoint_ns)
                        .where('checkpoint_id', '=', checkpointId)
                        .where('task_id', '=', taskId)
                        .execute();

                    // 批量插入
                    for (const value of values) {
                        await trx.insertInto('writes').values(value).execute();
                    }
                });
            },
            `putWrites(${threadId}/${checkpointId}/${taskId})`,
        );
    }

    async deleteThread(threadId: string) {
        // 带重试的删除操作
        await withRetry(
            async () => {
                await this.db.transaction().execute(async (trx) => {
                    await trx.deleteFrom('checkpoints').where('thread_id', '=', threadId).execute();
                    await trx.deleteFrom('writes').where('thread_id', '=', threadId).execute();
                });
            },
            `deleteThread(${threadId})`,
        );
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

        // add pending sends to checkpoint
        mutableCheckpoint.channel_values ??= {};
        mutableCheckpoint.channel_values[TASKS] = await Promise.all(
            JSON.parse(result.pending_sends).map(({ type, value }: PendingSendColumn) =>
                this.serde.loadsTyped(type, value),
            ),
        );

        // add to versions
        mutableCheckpoint.channel_versions[TASKS] =
            Object.keys(checkpoint.channel_versions).length > 0
                ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
                : this.getNextVersion(undefined);
    }
}
