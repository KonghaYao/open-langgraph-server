import {
    Thread,
    Assistant,
    Run,
    StreamMode,
    Command,
    Metadata,
    AssistantGraph,
    OnConflictBehavior,
    ThreadStatus,
    Checkpoint,
    Config,
} from '@langchain/langgraph-sdk';
import { StreamEvent } from '@langchain/core/tracers/log_stream';
import { EventMessage } from './queue/event_message';
import { RunnableConfig } from '@langchain/core/runnables';

// 基础类型定义
export type AssistantSortBy = 'assistant_id' | 'graph_id' | 'name' | 'created_at' | 'updated_at';
export type ThreadSortBy = 'thread_id' | 'status' | 'created_at' | 'updated_at';
export type SortOrder = 'asc' | 'desc';
export type RunStatus = 'pending' | 'running' | 'error' | 'success' | 'timeout' | 'interrupted';
export type MultitaskStrategy = 'reject' | 'interrupt' | 'rollback' | 'enqueue';
export type DisconnectMode = 'cancel' | 'continue';
export type OnCompletionBehavior = 'complete' | 'continue';
export type CancelAction = 'interrupt' | 'rollback';

export type StreamInputData = {
    input?: Record<string, unknown> | null;
    metadata?: Metadata;
    config?: RunnableConfig;
    checkpointId?: string;
    checkpoint?: Omit<Checkpoint, 'thread_id'>;
    checkpoint_during?: boolean;
    interruptBefore?: '*' | string[];
    interruptAfter?: '*' | string[];
    multitaskStrategy?: MultitaskStrategy;
    onCompletion?: OnCompletionBehavior;
    signal?: AbortController['signal'];
    webhook?: string;
    onDisconnect?: DisconnectMode;
    afterSeconds?: number;
    ifNotExists?: 'create' | 'reject';
    command?: Command;
    onRunCreated?: (params: { run_id: string; thread_id?: string }) => void;
    streamMode?: StreamMode[];
    streamSubgraphs?: boolean;
    streamResumable?: boolean;
    temporary?: boolean;
};
/**
 * 兼容 LangGraph SDK 的接口定义，方便进行无侵入式的扩展
 */
export interface ILangGraphClient<TStateType = unknown> {
    assistants: {
        search(query?: {
            graphId?: string;
            metadata?: Metadata;
            limit?: number;
            offset?: number;
            sortBy?: AssistantSortBy;
            sortOrder?: SortOrder;
        }): Promise<Assistant[]>;
        getGraph(assistantId: string, options?: { xray?: boolean | number }): Promise<AssistantGraph>;
    };
    threads: {
        create(payload?: {
            metadata?: Metadata;
            threadId?: string;
            ifExists?: OnConflictBehavior;
            graphId?: string;
            // supersteps?: Array<{
            //     updates: Array<{
            //         values: unknown;
            //         command?: Command;
            //         as_node: string;
            //     }>;
            // }>;
        }): Promise<Thread<TStateType>>;
        search(query?: {
            ids?: string[];
            metadata?: Metadata;
            limit?: number;
            offset?: number;
            status?: ThreadStatus;
            sortBy?: ThreadSortBy;
            sortOrder?: SortOrder;
            values?: unknown;
            select?: Array<'thread_id' | 'created_at' | 'updated_at' | 'metadata' | 'config' | 'context' | 'status' | 'values' | 'interrupts'>;
            /**
             * @deprecated Use `select` parameter instead for fine-grained field control
             */
            withoutDetails?: boolean;
        }): Promise<Thread<TStateType>[]>;
        get(threadId: string): Promise<Thread<TStateType>>;
        delete(threadId: string): Promise<void>;
        updateState(threadId: string, thread: Partial<Thread<TStateType>>): Promise<Pick<Config, 'configurable'>>;
    };
    runs: {
        list(
            threadId: string,
            options?: {
                limit?: number;
                offset?: number;
                status?: RunStatus;
            },
        ): Promise<Run[]>;

        stream(threadId: string, assistantId: string, payload?: StreamInputData): AsyncGenerator<EventMessage>;
        joinStream(
            threadId: string,
            runId: string,
            options?:
                | {
                      signal?: AbortSignal;
                      cancelOnDisconnect?: boolean;
                      lastEventId?: string;
                      streamMode?: StreamMode | StreamMode[];
                  }
                | AbortSignal,
        ): AsyncGenerator<{ id?: string; event: StreamEvent; data: any }>;
        cancel(threadId: string, runId: string, wait?: boolean, action?: CancelAction): Promise<void>;
    };
}
