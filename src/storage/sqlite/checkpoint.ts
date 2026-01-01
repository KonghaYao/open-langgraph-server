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
            const { BunWorkerDialect } = await import('kysely-bun-worker');
            saver = new SqliteSaver(new BunWorkerDialect({ url: connStringOrLocalPath }));
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

        await sql`PRAGMA journal_mode = WAL`.execute(this.db);

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

        const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
            this.serde.dumpsTyped(preparedCheckpoint),
            this.serde.dumpsTyped(metadata),
        ]);

        if (type1 !== type2) {
            throw new Error('Failed to serialized checkpoint and metadata to the same type.');
        }

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

        if (values.length > 0) {
            await this.db.transaction().execute(async (trx) => {
                for (const value of values) {
                    await trx
                        .insertInto('writes')
                        .values(value)
                        .onConflict((oc) =>
                            oc.columns(['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx']).doUpdateSet({
                                channel: value.channel,
                                type: value.type,
                                value: value.value,
                            }),
                        )
                        .execute();
                }
            });
        }
    }

    async deleteThread(threadId: string) {
        await this.db.transaction().execute(async (trx) => {
            await trx.deleteFrom('checkpoints').where('thread_id', '=', threadId).execute();
            await trx.deleteFrom('writes').where('thread_id', '=', threadId).execute();
        });
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
