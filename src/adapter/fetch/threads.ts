import { client } from './endpoint';
import { ThreadIdParamSchema, ThreadCreatePayloadSchema, ThreadSearchPayloadSchema, ThreadPatchSchema, MetadataSchema } from '../zod';
import camelcaseKeys from 'camelcase-keys';
import { parsePathParams, validate, jsonResponse, errorResponse, parseQueryParams } from './utils';
import { LangGraphServerContext } from './context';

/**
 * POST /threads
 */
export async function createThread(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(ThreadCreatePayloadSchema, body);

        const thread = await client.threads.create(camelcaseKeys(payload));

        return jsonResponse(thread);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/search
 */
export async function searchThreads(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(ThreadSearchPayloadSchema, body);

        const result = await client.threads.search(camelcaseKeys(payload));

        return jsonResponse(result, 200, {
            'X-Pagination-Total': result.length.toString(),
        });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/count
 */
export async function countThreads(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(ThreadSearchPayloadSchema.partial(), body);

        const count = await client.threads.count(camelcaseKeys(payload as any));

        return jsonResponse(count);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id
 */
export async function getThread(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const thread = await client.threads.get(thread_id);

        return jsonResponse(thread);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * PATCH /threads/:thread_id
 */
export async function patchThread(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json();
        const payload = validate(ThreadPatchSchema, body);

        const thread = await client.threads.patch(thread_id, camelcaseKeys(payload));

        return jsonResponse(thread);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * DELETE /threads/:thread_id
 */
export async function deleteThread(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        await client.threads.delete(thread_id);

        return new Response(null, { status: 204 });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/state
 */
export async function getThreadState(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/state');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const options = {
            subgraphs: queryParams.subgraphs === 'true' || queryParams.subgraphs === true,
        };

        const state = await client.threads.getState(thread_id, options);

        return jsonResponse(state);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/:thread_id/state
 */
export async function updateThreadState(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/state');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json() as { values?: unknown };

        const result = await client.threads.updateState(thread_id, camelcaseKeys(body));

        return jsonResponse(result);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/:thread_id/state/checkpoint
 */
export async function getThreadStateAtCheckpoint(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/state/checkpoint');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json() as { checkpoint_id?: string };
        const queryParams = parseQueryParams(req.url);
        const options = {
            subgraphs: queryParams.subgraphs === 'true' || queryParams.subgraphs === true,
            ...body,
        };

        const state = await client.threads.getState(thread_id, options);

        return jsonResponse(state);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/history
 */
export async function getThreadHistory(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/history');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const options = {
            limit: queryParams.limit ? parseInt(queryParams.limit as string, 10) : undefined,
            before: queryParams.before as string | undefined,
        };

        const history = await client.threads.getStateHistory(thread_id, options);

        return jsonResponse(history);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/:thread_id/history
 */
export async function getThreadHistoryPost(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/history');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const body = await req.json() as { limit?: number; before?: string };
        const options = {
            limit: body.limit,
            before: body.before,
        };

        const history = await client.threads.getStateHistory(thread_id, options);

        return jsonResponse(history);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /threads/:thread_id/copy
 */
export async function copyThread(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/copy');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const copiedThread = await client.threads.copy(thread_id);

        return jsonResponse(copiedThread);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /threads/:thread_id/stream
 */
export async function joinThreadStream(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const params = parsePathParams(req.url, '/threads/:thread_id/stream');
        const { thread_id } = validate(ThreadIdParamSchema, params);

        const queryParams = parseQueryParams(req.url);
        const options = {
            lastEventId: req.headers.get('Last-Event-ID') || queryParams.last_event_id as string | undefined,
            streamModes: queryParams.stream_modes
                ? Array.isArray(queryParams.stream_modes)
                    ? queryParams.stream_modes
                    : [queryParams.stream_modes as string]
                : undefined,
        };

        // For now, return a simple response indicating stream endpoint exists
        // Full SSE implementation would be more complex
        return new Response('data: {"status": "stream_ready"}\n\n', {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });
    } catch (error) {
        return errorResponse(error);
    }
}
