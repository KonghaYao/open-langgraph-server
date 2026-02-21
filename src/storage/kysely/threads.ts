import { Kysely } from 'kysely';
import { BaseThreadsManager } from '../../threads/index.js';
import {
    Command,
    Config,
    Metadata,
    OnConflictBehavior,
    Run,
    Thread,
    ThreadState,
    ThreadStatus,
} from '@langgraph-js/sdk';
import { RunStatus, SortOrder, ThreadSortBy } from '../../types';
import { Database } from './types';
import { DatabaseAdapter } from './adapter';
import { getGraph } from '../../utils/getGraph.js';
import { serialiseAsDict } from '../../graph/stream.js';
import { v7 } from 'uuid';

/**
 * 使用 Kysely 实现的统一 ThreadsManager
 * 通过适配器模式处理不同数据库的差异
 */
export class KyselyThreadsManager<ValuesType = unknown> implements BaseThreadsManager<ValuesType> {
    private db: Kysely<Database>;
    private adapter: DatabaseAdapter;

    constructor(adapter: DatabaseAdapter) {
        this.db = adapter.db;
        this.adapter = adapter;
    }

    async setup(): Promise<void> {
        // 使用适配器创建表和索引
        await this.adapter.createTables(this.db);
        await this.adapter.createIndexes(this.db);
    }

    async create(payload?: {
        metadata?: Metadata;
        threadId?: string;
        ifExists?: OnConflictBehavior;
        graphId?: string;
        supersteps?: Array<{ updates: Array<{ values: unknown; command?: Command; asNode: string }> }>;
    }): Promise<Thread<ValuesType>> {
        const threadId = payload?.threadId || v7();
        const now = new Date();
        const metadata = payload?.metadata || {};
        const interrupts = {};

        // 检查线程是否已存在
        if (payload?.ifExists === 'raise') {
            const existing = await this.db
                .selectFrom('threads')
                .select('thread_id')
                .where('thread_id', '=', threadId)
                .executeTakeFirst();

            if (existing) {
                throw new Error(`Thread with ID ${threadId} already exists.`);
            }
        }

        // 如果指定了 ifExists='do_nothing'，使用 ON CONFLICT DO NOTHING
        if (payload?.ifExists === 'do_nothing' && payload?.threadId) {
            const existing = await this.db
                .selectFrom('threads')
                .selectAll()
                .where('thread_id', '=', threadId)
                .executeTakeFirst();

            if (existing) {
                return {
                    thread_id: existing.thread_id,
                    created_at: this.adapter.dbToDate(existing.created_at).toISOString(),
                    updated_at: this.adapter.dbToDate(existing.updated_at).toISOString(),
                    state_updated_at: this.adapter.dbToDate(existing.updated_at).toISOString(),
                    metadata: this.adapter.dbToJson(existing.metadata),
                    status: existing.status as ThreadStatus,
                    values: existing.values ? this.adapter.dbToJson(existing.values) : (null as unknown as ValuesType),
                    interrupts: this.adapter.dbToJson(existing.interrupts),
                };
            }
        }

        // 插入数据
        await this.db
            .insertInto('threads')
            .values({
                thread_id: threadId,
                created_at: this.adapter.dateToDb(now) as any,
                updated_at: this.adapter.dateToDb(now) as any,
                metadata: this.adapter.jsonToDb(metadata) as any,
                status: 'idle',
                values: null as any,
                interrupts: this.adapter.jsonToDb(interrupts) as any,
            })
            .execute();

        return {
            thread_id: threadId,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            state_updated_at: now.toISOString(),
            metadata,
            status: 'idle',
            values: null as unknown as ValuesType,
            interrupts,
        };
    }

