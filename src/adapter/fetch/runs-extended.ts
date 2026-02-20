import { client } from './endpoint';
import { ThreadIdParamSchema, RunIdParamSchema, RunCreateSchema, RunWaitQuerySchema, RunJoinQuerySchema } from '../zod';
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
import { getGraph } from '../../utils/getGraph';
import { streamState } from '../../graph/stream';
import { LangGraphGlobal } from '../../global';

/**
 * POST /threads/:thread_id/runs
 */
export async function createRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json();
        const payload = validate(RunCreateSchema, body);

        const camelPayload = camelcaseKeys(payload) as any;
        camelPayload.config = camelPayload.config || {};
        camelPayload.config.configurable = camelPayload.config.configurable || {};

        const langgraphContext = context?.langgraph_context;
        if (langgraphContext) {
            Object.assign(camelPayload.config.configurable, langgraphContext);
        }

        // 确保 graph_id 在 configurable 中
        camelPayload.config.configurable.graph_id = payload.assistant_id;
        camelPayload.config.configurable.thread_id = thread_id;

        // 创建 Run 对象
        const threads = client.threads;
        const run = await threads.createRun(thread_id, payload.assistant_id, camelPayload);

        // 异步执行图的流处理（不等待）
        // streamState 内部已处理队列清理，这里添加兜底清理防止异常情况
        (async () => {
            let queueCleared = false;
            try {
                for await (const _ of streamState(threads, run, camelPayload, {
                    attempt: 0,
                    getGraph,
                })) {
                    // 消费流但不做任何事
                }
            } catch (error) {
                console.error('Background run error:', error);
            } finally {
                // 兜底清理队列，防止 streamState 的 finally 未执行时内存泄漏
                if (!queueCleared) {
                    queueCleared = true;
                    try {
                        await LangGraphGlobal.globalMessageQueue.removeQueue(run.run_id);
                    } catch (e) {
                        // 忽略清理错误
                    }
                }
            }
        })();

        return jsonResponse(run, 200, {
            'Content-Location': `/threads/${thread_id}/runs/${run.run_id}`,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/:thread_id/runs/wait
 */
export async function waitRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/wait');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json();
        const payload = validate(RunCreateSchema, body);

        const queryParams = parseQueryParams(req.url);
        const { cancel_on_disconnect } = validate(RunWaitQuerySchema, queryParams);

        const camelPayload = camelcaseKeys(payload) as any;
        camelPayload.config = camelPayload.config || {};
        camelPayload.config.configurable = camelPayload.config.configurable || {};

        const langgraphContext = context?.langgraph_context;
        if (langgraphContext) {
            Object.assign(camelPayload.config.configurable, langgraphContext);
        }

        // 确保 graph_id 在 configurable 中
        camelPayload.config.configurable.graph_id = payload.assistant_id;
        camelPayload.config.configurable.thread_id = thread_id;

        // 创建 Run 对象并执行流处理，等待完成
        const threads = client.threads;
        const run = await threads.createRun(thread_id, payload.assistant_id, camelPayload);

        // 执行流处理并等待完成，收集最终的 state values
        const stateValues: any = {};
        for await (const { event, data } of streamState(threads, run, camelPayload, {
            attempt: 0,
            getGraph,
        })) {
            // 收集最终的 state values
            if (event === 'end' || event === 'writes/value') {
                if (data && typeof data === 'object') {
                    Object.assign(stateValues, data);
                }
            }
        }

        return jsonResponse(stateValues, 200, {
            'Content-Location': `/threads/${thread_id}/runs/${run.run_id}`,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/runs/:run_id
 */
export async function getRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/:run_id');
        const { thread_id, run_id } = validate(RunIdParamSchema, params);

        // 列出所有运行，找到指定的运行
        const runs = await client.runs.list(thread_id, { limit: 1000 }); // 使用较大的 limit
        const run = runs.find((r) => r.run_id === run_id);

        if (!run) {
            return errorResponse(new Error('Run not found'), 404);
        }

        return jsonResponse(run);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * DELETE /threads/:thread_id/runs/:run_id
 */
export async function deleteRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/:run_id');
        const { thread_id, run_id } = validate(RunIdParamSchema, params);

        // 通过 ThreadsManager 的 updateRun 方法将运行标记为已删除
        // 注意：实际的删除逻辑需要在 BaseThreadsManager 中实现
        await client.threads.updateRun(run_id, { status: 'deleted' } as any);

        return new Response(null, { status: 204 });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/runs/:run_id/join
 */
export async function joinRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/runs/:run_id/join');
        const { thread_id, run_id } = validate(RunIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const { cancel_on_disconnect } = validate(RunJoinQuerySchema, queryParams);

        // 获取运行信息
        const runs = await client.runs.list(thread_id, { limit: 1000 });
        const run = runs.find((r) => r.run_id === run_id);

        if (!run) {
            return errorResponse(new Error('Run not found'), 404);
        }

        // 如果运行已完成，返回空
        if (run.status === 'success' || run.status === 'error') {
            return jsonResponse({});
        }

        // 使用 joinStream 等待运行完成
        const controller = new AbortController();

        if (cancel_on_disconnect) {
            const cleanup = () => {
                controller.abort('Client disconnected');
            };
            req.signal?.addEventListener('abort', cleanup);
        }

        // 等待运行完成
        const stateValues: any = {};
        for await (const { event, data } of client.runs.joinStream(thread_id, run_id, {
            signal: controller.signal,
            cancelOnDisconnect: cancel_on_disconnect,
        })) {
            if (event.event === 'end' || event.event === 'writes/value') {
                if (data && typeof data === 'object') {
                    Object.assign(stateValues, data);
                }
            }
        }

        return jsonResponse(stateValues);
    } catch (error) {
        return errorResponse(error);
    }
}
