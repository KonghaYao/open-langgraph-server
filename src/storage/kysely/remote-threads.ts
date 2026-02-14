/**
 * Remote Kysely Threads Manager
 * 通过 HTTP/REST API 与远程 PostgreSQL 服务器通信
 */

import { BaseThreadsManager } from '../../threads';
import {
    Metadata,
    OnConflictBehavior,
    Run,
    Thread,
    ThreadState,
} from '@langgraph-js/sdk';
import { RunStatus, SortOrder, ThreadSortBy } from '../../types';
import { remoteGet, remotePost, remotePut, remoteDelete } from '../remote/fetch';
import { RemoteApiError, RemoteErrorCode } from '../remote/types';

/**
 * 远程 Kysely Threads Manager
 */
export class RemoteKyselyThreadsManager<ValuesType = unknown>
    implements BaseThreadsManager<ValuesType> {

    constructor(
        private serverUrl: string,
        private httpClient?: typeof fetch
    ) {
        // 确保服务器 URL 没有尾部斜杠
        this.serverUrl = serverUrl.replace(/\/$/, '');
        this.httpClient = httpClient || fetch;
    }

    /**
     * 初始化数据库
     */
    async setup(): Promise<void> {
        await remotePost(`${this.serverUrl}/setup`);
    }

    /**
     * 创建线程
     */
    async create(payload?: {
        metadata?: Metadata;
        threadId?: string;
        ifExists?: OnConflictBehavior;
        graphId?: string;
        supersteps?: Array<{ updates: Array<{ values: unknown; command?: any; asNode: string }> }>;
    }): Promise<Thread<ValuesType>> {
        const response = await remotePost<Thread<ValuesType>>(`${this.serverUrl}/threads`, payload);
        return response.data as Thread<ValuesType>;
    }

    /**
     * 搜索线程
     */
    async search(query?: {
        ids?: string[];
        metadata?: Metadata;
        limit?: number;
        offset?: number;
        status?: any;
        sortBy?: ThreadSortBy;
        sortOrder?: SortOrder;
        values?: ValuesType;
        select?: Array<'thread_id' | 'created_at' | 'updated_at' | 'metadata' | 'config' | 'context' | 'status' | 'values' | 'interrupts'>;
        /**
         * @deprecated Use `select` parameter instead for fine-grained field control
         */
        withoutDetails?: boolean;
    }): Promise<Thread<ValuesType>[]> {
        const params: Record<string, string | number | boolean> = {};

        if (query?.ids !== undefined && query.ids.length > 0) {
            params.ids = JSON.stringify(query.ids);
        }
        if (query?.metadata !== undefined) {
            params.metadata = JSON.stringify(query.metadata);
        }
        if (query?.limit !== undefined) {
            params.limit = query.limit;
        }
        if (query?.offset !== undefined) {
            params.offset = query.offset;
        }
        if (query?.status !== undefined) {
            params.status = query.status;
        }
        if (query?.sortBy !== undefined) {
            params.sortBy = query.sortBy;
        }
        if (query?.sortOrder !== undefined) {
            params.sortOrder = query.sortOrder;
        }
        if (query?.values !== undefined) {
            params.values = JSON.stringify(query.values);
        }
        if (query?.select !== undefined) {
            params.select = JSON.stringify(query.select);
        }
        if (query?.withoutDetails !== undefined) {
            params.withoutDetails = query.withoutDetails;
        }

        const response = await remoteGet<Thread<ValuesType>[]>(`${this.serverUrl}/threads`, params);
        return response.data as Thread<ValuesType>[];
    }

    /**
     * 获取线程
     */
    async get(threadId: string): Promise<Thread<ValuesType>> {
        const response = await remoteGet<Thread<ValuesType>>(`${this.serverUrl}/threads/${threadId}`);
        return response.data as Thread<ValuesType>;
    }

    /**
     * 更新线程
     */
    async set(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<void> {
        await remotePut(`${this.serverUrl}/threads/${threadId}`, thread);
    }

    /**
     * 删除线程
     */
    async delete(threadId: string): Promise<void> {
        await remoteDelete(`${this.serverUrl}/threads/${threadId}`);
    }

    /**
     * 更新状态
     */
    async updateState(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<{ configurable: Record<string, any> }> {
        const response = await remotePost<{ configurable: Record<string, any> }>(
            `${this.serverUrl}/threads/${threadId}/state`,
            thread
        );
        return response.data as { configurable: Record<string, any> };
    }

    /**
     * 创建运行
     */
    async createRun(threadId: string, assistantId: string, payload?: { metadata?: Metadata }): Promise<Run> {
        const response = await remotePost<Run>(
            `${this.serverUrl}/threads/${threadId}/runs`,
            payload || {},
            { assistantId }
        );
        return response.data as Run;
    }

    /**
     * 列出运行
     */
    async listRuns(threadId: string, options?: { limit?: number; offset?: number; status?: RunStatus }): Promise<Run[]> {
        const params: Record<string, string | number> = {};

        if (options?.limit !== undefined) {
            params.limit = options.limit;
        }
        if (options?.offset !== undefined) {
            params.offset = options.offset;
        }
        if (options?.status !== undefined) {
            params.status = options.status;
        }

        const response = await remoteGet<Run[]>(`${this.serverUrl}/threads/${threadId}/runs`, params);
        return response.data as Run[];
    }

    /**
     * 更新运行
     */
    async updateRun(runId: string, run: Partial<Run>): Promise<void> {
        await remotePut(`${this.serverUrl}/runs/${runId}`, run);
    }

    // New methods for Threads API

    /**
     * 计算线程数量
     */
    async count(query?: {
        ids?: string[];
        metadata?: Metadata;
        status?: any;
        values?: ValuesType;
    }): Promise<number> {
        const params: Record<string, string> = {};

        if (query?.ids !== undefined && query.ids.length > 0) {
            params.ids = JSON.stringify(query.ids);
        }
        if (query?.metadata !== undefined) {
            params.metadata = JSON.stringify(query.metadata);
        }
        if (query?.status !== undefined) {
            params.status = query.status;
        }
        if (query?.values !== undefined) {
            params.values = JSON.stringify(query.values);
        }

        const response = await remoteGet<number>(`${this.serverUrl}/threads/count`, params);
        return response.data as number;
    }

    /**
     * 更新线程元数据
     */
    async patch(threadId: string, updates: Partial<Omit<Thread<ValuesType>, 'thread_id' | 'created_at' | 'updated_at'>>): Promise<Thread<ValuesType>> {
        const response = await remotePost<Thread<ValuesType>>(`${this.serverUrl}/threads/${threadId}`, updates);
        return response.data as Thread<ValuesType>;
    }

    /**
     * 获取线程状态
     */
    async getState(threadId: string, options?: { subgraphs?: boolean; checkpointId?: string }): Promise<ThreadState> {
        const params: Record<string, boolean> = {};

        if (options?.subgraphs !== undefined) {
            params.subgraphs = options.subgraphs;
        }
        if (options?.checkpointId !== undefined) {
            params.checkpointId = options.checkpointId;
        }

        const response = await remotePost<ThreadState>(`${this.serverUrl}/threads/${threadId}/state`, params);
        return response.data as ThreadState;
    }

    /**
     * 获取线程历史
     */
    async getStateHistory(threadId: string, options?: {
        limit?: number;
        before?: string;
        filter?: { source?: string; step?: number };
    }): Promise<ThreadState[]> {
        const params: Record<string, number | string> = {};

        if (options?.limit !== undefined) {
            params.limit = options.limit;
        }
        if (options?.before !== undefined) {
            params.before = options.before;
        }

        const response = await remotePost<ThreadState[]>(`${this.serverUrl}/threads/${threadId}/history`, params);
        return response.data as ThreadState[];
    }

    /**
     * 复制线程
     */
    async copy(threadId: string): Promise<Thread<ValuesType>> {
        const response = await remotePost<Thread<ValuesType>>(`${this.serverUrl}/threads/${threadId}/copy`);
        return response.data as Thread<ValuesType>;
    }
}
