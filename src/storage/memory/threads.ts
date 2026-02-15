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
import { getGraph } from '../../utils/getGraph.js';
import { serialiseAsDict } from '../../graph/stream.js';
import { RunStatus, SortOrder, ThreadSortBy } from '../../types';
import { v7 } from 'uuid';

// Store thread history states
interface ThreadCheckpoint {
    checkpoint_id: string;
    thread_id: string;
    values: any;
    next: string[];
    config: Config;
    created_at: string;
    metadata?: Metadata;
}

export class MemoryThreadsManager<ValuesType = unknown> implements BaseThreadsManager<ValuesType> {
    private threads: Thread<ValuesType>[] = [];
    private checkpoints: Map<string, ThreadCheckpoint[]> = new Map();

    async setup() {
        return;
    }

    async create(payload?: {
        metadata?: Metadata;
        threadId?: string;
        ifExists?: OnConflictBehavior;
        graphId?: string;
        supersteps?: Array<{ updates: Array<{ values: unknown; command?: Command; asNode: string }> }>;
    }): Promise<Thread<ValuesType>> {
        const threadId = payload?.threadId || v7();
        if (payload?.ifExists === 'raise' && this.threads.some((t) => t.thread_id === threadId)) {
            throw new Error(`Thread with ID ${threadId} already exists.`);
        }

        const thread: Thread<ValuesType> = {
            thread_id: threadId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: payload?.metadata || {},
            status: 'idle',
            values: null as unknown as ValuesType,
            interrupts: {},
        };

        // Initialize checkpoint history
        this.checkpoints.set(threadId, []);

        this.threads.push(thread);
        return thread;
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
        let filteredThreads = [...this.threads];

        // Filter by IDs
        if (query?.ids && query.ids.length > 0) {
            filteredThreads = filteredThreads.filter((t) => query.ids!.includes(t.thread_id));
        }

        // Filter by status
        if (query?.status) {
            filteredThreads = filteredThreads.filter((t) => t.status === query.status);
        }

        // Filter by metadata
        if (query?.metadata) {
            for (const key in query.metadata) {
                if (Object.prototype.hasOwnProperty.call(query.metadata, key)) {
                    filteredThreads = filteredThreads.filter(
                        (t) => t.metadata && t.metadata[key] === query.metadata?.[key],
                    );
                }
            }
        }

        // Filter by values
        if (query?.values) {
            filteredThreads = filteredThreads.filter((t) => {
                if (!t.values) return false;
                return this.deepEqual(t.values, query.values);
            });
        }

        // Sort
        if (query?.sortBy) {
            filteredThreads.sort((a, b) => {
                let aValue: any;
                let bValue: any;

                switch (query.sortBy) {
                    case 'thread_id':
                        aValue = a.thread_id;
                        bValue = b.thread_id;
                        break;
                    case 'created_at':
                        aValue = new Date(a.created_at).getTime();
                        bValue = new Date(b.created_at).getTime();
                        break;
                    case 'updated_at':
                        aValue = new Date(a.updated_at).getTime();
                        bValue = new Date(b.updated_at).getTime();
                        break;
                    case 'status':
                        aValue = a.status;
                        bValue = b.status;
                        break;
                    default:
                        return 0;
                }

                if (query.sortOrder === 'desc') {
                    return bValue > aValue ? 1 : bValue < aValue ? -1 : 0;
                } else {
                    return aValue > bValue ? 1 : aValue < bValue ? -1 : 0;
                }
            });
        }

        const offset = query?.offset || 0;
        const limit = query?.limit || filteredThreads.length;

        const paginatedThreads = filteredThreads.slice(offset, offset + limit);

        // Handle select/withoutDetails to filter fields
        return paginatedThreads.map((i) => {
            const result: Partial<Thread<ValuesType>> = { thread_id: i.thread_id };

            // Determine which fields to include
            let includeFields: Set<string>;

            if (query?.select) {
                includeFields = new Set(query.select);
            } else if (query?.withoutDetails) {
                // Legacy withoutDetails behavior - exclude values and interrupts
                includeFields = new Set(['thread_id', 'created_at', 'updated_at', 'metadata', 'status']);
            } else {
                // All fields
                includeFields = new Set([
                    'thread_id',
                    'created_at',
                    'updated_at',
                    'metadata',
                    'status',
                    'values',
                    'interrupts',
                ]);
            }

            if (includeFields.has('thread_id')) result.thread_id = i.thread_id;
            if (includeFields.has('created_at')) result.created_at = i.created_at;
            if (includeFields.has('updated_at')) result.updated_at = i.updated_at;
            if (includeFields.has('metadata')) result.metadata = i.metadata;
            if (includeFields.has('status')) result.status = i.status;
            if (includeFields.has('values')) result.values = i.values;
            if (includeFields.has('interrupts')) result.interrupts = i.interrupts;

            return result as Thread<ValuesType>;
        });
    }