    async search(query?: {
        ids?: string[];
        metadata?: Metadata;
        limit?: number;
        offset?: number;
        status?: ThreadStatus;
        sortBy?: ThreadSortBy;
        sortOrder?: SortOrder;
        values?: ValuesType;
        select?: Array<
            | 'thread_id'
            | 'created_at'
            | 'updated_at'
            | 'metadata'
            | 'config'
            | 'context'
            | 'status'
            | 'values'
            | 'interrupts'
        >;
        withoutDetails?: boolean;
    }): Promise<Thread<ValuesType>[]> {
        let queryBuilder = this.db.selectFrom('threads');

        // Determine which fields to select based on select parameter
        let selectedFields: Set<string>;

        if (query?.select) {
            selectedFields = new Set(query.select);
        } else if (query?.withoutDetails) {
            // Legacy withoutDetails behavior - exclude values and interrupts
            selectedFields = new Set(['thread_id', 'created_at', 'updated_at', 'metadata', 'status']);
        } else {
            // All fields
            selectedFields = new Set([
                'thread_id',
                'created_at',
                'updated_at',
                'metadata',
                'status',
                'values',
                'interrupts',
            ]);
        }

        // Build select expressions
        const selections: any[] = [];
        if (selectedFields.has('thread_id')) selections.push('thread_id');
        if (selectedFields.has('created_at')) selections.push('created_at');
        if (selectedFields.has('updated_at')) selections.push('updated_at');
        if (selectedFields.has('metadata')) selections.push('metadata');
        if (selectedFields.has('status')) selections.push('status');
        if (selectedFields.has('values')) selections.push('values');
        if (selectedFields.has('interrupts')) selections.push('interrupts');

        if (selections.length > 0) {
            queryBuilder = queryBuilder.select(selections);
        } else {
            queryBuilder = queryBuilder.selectAll();
        }

        // Filter by IDs
        if (query?.ids && query.ids.length > 0) {
            queryBuilder = queryBuilder.where('thread_id', 'in', query.ids);
        }

        // Filter by status
        if (query?.status) {
            queryBuilder = queryBuilder.where('status', '=', query.status);
        }

        // Filter by metadata
        if (query?.metadata) {
            for (const [key, value] of Object.entries(query.metadata)) {
                queryBuilder = queryBuilder.where(this.adapter.buildJsonQuery(this.db, 'metadata', key, value) as any);
            }
        }

        // Filter by values - Note: This is a simple equality check, may need database-specific JSON operators
        if (query?.values) {
            queryBuilder = queryBuilder.where((eb) => {
                // Use database-specific JSON equality
                return eb('values', '=', this.adapter.jsonToDb(query.values) as any);
            });
        }

        // Add sorting
        if (query?.sortBy) {
            const order = query.sortOrder === 'desc' ? 'desc' : 'asc';
            queryBuilder = queryBuilder.orderBy(query.sortBy as any, order);
        }

        // Add pagination
        if (query?.limit !== undefined) {
            queryBuilder = queryBuilder.limit(query.limit);
            if (query?.offset !== undefined) {
                queryBuilder = queryBuilder.offset(query.offset);
            }
        }

        const rows: Partial<Thread<ValuesType>>[] = await queryBuilder.execute();

        return rows.map((row) => {
            const result: Partial<Thread<ValuesType>> = { thread_id: row.thread_id };

            if (selectedFields.has('created_at'))
                result.created_at = this.adapter.dbToDate(row.created_at).toISOString();
            if (selectedFields.has('updated_at'))
                result.updated_at = this.adapter.dbToDate(row.updated_at).toISOString();
            if (selectedFields.has('metadata')) result.metadata = this.adapter.dbToJson(row.metadata);
            if (selectedFields.has('status')) result.status = row.status as ThreadStatus;
            if (selectedFields.has('values'))
                result.values = row.values ? this.adapter.dbToJson(row.values) : (null as unknown as ValuesType);
            if (selectedFields.has('interrupts')) result.interrupts = this.adapter.dbToJson(row.interrupts);

            return result as Thread<ValuesType>;
        });
    }

    async get(threadId: string): Promise<Thread<ValuesType>> {
        const row = await this.db
            .selectFrom('threads')
            .selectAll()
            .where('thread_id', '=', threadId)
            .executeTakeFirst();

        if (!row) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }

