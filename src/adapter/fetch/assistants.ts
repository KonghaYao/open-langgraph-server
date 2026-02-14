import { client } from './endpoint';
import {
    AssistantsSearchSchema,
    AssistantGraphQuerySchema,
    AssistantCountSchema,
    AssistantPatchSchema,
    AssistantCreateSchema,
} from '../zod';
import camelcaseKeys from 'camelcase-keys';
import { parseQueryParams, validate, jsonResponse, errorResponse, parsePathParams } from './utils';
import { LangGraphServerContext } from './context';

/**
 * POST /assistants/search
 */
export async function searchAssistants(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(AssistantsSearchSchema, body);

        const data = await client.assistants.search(camelcaseKeys(payload));

        return jsonResponse(data, 200, {
            'X-Pagination-Total': '0',
        });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /assistants/count
 */
export async function countAssistants(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(AssistantCountSchema, body);

        const data = await client.assistants.count(camelcaseKeys(payload));

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /assistants/:assistant_id
 */
export async function getAssistant(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id

        const data = await client.assistants.get(assistant_id);

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * DELETE /assistants/:assistant_id
 */
export async function deleteAssistant(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id

        await client.assistants.delete(assistant_id);

        return jsonResponse({});
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * PATCH /assistants/:assistant_id
 */
export async function patchAssistant(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id

        const body = await req.json();
        const payload = validate(AssistantPatchSchema, body);

        const data = await client.assistants.update(assistant_id, camelcaseKeys(payload));

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /assistants/:assistant_id/graph
 */
export async function getAssistantGraph(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id/graph

        const queryParams = parseQueryParams(req.url);
        const { xray } = validate(AssistantGraphQuerySchema, queryParams);

        const data = await client.assistants.getGraph(assistant_id, {
            xray: xray !== undefined ? xray === 'true' : undefined,
        });

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * GET /assistants/:assistant_id/subgraphs
 * ⚠️ 此端点尚未实现
 */
export async function getAssistantSubgraphs(req: Request, context: LangGraphServerContext): Promise<Response> {
    return errorResponse(
        {
            error: 'Not Implemented',
            details: ['Subgraphs endpoint is not yet supported.'],
        },
        501,
    );
}

/**
 * GET /assistants/:assistant_id/subgraphs/:namespace
 * ⚠️ 此端点尚未实现
 */
export async function getAssistantSubgraphsByNamespace(
    req: Request,
    context: LangGraphServerContext,
): Promise<Response> {
    return errorResponse(
        {
            error: 'Not Implemented',
            details: ['Subgraphs by namespace endpoint is not yet supported.'],
        },
        501,
    );
}

/**
 * GET /assistants/:assistant_id/schemas
 */
export async function getAssistantSchemas(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id/schemas

        const data = await client.assistants.getSchemas(assistant_id);

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /assistants/:assistant_id/versions
 */
export async function getAssistantVersions(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id/versions

        const body = await req.json();
        const payload = validate(AssistantPatchSchema, body); // Reuse pagination schema

        const data = await client.assistants.getVersions(assistant_id, camelcaseKeys(payload));

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /assistants/:assistant_id/latest
 */
export async function setLatestAssistantVersion(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split('/').filter((p) => p);
        const assistant_id = pathParts[1]; // assistants/:assistant_id/latest

        const queryParams = parseQueryParams(req.url);
        const version = queryParams.version ? parseInt(queryParams.version as string) : 1;

        const data = await client.assistants.setLatest(assistant_id, version);

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /assistants
 */
export async function createAssistant(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(AssistantCreateSchema, body);

        const data = await client.assistants.create(camelcaseKeys(payload));

        return jsonResponse(data);
    } catch (error) {
        return errorResponse(error);
    }
}