    private deepEqual(a: any, b: any): boolean {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (typeof a !== 'object' || a === null || b === null) return false;

        const keysA = Object.keys(a);
        const keysB = Object.keys(b);

        if (keysA.length !== keysB.length) return false;

        for (const key of keysA) {
            if (!keysB.includes(key)) return false;
            if (!this.deepEqual(a[key], b[key])) return false;
        }

        return true;
    }

    async get(threadId: string): Promise<Thread<ValuesType>> {
        const thread = this.threads.find((t) => t.thread_id === threadId);
        if (!thread) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }
        return thread;
    }

    async set(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<void> {
        const index = this.threads.findIndex((t) => t.thread_id === threadId);
        if (index === -1) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }
        this.threads[index] = { ...this.threads[index], ...thread };
    }

    async delete(threadId: string): Promise<void> {
        const initialLength = this.threads.length;
        this.threads = this.threads.filter((t) => t.thread_id !== threadId);
        this.checkpoints.delete(threadId);
        if (this.threads.length === initialLength) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }
    }

    async updateState(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<Pick<Config, 'configurable'>> {
        const index = this.threads.findIndex((t) => t.thread_id === threadId) as number;
        if (index === -1) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }
        const targetThread = this.threads[index];

        if (targetThread.status === 'busy') {
            throw new Error(`Thread with ID ${threadId} is busy, can't update state.`);
        }

        // Allow updating state even without graph_id for basic functionality
        this.threads[index] = {
            ...targetThread,
            values: thread.values as ValuesType,
            updated_at: new Date().toISOString(),
        };

        // If graph_id is present, use graph to update state
        if (targetThread.metadata?.graph_id) {
            const graphId = targetThread.metadata?.graph_id as string;
            const config = {
                configurable: {
                    thread_id: threadId,
                    graph_id: graphId,
                },
            };
            try {
                const graph = await getGraph(graphId, config);
                const nextConfig = await graph.updateState(config, thread.values);
                const graphState = await graph.getState(config);
                await this.set(threadId, { values: JSON.parse(serialiseAsDict(graphState.values)) as ValuesType });
                return nextConfig;
            } catch (error) {
                // If graph update fails, still return a valid response
                console.warn('Failed to update graph state:', error);
            }
        }

        return {
            configurable: {
                thread_id: threadId,
            },
        };
    }

    runs: Run[] = [];

    async createRun(threadId: string, assistantId: string, payload?: { metadata?: Metadata }): Promise<Run> {
        const runId = v7();
        const run: Run = {
            run_id: runId,
            thread_id: threadId,
            assistant_id: assistantId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: 'pending',
            metadata: payload?.metadata ?? {},
            multitask_strategy: 'reject',
        };
        this.runs.push(run);
        return run;
    }

    async listRuns(
        threadId: string,
        options?: { limit?: number; offset?: number; status?: RunStatus },
    ): Promise<Run[]> {
        let filteredRuns = [...this.runs];
        if (options?.status) {
            filteredRuns = filteredRuns.filter((r) => r.status === options.status);
        }
        if (options?.limit) {
            filteredRuns = filteredRuns.slice(options.offset || 0, (options.offset || 0) + options.limit);
        }
        return filteredRuns;
    }

    async updateRun(runId: string, run: Partial<Run>): Promise<void> {
        const index = this.runs.findIndex((r) => r.run_id === runId);
        if (index === -1) {
            throw new Error(`Run with ID ${runId} not found.`);
        }
        this.runs[index] = { ...this.runs[index], ...run };
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
        const index = this.threads.findIndex((t) => t.thread_id === threadId);
        if (index === -1) {
            throw new Error(`Thread with ID ${threadId} not found.`);
        }

        // Merge metadata if provided
        const updatedThread: Thread<ValuesType> = {
            ...this.threads[index],
            ...updates,
            updated_at: new Date().toISOString(),
            metadata: updates.metadata
                ? { ...this.threads[index].metadata, ...updates.metadata }
                : this.threads[index].metadata,
        };

        this.threads[index] = updatedThread;
        return updatedThread;
    }

    async getState(threadId: string, options?: { subgraphs?: boolean; checkpointId?: string }): Promise<ThreadState> {
        const thread = await this.get(threadId);

        if (options?.checkpointId) {
            // Get state at specific checkpoint
            const checkpoints = this.checkpoints.get(threadId) || [];
            const checkpoint = checkpoints.find((c) => c.checkpoint_id === options.checkpointId);
            if (!checkpoint) {
                throw new Error(`Checkpoint with ID ${options.checkpointId} not found for thread ${threadId}`);
            }
            return {
                values: checkpoint.values,
                next: checkpoint.next,
                metadata: checkpoint.metadata,
                checkpoint: {
                    /** @ts-ignore 附加属性 */
                    id: checkpoint.checkpoint_id,
                    thread_id: threadId,
                    parent_checkpoint_id: null,
                    checkpoint_ns: '',
                    metadata: checkpoint.metadata,
                    created_at: checkpoint.created_at,
                },
                created_at: checkpoint.created_at,
                parent_checkpoint: null,
                tasks: [],
            };
        }

        // Get latest state
        const state: ThreadState = {
            values: thread.values || {},
            next: [],
            metadata: thread.metadata,
            /** @ts-ignore 没有查询过 */
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
        const checkpoints = this.checkpoints.get(threadId) || [];

        let history: ThreadState[] = checkpoints.map(
            (cp) =>
                ({
                    values: cp.values,
                    next: cp.next,
                    metadata: cp.metadata,
                    checkpoint: {
                        checkpoint_id: cp.checkpoint_id,
                        thread_id: threadId,
                        checkpoint_ns: '',
                        checkpoint_map: undefined,
                    },
                    created_at: cp.created_at,
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
        const newThread: Thread<ValuesType> = {
            ...originalThread,
            thread_id: newThreadId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        this.threads.push(newThread);

        // Copy checkpoints
        const originalCheckpoints = this.checkpoints.get(threadId) || [];
        const newCheckpoints = originalCheckpoints.map((cp) => ({
            ...cp,
            checkpoint_id: v7(), // Generate new checkpoint IDs
            thread_id: newThreadId,
        }));
        this.checkpoints.set(newThreadId, newCheckpoints);

        return newThread;
    }

    // Helper method to save checkpoint (used internally)
    async saveCheckpoint(
        threadId: string,
        values: any,
        next: string[],
        config: Config,
        metadata?: Metadata,
    ): Promise<void> {
        const checkpoints = this.checkpoints.get(threadId) || [];
        const checkpoint: ThreadCheckpoint = {
            checkpoint_id: v7(),
            thread_id: threadId,
            values,
            next,
            config,
            created_at: new Date().toISOString(),
            metadata,
        };
        checkpoints.push(checkpoint);
        this.checkpoints.set(threadId, checkpoints);
    }
}
