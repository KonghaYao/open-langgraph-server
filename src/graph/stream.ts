import { AIMessageChunk } from '@langchain/core/messages';
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Pregel } from '@langchain/langgraph/pregel';
import { getLangGraphCommand } from '../utils/getLangGraphCommand.js';
import type { BaseStreamQueueInterface } from '../queue/stream_queue.js';
import { concat } from '@langchain/core/utils/stream';
import { LangGraphGlobal } from '../global.js';
import { Run } from '@langgraph-js/sdk';
import { EventMessage, StreamErrorEventMessage, StreamEndEventMessage } from '../queue/event_message.js';

import { BaseThreadsManager } from '../threads/index.js';
import { StreamInputData } from '../types.js';

export type LangGraphStreamMode = Pregel<any, any>['streamMode'][number];

export async function streamStateWithQueue(
    threads: BaseThreadsManager,
    run: Run,
    queue: BaseStreamQueueInterface,
    payload: StreamInputData,
    options: {
        attempt: number;
        getGraph: (
            graphId: string,
            config: LangGraphRunnableConfig | undefined,
            options?: { checkpointer?: BaseCheckpointSaver | null },
        ) => Promise<Pregel<any, any, any, any, any>>;
        compressMessages?: boolean;
    },
): Promise<void> {
    const kwargs = payload;
    const graphId = kwargs.config?.configurable?.graph_id;

    if (!graphId || typeof graphId !== 'string') {
        throw new Error('Invalid or missing graph_id');
    }

    const graph = await options.getGraph(graphId, payload.config, {
        checkpointer: payload.temporary ? null : undefined,
    });

    const userStreamMode = Array.isArray(payload.streamMode)
        ? payload.streamMode
        : payload.streamMode
        ? [payload.streamMode]
        : [];

    const libStreamMode: Set<LangGraphStreamMode> = new Set([
        'values',
        ...userStreamMode.filter((mode) => mode !== 'events' && mode !== 'messages-tuple'),
    ]);

    if (userStreamMode.includes('messages-tuple')) {
        libStreamMode.add('messages');
    }

    if (userStreamMode.includes('messages')) {
        libStreamMode.add('values');
    }

    await queue.push(
        new EventMessage('metadata', {
            run_id: run.run_id,
            attempt: options.attempt,
            graph_id: graphId,
        }),
    );

    const metadata = {
        ...payload.config?.metadata,
        run_attempt: options.attempt,
    };

    // 在 try 块之前声明变量，确保 finally 块可以访问
    let sendedMetadataMessage: Set<string> | null = null;
    let messageChunks: Map<string, AIMessageChunk[]> | null = null;
    let eventsIterator: AsyncIterable<any> | null = null;

    try {
        sendedMetadataMessage = new Set();
        messageChunks = new Map<string, AIMessageChunk[]>();
        eventsIterator = await graph.stream(
            payload.command != null ? getLangGraphCommand(payload.command) : payload.input ?? null,
            {
                interruptAfter: payload.interruptAfter,
                interruptBefore: payload.interruptBefore,

                tags: payload.config?.tags,
                configurable: payload.config?.configurable,
                recursionLimit: payload.config?.recursionLimit,
                subgraphs: payload.streamSubgraphs,
                metadata,

                runId: run.run_id,
                streamMode: [...libStreamMode],
                signal: queue.cancelSignal.signal,
            },
        );

        for await (const event of eventsIterator) {
            let ns: string[] = [];
            /** @ts-ignore subgraph 类型可以为 [ns,name,value] */
            if (event.length === 3) {
                ns = event.splice(0, 1);
            }

            const getNameWithNs = (name: string) => {
                if (ns.length === 0) return name;
                if (ns.length === 1 && ns[0]?.length === 0) return name;
                return `${name}|${ns.join('|')}`;
            };
            if (event[0] === 'values') {
                const value = event[1];
                if (getNameWithNs('values') === 'values') {
                    // 只有最外层的 values 才触发存储
                    await queue.push(new EventMessage(getNameWithNs('values'), value));
                    if (value?.__interrupt__) {
                        await threads.set(run.thread_id, {
                            status: 'interrupted',
                            interrupts: value ? JSON.parse(serialiseAsDict(value)) : '',
                        });
                    } else {
                        await threads.set(run.thread_id, {
                            values: value ? JSON.parse(serialiseAsDict(value)) : '',
                        });
                    }
                }
            } else if (event[0] === 'messages') {
                const message = event[1][0];
                const metadata = event[1][1];
                // 只在第一次发送 metadata
                if (message.id && !sendedMetadataMessage!.has(message.id)) {
                    await queue.push(
                        new EventMessage('messages/metadata', {
                            [message.id]: metadata,
                        }),
                    );
                    sendedMetadataMessage!.add(message.id);
                }
                if (AIMessageChunk.isInstance(message) && message.id) {
                    messageChunks!.set(message.id, [
                        ...(messageChunks!.get(message.id) ?? []),
                        message as AIMessageChunk,
                    ]);

                    await queue.push(
                        new EventMessage('messages/partial', [messageChunks!.get(message.id)!.reduce(concat)]),
                    );
                    // unsure 没有办法判断结束情况, 故进行一个变体操作
                    if (message.content === '' && !message.tool_calls?.length) {
                        messageChunks.delete(message.id);
                    }
                } else {
                    // ToolMessage 会到这里
                    await queue.push(new EventMessage('messages/partial', [message]));
                }
            } else if (event[0] === 'updates') {
                const updates = event[1];
                await queue.push(new EventMessage(getNameWithNs('updates'), updates));
            }
        }
    } catch (error) {
        // 如果是取消错误，不记录
        if (!(error instanceof Error && error.message?.includes('cancel'))) {
            console.error('streamStateWithQueue error:', error);
            // 推送错误信号，通知消费者
            try {
                await queue.push(new StreamErrorEventMessage(error as Error));
            } catch (e) {
                // 忽略推送错误
            }
        }
        throw error;
    } finally {
        // 发送流结束信号
        try {
            await queue.push(new StreamEndEventMessage());
        } catch (e) {
            // 忽略推送错误
        }

        // 清理内存：清空 Set 和 Map
        if (sendedMetadataMessage) {
            sendedMetadataMessage.clear();
            sendedMetadataMessage = null;
        }
        if (messageChunks) {
            messageChunks.clear();
            messageChunks = null;
        }

        // 清理迭代器引用
        eventsIterator = null;
    }
}

