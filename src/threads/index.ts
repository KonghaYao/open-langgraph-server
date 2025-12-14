import { Command, Config, Metadata, OnConflictBehavior, Run, Thread, ThreadStatus } from '@langgraph-js/sdk';
import { RunStatus, SortOrder, ThreadSortBy } from '../types';

export interface BaseThreadsManager<ValuesType = unknown> {
    setup(): Promise<void>;
    create(payload?: {
        metadata?: Metadata;
        threadId?: string;
        ifExists?: OnConflictBehavior;
        graphId?: string;
        supersteps?: Array<{ updates: Array<{ values: unknown; command?: Command; asNode: string }> }>;
    }): Promise<Thread<ValuesType>>;
    set(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<void>;
    search(query?: {
        metadata?: Metadata;
        limit?: number;
        offset?: number;
        status?: ThreadStatus;
        sortBy?: ThreadSortBy;
        sortOrder?: SortOrder;
        /**
         * @default false
         * @description 是否不返回 values 字段
         */
        withoutDetails?: boolean;
    }): Promise<Thread<ValuesType>[]>;
    get(threadId: string): Promise<Thread<ValuesType>>;
    delete(threadId: string): Promise<void>;
    updateState(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<Pick<Config, 'configurable'>>;
    createRun(threadId: string, assistantId: string, payload?: { metadata?: Metadata }): Promise<Run>;
    listRuns(threadId: string, options?: { limit?: number; offset?: number; status?: RunStatus }): Promise<Run[]>;
    updateRun(runId: string, run: Partial<Run>): Promise<void>;
}
