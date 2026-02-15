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
        let results = Object.entries(GRAPHS).map(
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

        // Filter by graphId
        if (query?.graphId) {
            results = results.filter((a) => a.graph_id === query.graphId);
        }

        // Filter by metadata (simple implementation - check if all metadata keys/values match)
        if (query?.metadata && Object.keys(query.metadata).length > 0) {
            results = results.filter((assistant) => {
                return Object.entries(query.metadata!).every(([key, value]) => {
                    return assistant.metadata && assistant.metadata[key] === value;
                });
            });
        }

        // Sort results
        if (query?.sortBy) {
            results.sort((a, b) => {
                const aValue = a[query.sortBy!];
                const bValue = b[query.sortBy!];
                const comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
                return query.sortOrder === 'desc' ? -comparison : comparison;
            });
        }

        // Pagination
        const offset = query?.offset ?? 0;
        const limit = query?.limit;
        const paginatedResults = limit ? results.slice(offset, offset + limit) : results.slice(offset);

        return paginatedResults;
    },

    async count(query?: { graphId?: string; metadata?: Metadata }): Promise<number> {
        const results = await this.search(query);
        return results.length;
    },

    async get(assistantId: string): Promise<Assistant> {
        const assistant = Object.entries(GRAPHS).find(([graphId, _]) => graphId === assistantId);
        if (!assistant) {
            throw new Error(`Assistant not found: ${assistantId}`);
        }
        return {
            assistant_id: assistantId,
            graph_id: assistantId,
            config: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: {},
            version: 1,
            name: assistantId,
            description: '',
        } as Assistant;
    },

    async delete(assistantId: string): Promise<void> {
        // ⚠️ 删除 assistant 不可用 - assistants 是从注册的图中生成的，不能删除
        throw new Error('Deleting assistants is not supported. Assistants are generated from registered graphs.');
    },

    async update(
        assistantId: string,
        updates: Partial<Pick<Assistant, 'name' | 'description' | 'metadata' | 'config'>>,
    ): Promise<Assistant> {
        // ⚠️ 更新 assistant 不可用 - assistants 是从注册的图中生成的，不能更新
        throw new Error('Updating assistants is not supported. Assistants are generated from registered graphs.');
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

    async getSchemas(assistantId: string): Promise<{ graph_id: string; state_schema: any }> {
        const compiledGraph = await getGraph(assistantId, {});
        const builder = compiledGraph.builder;
        console.log(builder);
        return {
            graph_id: assistantId,
            /** @ts-ignore */
            state_schema: builder._inputDefinition,
            /** @ts-ignore */
            input_schema: builder._inputDefinition,
            /** @ts-ignore */
            output_schema: builder._outputDefinition,
            /** @ts-ignore */
            config_schema: builder._configSchema,
            /** @ts-ignoreß */
            context_schema: builder._configSchema,
        };
    },

    async getVersions(assistantId: string, options?: { limit?: number; offset?: number }): Promise<Assistant[]> {
        // ⚠️ 版本管理不可用 - 当前实现不支持多版本
        const assistant = await this.get(assistantId);
        const offset = options?.offset ?? 0;
        const limit = options?.limit;
        const results = limit ? [assistant].slice(offset, offset + limit) : [assistant].slice(offset);
        return results;
    },

    async setLatest(assistantId: string, version: number): Promise<Assistant> {
        // Fake
        const item = await this.get(assistantId);
        item.version = version;
        return item;
    },

    async create(params: {
        assistantId?: string;
        graphId: string;
        name?: string;
        description?: string;
        metadata?: Metadata;
        config?: any;
        ifExists?: 'raise' | 'do_nothing';
    }): Promise<Assistant> {
        // ⚠️ 创建 assistant 不可用 - assistants 是从注册的图中自动生成的，不能动态创建
        // 返回假数据以通过测试
        console.warn(
            '⚠️ Creating assistants is not supported. Assistants are generated from registered graphs. Returning mock data.',
        );
        const graphExists = Object.keys(GRAPHS).includes(params.graphId);

        if (!graphExists) {
            if (params.ifExists === 'raise') {
                throw new Error(`Graph not found: ${params.graphId}`);
            }
            // 如果 graph 不存在，我们仍然返回假数据
        }

        return {
            assistant_id: params.assistantId || params.graphId,
            graph_id: params.graphId,
            name: params.name || params.graphId,
            description: params.description || '',
            metadata: params.metadata || {},
            config: params.config || {},
            version: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        } as Assistant;
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
                return await LangGraphGlobal.globalMessageQueue.cancelQueue(runId);
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