/**
 * 从队列创建数据流生成器
 * @param queueId 队列 ID
 * @param signal 中止信号
 * @returns 数据流生成器
 */
export async function* createStreamFromQueue(queueId: string): AsyncGenerator<{ event: string; data: unknown }> {
    const queue = await LangGraphGlobal.globalMessageQueue.getQueue(queueId);
    return queue.onDataReceive();
}

export const serialiseAsDict = (obj: unknown, indent = 0) => {
    return JSON.stringify(
        obj,
        function (key: string | number, value: unknown) {
            const rawValue = this[key];
            if (
                rawValue != null &&
                typeof rawValue === 'object' &&
                'toDict' in rawValue &&
                typeof rawValue.toDict === 'function'
            ) {
                // TODO: we need to upstream this to LangChainJS
                const { type, data } = rawValue.toDict();
                return { ...data, type };
            }

            return value;
        },
        indent,
    );
};
/**
 * 兼容性函数：保持原有 API，同时使用队列模式
 * @param run 运行配置
 * @param options 选项
 * @returns 数据流生成器
 */
export async function* streamState(
    threads: BaseThreadsManager,
    run: Run | Promise<Run>,
    payload: StreamInputData,
    options: {
        attempt: number;
        getGraph: (
            graphId: string,
            config: LangGraphRunnableConfig | undefined,
            options?: { checkpointer?: BaseCheckpointSaver | null },
        ) => Promise<Pregel<any, any, any, any, any>>;
        compressMessages?: boolean;
    },
) {
    run = await run;
    // 生成唯一的队列 ID
    const queueId = run.run_id;
    const threadId = run.thread_id;
    let state: AsyncGenerator<EventMessage, void, unknown> | null = null;
    let queue: BaseStreamQueueInterface | null = null;
    let backgroundTask: Promise<void> | null = null;
    let isCleaningUp = false;

    try {
        // 启动队列推送任务（在后台异步执行）
        await threads.set(threadId, { status: 'busy' });
        await threads.updateRun(run.run_id, { status: 'running' });
        queue = LangGraphGlobal.globalMessageQueue.createQueue(queueId);
        state = queue.onDataReceive();

        // 追踪后台任务
        backgroundTask = streamStateWithQueue(threads, run, queue, payload, options).catch((error) => {
            // 如果是因为清理导致的取消，不记录错误
            if (isCleaningUp) return;
            if (error.message !== 'user cancel this run') console.error('Queue task error:', error);
            // 如果生产者出错，向队列推送错误信号
            LangGraphGlobal.globalMessageQueue.pushToQueue(queueId, new StreamErrorEventMessage(error));
        });

        for await (const data of state) {
            yield data;
        }
        await threads.updateRun(run.run_id, { status: 'success' });
    } catch (error) {
        // 如果发生错误，确保清理资源
        console.error('Stream error:', error);
        await threads.updateRun(run.run_id, { status: 'error' });
        await threads.set(threadId, { status: 'error' });
        // throw error;
    } finally {
        isCleaningUp = true;

        // 确保清理生成器
        if (state) {
            try {
                await state.return(undefined);
            } catch (e) {
                // 忽略生成器清理错误
            }
            state = null;
        }

        // 取消后台任务：先取消队列的信号，让后台任务能检测到
        if (queue && !queue.cancelSignal.signal.aborted) {
            try {
                queue.cancelSignal.abort('Stream consumer disconnected');
            } catch (e) {
                // 忽略取消错误
            }
        }

        // 等待后台任务完成（带超时）
        if (backgroundTask) {
            try {
                await Promise.race([backgroundTask, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
            } catch (e) {
                // 忽略后台任务错误
            }
            backgroundTask = null;
        }

        const nowState = await threads.get(threadId);
        // 在完成后清理队列
        if (nowState.status === 'interrupted') {
            // 注意，interrupted 状态，直接拷贝一个需要恢复状态的队列即可, 拷贝到 threadId 的队列, 避免被删除
            await LangGraphGlobal.globalMessageQueue.copyQueue(queueId, threadId, 30000);
        } else {
            await threads.set(threadId, { status: 'idle', interrupts: {} });
        }
        // 清空队列数据并释放资源
        await LangGraphGlobal.globalMessageQueue.removeQueue(queueId);
        queue = null;
    }
}
