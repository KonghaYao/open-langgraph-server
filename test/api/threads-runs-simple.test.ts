/**
 * Threads Runs API 简化测试
 *
 * 直接测试 handleRequest 函数，确保不使用需要网络的存储
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { registerGraph } from '../../src/createEndpoint';
import { handleRequest } from '../../src/adapter/fetch/index';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage } from 'langchain';

describe('Threads Runs API 简化测试', () => {
    /**
     * 创建一个简单的测试图
     */
    const createSimpleGraph = async () => {
        const { StateGraph, START } = await import('@langchain/langgraph');

        const State = MessagesAnnotation;

        const simpleNode = (state: typeof State.State) => {
            return {
                messages: [...state.messages, new AIMessage("hello, I'm done")],
            };
        };

        return new StateGraph(State).addNode('simple', simpleNode).addEdge(START, 'simple').compile();
    };

    beforeAll(async () => {
        // 注册测试图
        const simpleGraph = await createSimpleGraph();
        registerGraph('test-simple-runs-simple', simpleGraph);

        // 确保使用内存存储
        delete process.env.DATABASE_URL;
        delete process.env.SQLITE_DATABASE_URI;
        delete process.env.REDIS_URL;
    });

    describe('POST /threads/{thread_id}/runs - Create Background Run', () => {
        it('should create a background run and return immediately', async () => {
            // 先创建一个 thread
            const createThreadReq = new Request('http://localhost/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const threadRes = await handleRequest(createThreadReq);

            expect(threadRes.status).toBe(200);
            const threadText = await threadRes.text();
            const threadData = JSON.parse(threadText);
            expect(threadData).toHaveProperty('thread_id');

            // 创建后台运行
            const createRunReq = new Request(`http://localhost/threads/${threadData.thread_id}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assistant_id: 'test-simple-runs-simple',
                    input: { messages: [{ role: 'user', content: 'Hello' }] },
                }),
            });
            const runRes = await handleRequest(createRunReq);

            // 检查响应
            expect(runRes.status).toBe(200);
            const runText = await runRes.text();
            const runData = JSON.parse(runText);
            expect(runData).toHaveProperty('run_id');
            expect(runData).toHaveProperty('thread_id', threadData.thread_id);
            expect(runData).toHaveProperty('assistant_id', 'test-simple-runs-simple');
        });
    });

    describe('GET /threads/{thread_id}/runs - List Runs', () => {
        it('should list runs for a thread', async () => {
            // 先创建一个 thread
            const createThreadReq = new Request('http://localhost/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const threadRes = await handleRequest(createThreadReq);
            const threadText = await threadRes.text();
            const threadData = JSON.parse(threadText);

            // 创建几个运行
            await handleRequest(new Request(`http://localhost/threads/${threadData.thread_id}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assistant_id: 'test-simple-runs-simple',
                    input: { messages: [{ role: 'user', content: 'Hello 1' }] },
                }),
            }));
            await handleRequest(new Request(`http://localhost/threads/${threadData.thread_id}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assistant_id: 'test-simple-runs-simple',
                    input: { messages: [{ role: 'user', content: 'Hello 2' }] },
                }),
            }));

            // 列出运行
            const listRunsReq = new Request(`http://localhost/threads/${threadData.thread_id}/runs`, {
                method: 'GET',
            });
            const listRes = await handleRequest(listRunsReq);

            expect(listRes.status).toBe(200);
            const listText = await listRes.text();
            const runsData = JSON.parse(listText);
            expect(Array.isArray(runsData)).toBe(true);
            expect(runsData.length).toBeGreaterThanOrEqual(2);
        });
    });
});
