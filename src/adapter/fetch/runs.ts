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

                for await (const { event, data } of client.runs.stream(
                    thread_id,
                    payload.assistant_id,
                    camelcaseKeys(payload) as any,
                )) {
                    await writer.writeSSE({ data: serialiseAsDict(data) ?? '', event });
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

                if (cancel_on_disconnect) {
                    const cleanup = () => {
                        controller.abort('Client disconnected');
                    };

                    // 监听请求的 abort 信号
                    req.signal?.addEventListener('abort', cleanup);
                }

                try {
                    for await (const { event, data, id } of client.runs.joinStream(thread_id, run_id, {
                        signal: controller.signal,
                        cancelOnDisconnect: cancel_on_disconnect,
                        lastEventId: last_event_id,
                        streamMode: stream_mode ? [stream_mode] : undefined,
                    })) {
                        await writer.writeSSE({
                            data: serialiseAsDict(data) ?? '',
                            event: event as unknown as string,
                            id,
                        });
                    }
                } catch (error) {
                    if (!(error instanceof Error) || !error.message.includes('user cancel')) {
                        console.error('Join stream error:', error);
                        await writer.writeSSE({
                            event: 'error',
                            data: JSON.stringify({
                                error: error instanceof Error ? error.message : 'Unknown error',
                            }),
                        });
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
