import { client } from './endpoint';
import {
    ThreadIdParamSchema,
    RunIdParamSchema,
    RunStreamPayloadSchema,
    RunListQuerySchema,
    RunCancelQuerySchema,
    RunJoinStreamQuerySchema,
} from '../zod';
import { serialiseAsDict } from '../../graph/stream';
import camelcaseKeys from 'camelcase-keys';
import {
    parsePathParams,
    parseQueryParams,
    validate,
    jsonResponse,
    errorResponse,
    createSSEStream,
    withHeartbeat,
} from './utils';
import { LangGraphServerContext } from './context';

/**
 * POST /threads/:thread_id/runs/stream
 */
export async function streamRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/stream');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json();
        const payload = validate(RunStreamPayloadSchema, body);

        return createSSEStream(
            withHeartbeat(async (writer) => {
                payload.config = payload.config || {};
                payload.config.configurable = payload.config.configurable || {};

                const langgraphContext = context?.langgraph_context;
                if (langgraphContext) {
                    Object.assign(payload.config.configurable, langgraphContext);
                }

                let generator: AsyncGenerator<{ event: string; data: any }> | null = null;
                let isCleaningUp = false;

                // 监听中止信号
                const abortHandler = () => {
                    isCleaningUp = true;
                    // 生成器会在下一次迭代时检查 isCleaningUp 并退出
                };
                writer.signal.addEventListener('abort', abortHandler);

                try {
                    generator = client.runs.stream(thread_id, payload.assistant_id, camelcaseKeys(payload) as any);

                    for await (const { event, data } of generator) {
                        // 检查是否需要中断
                        if (isCleaningUp || writer.signal.aborted) {
                            break;
                        }
                        await writer.writeSSE({ data: serialiseAsDict(data) ?? '', event });
                    }
                } catch (error) {
                    // 忽略因中止导致的错误
                    if (!writer.signal.aborted && !isCleaningUp) {
                        throw error;
                    }
                } finally {
                    writer.signal.removeEventListener('abort', abortHandler);

                    // 显式清理生成器
                    if (generator) {
                        try {
                            await generator.return(undefined);
                        } catch (e) {
                            // 忽略生成器清理错误
                        }
                        generator = null;
                    }
                }
            }),
        );
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/runs/:run_id/stream
 */
export async function joinRunStream(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/:run_id/stream');
        const { thread_id, run_id } = validate(RunIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const { cancel_on_disconnect, last_event_id, stream_mode } = validate(RunJoinStreamQuerySchema, queryParams);

        return createSSEStream(
            withHeartbeat(async (writer) => {
                const controller = new AbortController();
                let generator: AsyncGenerator<{ id?: string; event: any; data: any }> | null = null;
                let isCleaningUp = false;
                const abortHandlers: Array<{ signal: AbortSignal; handler: () => void }> = [];

                const cleanup = () => {
                    controller.abort('Client disconnected');
                };

                // 监听请求的 abort 信号
                if (req.signal) {
                    req.signal.addEventListener('abort', cleanup);
                    abortHandlers.push({ signal: req.signal, handler: cleanup });
                }

                // 监听 SSE writer 的 abort 信号
                const writerAbortHandler = () => {
                    isCleaningUp = true;
                    controller.abort('SSE stream closed');
                };
                writer.signal.addEventListener('abort', writerAbortHandler);
                abortHandlers.push({ signal: writer.signal, handler: writerAbortHandler });

                try {
                    generator = client.runs.joinStream(thread_id, run_id, {
                        signal: controller.signal,
                        cancelOnDisconnect: cancel_on_disconnect,
                        lastEventId: last_event_id,
                        streamMode: stream_mode ? [stream_mode] : undefined,
                    });

                    for await (const { event, data, id } of generator) {
                        // 检查是否需要中断
                        if (isCleaningUp || writer.signal.aborted || controller.signal.aborted) {
                            break;
                        }
                        await writer.writeSSE({
                            data: serialiseAsDict(data) ?? '',
                            event: event as unknown as string,
                            id,
                        });
                    }
                } catch (error) {
                    // 忽略因中止导致的错误
                    const isAbortError = controller.signal.aborted || writer.signal.aborted;
                    if (!isAbortError && !(error instanceof Error && error.message.includes('user cancel'))) {
                        console.error('Join stream error:', error);
                        await writer.writeSSE({
                            event: 'error',
                            data: JSON.stringify({
                                error: error instanceof Error ? error.message : 'Unknown error',
                            }),
                        });
                    }
                } finally {
                    // 移除所有 abort 事件监听器
                    for (const { signal, handler } of abortHandlers) {
                        try {
                            signal.removeEventListener('abort', handler);
                        } catch (e) {
                            // 忽略错误
                        }
                    }

                    // 显式清理生成器
                    if (generator) {
                        try {
                            await generator.return(undefined);
                        } catch (e) {
                            // 忽略生成器清理错误
                        }
                        generator = null;
                    }
                }
            }),
        );
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/runs
 */
export async function listRuns(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const { limit, offset, status } = validate(RunListQuerySchema, queryParams);

        const runs = await client.runs.list(thread_id, { limit, offset, status });

        return jsonResponse(runs);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/:thread_id/runs/:run_id/cancel
 */
export async function cancelRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/:run_id/cancel');
        const { thread_id, run_id } = validate(RunIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const { wait, action } = validate(RunCancelQuerySchema, queryParams);

        const cancel = client.runs.cancel(thread_id, run_id, wait, action);

        if (wait) {
            await cancel;
        }

        return new Response(null, { status: wait ? 204 : 202 });
    } catch (error) {
        return errorResponse(error);
    }
}
