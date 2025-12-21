import { StreamEvent } from '@langchain/core/tracers/log_stream';
import { streamState } from './graph/stream.js';
import { Assistant, Run, StreamMode, Metadata, AssistantGraph } from '@langchain/langgraph-sdk';
import { getGraph, GRAPHS } from './utils/getGraph.js';
import { LangGraphGlobal } from './global.js';
import { AssistantSortBy, CancelAction, ILangGraphClient, RunStatus, SortOrder, StreamInputData } from './types.js';
export { registerGraph } from './utils/getGraph.js';

export const AssistantEndpoint: ILangGraphClient['assistants'] = {
    async search(query?: {
        graphId?: string;
        metadata?: Metadata;
        limit?: number;
        offset?: number;
        sortBy?: AssistantSortBy;
        sortOrder?: SortOrder;
    }): Promise<Assistant[]> {
        if (query?.graphId) {
            return [
                {
                    assistant_id: query.graphId,
                    graph_id: query.graphId,
                    config: {},
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    metadata: {},
                    version: 1,
                    name: query.graphId,
                    description: '',
                } as Assistant,
            ];
        }
        return Object.entries(GRAPHS).map(
            ([graphId, _]) =>
                ({
                    assistant_id: graphId,
                    graph_id: graphId,
                    config: {},
                    metadata: {},
                    version: 1,
                    name: graphId,
                    description: '',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                } as Assistant),
        );
    },
    async getGraph(assistantId: string, options?: { xray?: boolean | number }): Promise<AssistantGraph> {
        const config = {};
        const graph = await getGraph(assistantId, config);
        const drawable = await graph.getGraphAsync({
            ...config,
            xray: options?.xray ?? undefined,
        });
        return drawable.toJSON() as AssistantGraph;
    },
};

export const createEndpoint = () => {
    const getThreads = () => {
        return LangGraphGlobal.globalThreadsManager;
    };
    return {
        assistants: AssistantEndpoint,
        get threads() {
            return LangGraphGlobal.globalThreadsManager;
        },
        runs: {
            list(
                threadId: string,
                options?: {
                    limit?: number;
                    offset?: number;
                    status?: RunStatus;
                },
            ): Promise<Run[]> {
                return getThreads().listRuns(threadId, options);
            },
            async cancel(threadId: string, runId: string, wait?: boolean, action?: CancelAction): Promise<void> {
                return LangGraphGlobal.globalMessageQueue.cancelQueue(runId);
            },
            async *stream(threadId: string, assistantId: string, payload: StreamInputData) {
                payload.config = {
                    ...(payload.config ?? {}),
                    configurable: {
                        ...(payload.config?.configurable ?? {}),
                        graph_id: assistantId,
                        thread_id: threadId,
                    },
                };
                const threads = getThreads();
                for await (const data of streamState(
                    threads,
                    threads.createRun(threadId, assistantId, payload),
                    payload,
                    {
                        attempt: 0,
                        getGraph,
                    },
                )) {
                    yield data;
                }
            },
            async *joinStream(
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
            ): AsyncGenerator<{ id?: string; event: StreamEvent; data: any }> {
                // 处理参数兼容性
                const config = options && typeof options === 'object' && 'signal' in options ? options : {};
                const signal =
                    (options instanceof AbortSignal ? options : config.signal) || new AbortController().signal;

                try {
                    // 获取 Redis 队列实例
                    const queue = await LangGraphGlobal.globalMessageQueue.getQueue(runId);
                    const allData = await queue.getAll();
                    for (const eventMessage of allData) {
                        yield {
                            id: eventMessage.id,
                            event: eventMessage.event as unknown as StreamEvent,
                            data: eventMessage.data,
                        };
                        // 如果是流结束信号，停止监听
                        if (
                            eventMessage.event === '__stream_end__' ||
                            eventMessage.event === '__stream_error__' ||
                            eventMessage.event === '__stream_cancel__'
                        ) {
                            return;
                        }
                    }
                    // 监听队列数据并转换格式
                    for await (const eventMessage of queue.onDataReceive()) {
                        // 检查是否被取消
                        if (signal.aborted) {
                            break;
                        }

                        // 转换 EventMessage 为期望的格式
                        const event = eventMessage.event as unknown as StreamEvent;
                        const data = eventMessage.data;

                        yield {
                            id: eventMessage.id,
                            event,
                            data,
                        };

                        // 如果是流结束信号，停止监听
                        if (
                            eventMessage.event === '__stream_end__' ||
                            eventMessage.event === '__stream_error__' ||
                            eventMessage.event === '__stream_cancel__'
                        ) {
                            break;
                        }
                    }
                } catch (error) {
                    // 如果队列不存在或其他错误，记录警告但不抛出错误
                    console.warn('Join stream failed:', error);
                }
            },
        },
    };
};
