/**
 * Remote PostgreSQL Server
 * 提供 HTTP API 端点，代理 PostgreSQL 操作
 */

import { Hono } from 'hono';
import { BaseThreadsManager } from '../../threads';
import {
    RemoteResponse,
    RemoteApiError,
    RemoteErrorCode,
    SetupResponse,
    CreateThreadRequest,
    SearchThreadsRequest,
    UpdateThreadRequest,
    UpdateStateRequest,
    UpdateStateResponse,
    CreateRunRequest,
    ListRunsRequest,
    UpdateRunRequest,
} from './types';

/**
 * Remote Server 类
 */
export class RemoteServer {
    constructor(private threadsManager: BaseThreadsManager) {}

    /**
     * 创建 Hono 路由
     */
    getRouter(): Hono {
        const app = new Hono();

        // Setup API
        app.post('/setup', async (c) => {
            await this.threadsManager.setup();
            const response: RemoteResponse<SetupResponse> = {
                success: true,
                data: { message: 'Database initialized successfully' },
            };
            return c.json(response, 200);
        });

        // Thread: Create
        app.post('/threads', async (c) => {
            const body: CreateThreadRequest = await c.req.json();
            const thread = await this.threadsManager.create(body);
            const response: RemoteResponse = {
                success: true,
                data: thread,
            };
            return c.json(response, 201);
        });

        // Thread: Search
        app.get('/threads', async (c) => {
            const query: SearchThreadsRequest = {
                ids: c.req.query('ids') ? JSON.parse(c.req.query('ids')!) : undefined,
                metadata: c.req.query('metadata') ? JSON.parse(c.req.query('metadata')!) : undefined,
                limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
                offset: c.req.query('offset') ? parseInt(c.req.query('offset')!) : undefined,
                status: c.req.query('status') as any,
                sortBy: c.req.query('sortBy') as any,
                sortOrder: c.req.query('sortOrder') as any,
                values: c.req.query('values') ? JSON.parse(c.req.query('values')!) : undefined,
                select: c.req.query('select') ? JSON.parse(c.req.query('select')!) : undefined,
                withoutDetails: c.req.query('withoutDetails') === 'true',
            };
            const threads = await this.threadsManager.search(query);
            const response: RemoteResponse = {
                success: true,
                data: threads,
            };
            return c.json(response, 200);
        });

        // Thread: Get
        app.get('/threads/:threadId', async (c) => {
            const threadId = c.req.param('threadId')!;
            const thread = await this.threadsManager.get(threadId);
            const response: RemoteResponse = {
                success: true,
                data: thread,
            };
            return c.json(response, 200);
        });

        // Thread: Update
        app.put('/threads/:threadId', async (c) => {
            const threadId = c.req.param('threadId')!;
            const body: UpdateThreadRequest = await c.req.json();
            await this.threadsManager.set(threadId, body);
            const response: RemoteResponse = {
                success: true,
            };
            return c.json(response, 200);
        });

        // Thread: Delete
        app.delete('/threads/:threadId', async (c) => {
            const threadId = c.req.param('threadId')!;
            await this.threadsManager.delete(threadId);
            const response: RemoteResponse = {
                success: true,
            };
            return c.json(response, 200);
        });

        // Thread: Update State
        app.post('/threads/:threadId/state', async (c) => {
            const threadId = c.req.param('threadId')!;
            const body: UpdateStateRequest = await c.req.json();
            const result = await this.threadsManager.updateState(threadId, body);
            const response: RemoteResponse<UpdateStateResponse> = {
                success: true,
                data: result as any,
            };
            return c.json(response, 200);
        });

        // Run: Create
        app.post('/threads/:threadId/runs', async (c) => {
            const threadId = c.req.param('threadId')!;
            const assistantId = c.req.query('assistantId')!;
            const body: CreateRunRequest = await c.req.json();
            const run = await this.threadsManager.createRun(threadId, assistantId, body);
            const response: RemoteResponse = {
                success: true,
                data: run,
            };
            return c.json(response, 201);
        });

        // Run: List
        app.get('/threads/:threadId/runs', async (c) => {
            const threadId = c.req.param('threadId')!;
            const query: ListRunsRequest = {
                limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
                offset: c.req.query('offset') ? parseInt(c.req.query('offset')!) : undefined,
                status: c.req.query('status') as any,
            };
            const runs = await this.threadsManager.listRuns(threadId, query);
            const response: RemoteResponse = {
                success: true,
                data: runs,
            };
            return c.json(response, 200);
        });

        // Run: Update
        app.put('/runs/:runId', async (c) => {
            const runId = c.req.param('runId')!;
            const body: UpdateRunRequest = await c.req.json();
            await this.threadsManager.updateRun(runId, body);
            const response: RemoteResponse = {
                success: true,
            };
            return c.json(response, 200);
        });

        return app;
    }
}
