/**
 * @langchain/langgraph-sdk Threads API 测试
 *
 * 测试 Threads 相关的所有 API 端点
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@langchain/langgraph-sdk';
import { registerGraph } from '../../src/createEndpoint';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage } from 'langchain';
import { handleRequest } from '../../src/adapter/fetch/index';

describe('Threads API 测试', () => {
    const prepareClient = () => {
        return new Client({
            apiUrl: '',
            callerOptions: {
                maxRetries: 0,
                fetch(url, init) {
                    return handleRequest(new Request(url, init));
                },
            },
        });
    };

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
        registerGraph('test-simple', simpleGraph);
    });

    afterAll(async () => {});

    describe('POST /threads - Create Thread', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should create a thread without arguments', async () => {
            const thread = await client.threads.create();
            expect(thread).toHaveProperty('thread_id');
            expect(typeof thread.thread_id).toBe('string');
        });

        it('should create a thread with metadata', async () => {
            const thread = await client.threads.create({
                metadata: { key: 'value', userId: '123' },
            });
            expect(thread).toHaveProperty('thread_id');
            expect(thread).toHaveProperty('metadata');
            expect(thread.metadata).toHaveProperty('key', 'value');
            expect(thread.metadata).toHaveProperty('userId', '123');
        });

        it('should create a thread with custom ID', async () => {
            const customId = 'custom-thread-id-12345';
            const thread = await client.threads.create({
                threadId: customId,
            });
            expect(thread.thread_id).toBe(customId);
        });
    });

    describe('POST /threads/search - Search Threads', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should search all threads without filters', async () => {
            // 先创建一个测试线程
            await client.threads.create();

            const threads = await client.threads.search();
            expect(Array.isArray(threads)).toBe(true);
            expect(threads.length).toBeGreaterThan(0);
            expect(threads[0]).toHaveProperty('thread_id');
            expect(threads[0]).toHaveProperty('created_at');
            expect(threads[0]).toHaveProperty('updated_at');
        });

        it('should search threads with limit', async () => {
            // 创建多个线程
            await client.threads.create();
            await client.threads.create();

            const threads = await client.threads.search({
                limit: 1,
            });
            expect(threads.length).toBeLessThanOrEqual(1);
        });

        it('should search threads with offset', async () => {
            const allThreads = await client.threads.search();
            if (allThreads.length > 1) {
                const threads = await client.threads.search({
                    offset: 1,
                });
                expect(threads.length).toBe(allThreads.length - 1);
            }
        });

        it('should search threads with metadata filter', async () => {
            const thread = await client.threads.create({
                metadata: { key: 'test-value' },
            });

            const threads = await client.threads.search({
                metadata: { key: 'test-value' },
            });
            expect(Array.isArray(threads)).toBe(true);
            expect(threads.length).toBeGreaterThan(0);
        });
    });

    describe('POST /threads/count - Count Threads', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should count all threads', async () => {
            // 创建一个线程以确保至少有一个
            await client.threads.create();

            const count = await client.threads.count();
            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThan(0);
        });

        it('should count threads with metadata filter', async () => {
            const thread = await client.threads.create({
                metadata: { key: 'count-test' },
            });

            const count = await client.threads.count({
                metadata: { key: 'count-test' },
            });
            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThan(0);
        });
    });

    describe('GET /threads/{thread_id} - Get Thread', () => {
        let client: ReturnType<typeof prepareClient>;
        let testThreadId: string;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should get thread by ID', async () => {
            const createdThread = await client.threads.create();
            testThreadId = createdThread.thread_id;

            const thread = await client.threads.get(testThreadId);
            expect(thread).toHaveProperty('thread_id', testThreadId);
            expect(thread).toHaveProperty('created_at');
            expect(thread).toHaveProperty('updated_at');
        });

        it('should throw error for non-existent thread', async () => {
            await expect(client.threads.get('non-existent-thread-id')).rejects.toThrow();
        });
    });

    describe('DELETE /threads/{thread_id} - Delete Thread', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should delete a thread', async () => {
            const thread = await client.threads.create();
            await client.threads.delete(thread.thread_id);

            // 验证线程已被删除
            await expect(client.threads.get(thread.thread_id)).rejects.toThrow();
        });

        it('should throw error when deleting non-existent thread', async () => {
            await expect(client.threads.delete('non-existent-thread-id')).rejects.toThrow();
        });
    });

    describe('PATCH /threads/{thread_id} - Patch Thread', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should update thread metadata', async () => {
            const thread = await client.threads.create();
            const updated = await client.threads.update(thread.thread_id, {
                metadata: { newKey: 'newValue' },
            });
            expect(updated).toHaveProperty('thread_id', thread.thread_id);
            expect(updated).toHaveProperty('metadata');
            expect(updated.metadata).toHaveProperty('newKey', 'newValue');
        });

        it('should merge metadata when patching', async () => {
            const thread = await client.threads.create({
                metadata: { key1: 'value1' },
            });
            const updated = await client.threads.update(thread.thread_id, {
                metadata: { key2: 'value2' },
            });
            expect(updated.metadata).toHaveProperty('key1', 'value1');
            expect(updated.metadata).toHaveProperty('key2', 'value2');
        });
    });

    describe('GET /threads/{thread_id}/state - Get Thread State', () => {
        let client: ReturnType<typeof prepareClient>;
        let testThreadId: string;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should get thread state', async () => {
            const thread = await client.threads.create();
            testThreadId = thread.thread_id;

            const state = await client.threads.getState(testThreadId);
            expect(state).toBeDefined();
            expect(state).toHaveProperty('values');
            expect(state).toHaveProperty('next');
            expect(state).toHaveProperty('checkpoint');
            expect(state.checkpoint).toBe(null);
        });

        it('should get thread state with subgraphs', async () => {
            const thread = await client.threads.create();
            testThreadId = thread.thread_id;

            const state = await client.threads.getState(testThreadId, {
                subgraphs: true,
            });
            expect(state).toBeDefined();
            expect(state).toHaveProperty('values');
        });

        it('should throw error for non-existent thread state', async () => {
            await expect(client.threads.getState('non-existent-thread-id')).rejects.toThrow();
        });
    });

    describe('POST /threads/{thread_id}/state - Update Thread State', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should update thread state with values', async () => {
            const thread = await client.threads.create();
            const response = await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });
            expect(response).toBeDefined();
            expect(response).toHaveProperty('configurable');
        });

        it('should update thread state with asNode', async () => {
            const thread = await client.threads.create();
            const response = await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
                asNode: 'test-node',
            });
            expect(response).toBeDefined();
        });
    });

    describe('POST /threads/{thread_id}/state/checkpoint - Get Thread State At Checkpoint', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should get thread state at checkpoint', async () => {
            const thread = await client.threads.create();

            // 首先更新状态以创建一个 checkpoint
            await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });

            // 获取历史以找到 checkpoint_id
            const history = await client.threads.getHistory(thread.thread_id);
            if (history.length > 0) {
                const checkpointId = history[0].checkpoint.checkpoint_id;
                if (checkpointId) {
                    const state = await client.threads.getState(thread.thread_id, {
                        checkpoint_id: checkpointId,
                    });
                    expect(state).toBeDefined();
                    expect(state).toHaveProperty('values');
                }
            }
        });

        it('should get thread state at checkpoint with subgraphs', async () => {
            const thread = await client.threads.create();
            await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });

            const history = await client.threads.getHistory(thread.thread_id);
            if (history.length > 0) {
                const checkpointId = history[0].checkpoint.id;
                if (checkpointId) {
                    const state = await client.threads.getState(
                        thread.thread_id,
                        {
                            checkpoint_id: checkpointId,
                        },
                        {
                            subgraphs: true,
                        },
                    );
                    expect(state).toBeDefined();
                }
            }
        });
    });

    describe('GET /threads/{thread_id}/history - Get Thread History', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should get thread history', async () => {
            const thread = await client.threads.create();

            // 更新状态以创建历史
            await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });

            const history = await client.threads.getHistory(thread.thread_id);
            expect(Array.isArray(history)).toBe(true);

            // 如果历史不为空，验证结构
            if (history.length > 0) {
                expect(history[0]).toHaveProperty('values');
                expect(history[0]).toHaveProperty('checkpoint');
            }
        });

        it('should get thread history with limit', async () => {
            const thread = await client.threads.create();

            // 创建多个状态更新
            for (let i = 0; i < 5; i++) {
                await client.threads.updateState(thread.thread_id, {
                    values: { messages: [] },
                });
            }

            const history = await client.threads.getHistory(thread.thread_id, {
                limit: 3,
            });
            expect(history.length).toBeLessThanOrEqual(3);
        });

        it('should get thread history with before parameter', async () => {
            const thread = await client.threads.create();

            await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });

            const allHistory = await client.threads.getHistory(thread.thread_id);
            if (allHistory.length > 1) {
                const firstCheckpointId = allHistory[0].checkpoint.checkpoint_id;
                if (firstCheckpointId) {
                    const history = await client.threads.getHistory(thread.thread_id, {
                        checkpoint: {
                            checkpoint_id: firstCheckpointId,
                        },
                    });
                    // 应该返回在指定 checkpoint 之前的状态
                    expect(Array.isArray(history)).toBe(true);
                }
            }
        });
    });

    describe('POST /threads/{thread_id}/history - Get Thread History Post', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should get thread history with POST method', async () => {
            const thread = await client.threads.create();

            await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });

            const history = await client.threads.getHistory(thread.thread_id, {
                limit: 10,
            });
            expect(Array.isArray(history)).toBe(true);
        });
    });

    describe('POST /threads/{thread_id}/copy - Copy Thread', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should copy a thread', async () => {
            const thread = await client.threads.create({
                metadata: { original: 'true' },
            });

            // 更新状态
            await client.threads.updateState(thread.thread_id, {
                values: { messages: [] },
            });

            const copiedThread = await client.threads.copy(thread.thread_id);
            expect(copiedThread).toHaveProperty('thread_id');
            expect(copiedThread.thread_id).not.toBe(thread.thread_id);
            expect(copiedThread).toHaveProperty('metadata');
            expect(copiedThread.metadata).toHaveProperty('original', 'true');
        });

        it('should throw error when copying non-existent thread', async () => {
            await expect(client.threads.copy('non-existent-thread-id')).rejects.toThrow();
        });
    });

    describe('GET /threads/{thread_id}/stream - Join Thread Stream', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        it('should join thread stream', async () => {
            const thread = await client.threads.create();

            const stream = await client.threads.joinStream(thread.thread_id);
            expect(stream).toBeDefined();
        });

        it('should join thread stream with Last-Event-ID', async () => {
            const thread = await client.threads.create();

            const stream = await client.threads.joinStream(thread.thread_id, {
                lastEventId: '-',
            });
            expect(stream).toBeDefined();
        });

        it('should join thread stream with stream_modes', async () => {
            const thread = await client.threads.create();

            const stream = await client.threads.joinStream(thread.thread_id, {
                streamMode: ['lifecycle'],
            });
            expect(stream).toBeDefined();
        });

        it('should join thread stream with multiple stream_modes', async () => {
            const thread = await client.threads.create();

            const stream = await client.threads.joinStream(thread.thread_id, {
                streamMode: ['lifecycle', 'run_modes', 'state_update'],
            });
            expect(stream).toBeDefined();
        });
    });
});
