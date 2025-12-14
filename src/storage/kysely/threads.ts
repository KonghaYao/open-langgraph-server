import { Kysely } from 'kysely';
import { BaseThreadsManager } from '../../threads/index.js';
import { Command, Config, Metadata, OnConflictBehavior, Run, Thread, ThreadStatus } from '@langgraph-js/sdk';
import { RunStatus, SortOrder, ThreadSortBy } from '../../types';
import { Database } from './types';
import { DatabaseAdapter } from './adapter';
import { getGraph } from '../../utils/getGraph.js';
import { serialiseAsDict } from '../../graph/stream.js';

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
        const threadId = payload?.threadId || crypto.randomUUID();

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

        const now = new Date();
        const metadata = payload?.metadata || {};
        const interrupts = {};

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
            metadata,
            status: 'idle',
            values: null as unknown as ValuesType,
            interrupts,
        };
    }

    async search(query?: {
        metadata?: Metadata;
        limit?: number;
        offset?: number;
        status?: ThreadStatus;
        sortBy?: ThreadSortBy;
        sortOrder?: SortOrder;
        withoutDetails?: boolean;
    }): Promise<Thread<ValuesType>[]> {
        let queryBuilder = this.db.selectFrom('threads').selectAll();

        // 根据 without_details 决定是否选择 values 和 interrupt 字段
        if (query?.withoutDetails) {
            queryBuilder = this.db
                .selectFrom('threads')
                .select(['thread_id', 'created_at', 'updated_at', 'metadata', 'status']) as any;
        }

        // 添加状态过滤
        if (query?.status) {
            queryBuilder = queryBuilder.where('status', '=', query.status);
        }

        // 添加 metadata 过滤
        if (query?.metadata) {
            for (const [key, value] of Object.entries(query.metadata)) {
                queryBuilder = queryBuilder.where(this.adapter.buildJsonQuery(this.db, 'metadata', key, value) as any);
            }
        }

        // 添加排序
        if (query?.sortBy) {
            const order = query.sortOrder === 'desc' ? 'desc' : 'asc';
            queryBuilder = queryBuilder.orderBy(query.sortBy as any, order);
        }

        // 添加分页
        if (query?.limit !== undefined) {
            queryBuilder = queryBuilder.limit(query.limit);
            if (query?.offset !== undefined) {
                queryBuilder = queryBuilder.offset(query.offset);
            }
        }

        const rows = await queryBuilder.execute();

        return rows.map((row) => ({
            thread_id: row.thread_id,
            created_at: this.adapter.dbToDate(row.created_at).toISOString(),
            updated_at: this.adapter.dbToDate(row.updated_at).toISOString(),
            metadata: this.adapter.dbToJson(row.metadata),
            status: row.status as ThreadStatus,
            values: row.values ? this.adapter.dbToJson(row.values) : (null as unknown as ValuesType),
            interrupts: this.adapter.dbToJson(row.interrupts),
        }));
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

    async updateState(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<Pick<Config, 'configurable'>> {
        // 获取线程信息
        const targetThread = await this.get(threadId);

        if (targetThread.status === 'busy') {
            throw new Error(`Thread with ID ${threadId} is busy, can't update state.`);
        }

        if (!targetThread.metadata?.graph_id) {
            throw new Error(`Thread with ID ${threadId} has no graph_id.`);
        }

        const graphId = targetThread.metadata?.graph_id as string;
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

    async delete(threadId: string): Promise<void> {
        const result = await this.db.deleteFrom('threads').where('thread_id', '=', threadId).executeTakeFirst();

        if (result.numDeletedRows === 0n) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }
    }

    async createRun(threadId: string, assistantId: string, payload?: { metadata?: Metadata }): Promise<Run> {
        const runId = crypto.randomUUID();
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
}