        return {
            thread_id: row.thread_id,
            created_at: this.adapter.dbToDate(row.created_at).toISOString(),
            updated_at: this.adapter.dbToDate(row.updated_at).toISOString(),
            state_updated_at: this.adapter.dbToDate(row.updated_at).toISOString(),
            metadata: this.adapter.dbToJson(row.metadata),
            status: row.status as ThreadStatus,
            values: row.values ? this.adapter.dbToJson(row.values) : (null as unknown as ValuesType),
            interrupts: this.adapter.dbToJson(row.interrupts),
        };
    }

    async set(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<void> {
        // 检查线程是否存在
        const existing = await this.db
            .selectFrom('threads')
            .select('thread_id')
            .where('thread_id', '=', threadId)
            .executeTakeFirst();

        if (!existing) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }

        // 构建更新对象
        const updates: any = {
            updated_at: this.adapter.dateToDb(new Date()),
        };

        if (thread.metadata !== undefined) {
            updates.metadata = this.adapter.jsonToDb(thread.metadata);
        }

        if (thread.status !== undefined) {
            updates.status = thread.status;
        }

        if (thread.values !== undefined) {
            updates.values = thread.values ? this.adapter.jsonToDb(thread.values) : null;
        }

        if (thread.interrupts !== undefined) {
            updates.interrupts = this.adapter.jsonToDb(thread.interrupts);
        }

        await this.db.updateTable('threads').set(updates).where('thread_id', '=', threadId).execute();
    }

    async delete(threadId: string): Promise<void> {
        const result = await this.db.deleteFrom('threads').where('thread_id', '=', threadId).executeTakeFirst();

        if (result.numDeletedRows === 0n) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }
    }

    async updateState(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<Pick<Config, 'configurable'>> {
        // 获取线程信息
        const targetThread = await this.get(threadId);

        if (targetThread.status === 'busy') {
            throw new Error(`Thread with ID ${threadId} is busy, can't update state.`);
        }

        const graphId = targetThread.metadata?.graph_id as string | undefined;

        // 如果没有 graph_id，直接更新 values 字段
        if (!graphId) {
            await this.set(threadId, {
                values: thread.values! ?? null,
            });

            return {
                configurable: {
                    thread_id: threadId,
                },
            };
        }

        const config = {
            configurable: {
                thread_id: threadId,
                graph_id: graphId,
            },
        };

        const graph = await getGraph(graphId, config);
        const nextConfig = await graph.updateState(config, thread.values);
        const graphState = await graph.getState(config);
        await this.set(threadId, { values: JSON.parse(serialiseAsDict(graphState.values)) as ValuesType });

        return nextConfig;
    }

    async createRun(threadId: string, assistantId: string, payload?: { metadata?: Metadata }): Promise<Run> {
        const runId = v7();
        const now = new Date();
        const metadata = payload?.metadata ?? {};

        await this.db
            .insertInto('runs')
            .values({
                run_id: runId,
                thread_id: threadId,
                assistant_id: assistantId,
                created_at: this.adapter.dateToDb(now) as any,
                updated_at: this.adapter.dateToDb(now) as any,
                status: 'pending',
                metadata: this.adapter.jsonToDb(metadata) as any,
                multitask_strategy: 'reject',
            })
            .execute();

        return {
            run_id: runId,
            thread_id: threadId,
            assistant_id: assistantId,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            status: 'pending',
            metadata,
            multitask_strategy: 'reject',
        };
    }

    async listRuns(
        threadId: string,
        options?: { limit?: number; offset?: number; status?: RunStatus },
    ): Promise<Run[]> {
        let queryBuilder = this.db
            .selectFrom('runs')
            .selectAll()
            .where('thread_id', '=', threadId)
            .orderBy('created_at', 'desc');

        if (options?.status) {
            queryBuilder = queryBuilder.where('status', '=', options.status);
        }

        if (options?.limit !== undefined) {
            queryBuilder = queryBuilder.limit(options.limit);
            if (options?.offset !== undefined) {
                queryBuilder = queryBuilder.offset(options.offset);
            }
        }

        const rows = await queryBuilder.execute();

        return rows.map((row) => ({
            run_id: row.run_id,
            thread_id: row.thread_id,
            assistant_id: row.assistant_id,
            created_at: this.adapter.dbToDate(row.created_at).toISOString(),
            updated_at: this.adapter.dbToDate(row.updated_at).toISOString(),
            status: row.status as RunStatus,
            metadata: this.adapter.dbToJson(row.metadata),
            multitask_strategy: row.multitask_strategy as 'reject',
        }));
    }

    async updateRun(runId: string, run: Partial<Run>): Promise<void> {
        // 检查运行是否存在
        const existing = await this.db
            .selectFrom('runs')
            .select('run_id')
            .where('run_id', '=', runId)
            .executeTakeFirst();

        if (!existing) {
            throw new Error(`Run with ID ${runId} not found.`);
        }

        // 构建更新对象
        const updates: any = {
            updated_at: this.adapter.dateToDb(new Date()),
        };

        if (run.status !== undefined) {
            updates.status = run.status;
        }

        if (run.metadata !== undefined) {
            updates.metadata = this.adapter.jsonToDb(run.metadata);
        }

        if (run.multitask_strategy !== undefined) {
            updates.multitask_strategy = run.multitask_strategy;
        }

        await this.db.updateTable('runs').set(updates).where('run_id', '=', runId).execute();
    }

    // New methods for Threads API

    async count(query?: {
        ids?: string[];
        metadata?: Metadata;
        status?: ThreadStatus;
        values?: ValuesType;
    }): Promise<number> {
        const threads = await this.search(query);
        return threads.length;
    }

    async patch(
        threadId: string,
        updates: Partial<Omit<Thread<ValuesType>, 'thread_id' | 'created_at' | 'updated_at'>>,
    ): Promise<Thread<ValuesType>> {
        // 获取当前线程
        const existing = await this.db
            .selectFrom('threads')
            .selectAll()
            .where('thread_id', '=', threadId)
            .executeTakeFirst();

        if (!existing) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }

        // 构建更新对象，合并 metadata
        const patchUpdates: any = {
            updated_at: this.adapter.dateToDb(new Date()),
        };

        if (updates.metadata !== undefined) {
            const existingMetadata = this.adapter.dbToJson(existing.metadata) || {};
            patchUpdates.metadata = this.adapter.jsonToDb({ ...existingMetadata, ...updates.metadata });
        }

        if (updates.status !== undefined) {
            patchUpdates.status = updates.status;
        }

        if (updates.values !== undefined) {
            patchUpdates.values = updates.values ? this.adapter.jsonToDb(updates.values) : null;
        }

        if (updates.interrupts !== undefined) {
            patchUpdates.interrupts = this.adapter.jsonToDb(updates.interrupts);
        }

        await this.db.updateTable('threads').set(patchUpdates).where('thread_id', '=', threadId).execute();

        // 返回更新后的线程
        return await this.get(threadId);
    }

    async getState(threadId: string, options?: { subgraphs?: boolean; checkpointId?: string }): Promise<ThreadState> {
        const thread = await this.get(threadId);

        if (options?.checkpointId) {
            // Get state at specific checkpoint
            const checkpoint = await this.db
                .selectFrom('checkpoints')
                .selectAll()
                .where('checkpoint_id', '=', options.checkpointId)
                .where('thread_id', '=', threadId)
                .executeTakeFirst();

            if (!checkpoint) {
                throw new Error(`Checkpoint with ID ${options.checkpointId} not found for thread ${threadId}`);
            }

            return {
                values: this.adapter.dbToJson(checkpoint.values),
                next: this.adapter.dbToJson(checkpoint.next),
                metadata: this.adapter.dbToJson(checkpoint.metadata),
                checkpoint: {
                    /** @ts-ignore */
                    id: checkpoint.checkpoint_id,
                    thread_id: threadId,
                    parent_checkpoint_id: null,
                    checkpoint_ns: '',
                    metadata: this.adapter.dbToJson(checkpoint.metadata),
                    created_at: this.adapter.dbToDate(checkpoint.created_at).toISOString(),
                },
                created_at: this.adapter.dbToDate(checkpoint.created_at).toISOString(),
                parent_checkpoint: null,
                tasks: [],
            };
        }

        // Get latest state
        const state: ThreadState = {
            values: thread.values || {},
            next: [],
            metadata: thread.metadata,
            /**@ts-ignore 没有查询 checkpointer */
            checkpoint: null,
            created_at: thread.created_at,
            parent_checkpoint: null,
            tasks: [],
        };

        return state;
    }

    async getStateHistory(
        threadId: string,
        options?: {
            limit?: number;
            before?: string;
            filter?: { source?: string; step?: number };
        },
    ): Promise<ThreadState[]> {
        let queryBuilder = this.db
            .selectFrom('checkpoints')
            .selectAll()
            .where('thread_id', '=', threadId)
            .orderBy('created_at', 'asc');

        const checkpoints = await queryBuilder.execute();

        let history: ThreadState[] = checkpoints.map(
            (cp) =>
                ({
                    values: this.adapter.dbToJson(cp.values),
                    next: this.adapter.dbToJson(cp.next),
                    metadata: this.adapter.dbToJson(cp.metadata),
                    checkpoint: {
                        thread_id: threadId,
                        checkpoint_ns: '',
                        checkpoint_id: cp.checkpoint_id,
                        checkpoint_map: null,
                    },
                    created_at: this.adapter.dbToDate(cp.created_at).toISOString(),
                    parent_checkpoint: null,
                    tasks: [],
                } satisfies ThreadState),
        );

        // Filter by 'before' checkpoint ID
        if (options?.before) {
            const beforeIndex = checkpoints.findIndex((c) => c.checkpoint_id === options.before);
            if (beforeIndex !== -1) {
                history = history.slice(beforeIndex + 1);
            }
        }

        // Apply limit
        if (options?.limit) {
            history = history.slice(0, options.limit);
        }

        return history;
    }

    async copy(threadId: string): Promise<Thread<ValuesType>> {
        const originalThread = await this.get(threadId);

        // Create new thread
        const newThreadId = v7();
        const now = new Date();

        await this.db
            .insertInto('threads')
            .values({
                thread_id: newThreadId,
                created_at: this.adapter.dateToDb(now) as any,
                updated_at: this.adapter.dateToDb(now) as any,
                metadata: this.adapter.jsonToDb(originalThread.metadata) as any,
                status: originalThread.status,
                values: originalThread.values ? (this.adapter.jsonToDb(originalThread.values) as any) : (null as any),
                interrupts: this.adapter.jsonToDb(originalThread.interrupts) as any,
            })
            .execute();

        // Copy checkpoints
        const checkpoints = await this.db
            .selectFrom('checkpoints')
            .selectAll()
            .where('thread_id', '=', threadId)
            .orderBy('created_at', 'asc')
            .execute();

        for (const cp of checkpoints) {
            await this.db
                .insertInto('checkpoints')
                .values({
                    checkpoint_id: v7(),
                    thread_id: newThreadId,
                    values: cp.values,
                    next: cp.next,
                    config: cp.config,
                    created_at: cp.created_at,
                    metadata: cp.metadata,
                })
                .execute();
        }

        return {
            ...originalThread,
            thread_id: newThreadId,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
        };
    }

    // Helper method to save checkpoint (used internally)
    private async saveCheckpoint(
        threadId: string,
        values: any,
        next: string[],
        config: Config,
        metadata?: Metadata,
    ): Promise<void> {
        await this.db
            .insertInto('checkpoints')
            .values({
                checkpoint_id: v7(),
                thread_id: threadId,
                values: this.adapter.jsonToDb(values) as any,
                next: this.adapter.jsonToDb(next) as any,
                config: this.adapter.jsonToDb(config) as any,
                created_at: this.adapter.dateToDb(new Date()) as any,
                metadata: this.adapter.jsonToDb(metadata || {}) as any,
            })
            .execute();
    }
}
