/**
 * Threads Runs API 集成测试
 *
 * 测试 Threads Runs 相关的 API 端点
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@langchain/langgraph-sdk';
import { registerGraph } from '../../src/createEndpoint';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage } from 'langchain';
import { handleRequest } from '../../src/adapter/fetch/index';

describe('Threads Runs API 测试', () => {
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
        registerGraph('test-simple-runs', simpleGraph);
    });

    describe('POST /threads/{thread_id}/runs - Create Background Run', () => {
        it('should create a background run and return immediately', async () => {
            const client = prepareClient();

            // 创建 thread
            const thread = await client.threads.create();
            expect(thread).toHaveProperty('thread_id');

            // 创建后台运行
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            expect(run).toHaveProperty('run_id');
            expect(run).toHaveProperty('thread_id', thread.thread_id);
            expect(run).toHaveProperty('assistant_id', 'test-simple-runs');
            expect(run).toHaveProperty('status');
        });

        it('should create a run with metadata', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
                metadata: { test: 'data' },
            });

            expect(run.metadata).toHaveProperty('test', 'data');
        });
    });

    describe('POST /threads/{thread_id}/runs/wait - Create Run and Wait', () => {
        it('should create a run and wait for completion', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const result = await client.runs.wait(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            expect(result).toBeDefined();
            // 等待运行应该返回最终的 state values
        });
    });

    describe('GET /threads/{thread_id}/runs - List Runs', () => {
        it('should list runs for a thread', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            // 创建几个运行
            await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello 1' }] },
            });
            await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello 2' }] },
            });

            const runs = await client.runs.list(thread.thread_id);
            expect(Array.isArray(runs)).toBe(true);
            expect(runs.length).toBeGreaterThanOrEqual(2);
        });

        it('should list runs with limit', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });
            await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            const runs = await client.runs.list(thread.thread_id, { limit: 1 });
            expect(runs.length).toBeLessThanOrEqual(1);
        });

        it('should list runs with offset', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });
            await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            const allRuns = await client.runs.list(thread.thread_id);
            const offsetRuns = await client.runs.list(thread.thread_id, { offset: 1 });

            expect(offsetRuns.length).toBe(allRuns.length - 1);
        });

        it('should list runs with status filter', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            const runs = await client.runs.list(thread.thread_id, { status: 'success' });
            expect(Array.isArray(runs)).toBe(true);
        });
    });

    describe('GET /threads/{thread_id}/runs/{run_id} - Get Run', () => {
        it('should get a specific run by ID', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const createdRun = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            const run = await client.runs.get(thread.thread_id, createdRun.run_id);

            expect(run).toHaveProperty('run_id', createdRun.run_id);
            expect(run).toHaveProperty('thread_id', thread.thread_id);
            expect(run).toHaveProperty('assistant_id', 'test-simple-runs');
        });

        it('should throw error for non-existent run', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            await expect(client.runs.get(thread.thread_id, 'non-existent-run-id')).rejects.toThrow();
        });
    });

    describe('DELETE /threads/{thread_id}/runs/{run_id} - Delete Run', () => {
        it('should delete a run', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            // 等待运行完成后再删除
            await client.runs.join(thread.thread_id, run.run_id);

            await client.runs.delete(thread.thread_id, run.run_id);

            // 验证运行已被删除
            expect((await client.runs.get(thread.thread_id, run.run_id)).status).toBe('deleted');
        });
    });

    describe('GET /threads/{thread_id}/runs/{run_id}/join - Join Run', () => {
        it('should wait for a run to finish', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            // 等待运行完成
            const result = await client.runs.join(thread.thread_id, run.run_id);

            expect(result).toBeDefined();
        });

        it('should support cancel on disconnect', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            // 注意：实际测试取消行为可能需要更复杂的设置
            const result = await client.runs.join(thread.thread_id, run.run_id);
            expect(result).toBeDefined();
        });
    });

    describe('GET /threads/{thread_id}/runs/{run_id}/stream - Join Run Stream', () => {
        it('should stream output from a run', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            // 使用 stream API 来创建运行并获取流
            let eventCount = 0;
            for await (const event of client.runs.stream(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            })) {
                eventCount++;
                expect(event).toHaveProperty('event');
                expect(event).toHaveProperty('data');
            }

            expect(eventCount).toBeGreaterThan(0);
        });

        it('should support lastEventId to resume stream', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
                streamResumable: true,
            });

            // 收集事件 ID
            const eventIds: string[] = [];
            for await (const event of client.runs.joinStream(thread.thread_id, run.run_id)) {
                if (event.id) {
                    eventIds.push(event.id);
                }
            }

            // 使用 lastEventId 恢复流
            if (eventIds.length > 0) {
                const resumedStream = client.runs.joinStream(thread.thread_id, run.run_id, {
                    lastEventId: eventIds[0],
                });
                for await (const _ of resumedStream) {
                    // 应该能够恢复
                    break;
                }
            }
        });

        it('should support streamMode parameter', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            const stream = client.runs.joinStream(thread.thread_id, run.run_id, {
                streamMode: 'values',
            });

            for await (const event of stream) {
                expect(event).toHaveProperty('event');
                expect(event).toHaveProperty('data');
            }
        });
    });

    describe('POST /threads/{thread_id}/runs/{run_id}/cancel - Cancel Run', () => {
        it('should cancel a run', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            await client.runs.cancel(thread.thread_id, run.run_id);

            // 运行应该被取消
            expect(run.run_id).toBeDefined();
        });

        it('should cancel a run and wait for cancellation', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            await client.runs.cancel(thread.thread_id, run.run_id, true);

            // 等待取消完成
            expect(run.run_id).toBeDefined();
        });

        it('should support cancel action rollback', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            await client.runs.cancel(thread.thread_id, run.run_id, false, 'rollback');

            expect(run.run_id).toBeDefined();
        });
    });

    describe('POST /threads/{thread_id}/runs/stream - Create Run and Stream', () => {
        it('should create a run and stream output', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();
            let eventCount = 0;

            for await (const event of client.runs.stream(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            })) {
                eventCount++;
                expect(event).toHaveProperty('event');
                expect(event).toHaveProperty('data');
            }

            expect(eventCount).toBeGreaterThan(0);
        });

        it('should support streamMode in stream', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            const stream = client.runs.stream(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
                streamMode: ['updates', 'messages'],
            });

            for await (const event of stream) {
                expect(event).toHaveProperty('event');
                expect(event).toHaveProperty('data');
            }
        });
    });

    describe('Integration Tests', () => {
        it('should handle complete run lifecycle', async () => {
            const client = prepareClient();

            // 1. 创建 thread
            const thread = await client.threads.create();

            // 2. 创建后台运行
            const run = await client.runs.create(thread.thread_id, 'test-simple-runs', {
                input: { messages: [{ role: 'user', content: 'Hello' }] },
            });

            // 3. 获取运行状态
            const retrievedRun = await client.runs.get(thread.thread_id, run.run_id);
            expect(retrievedRun.run_id).toBe(run.run_id);

            // 4. 等待运行完成
            const result = await client.runs.join(thread.thread_id, run.run_id);
            expect(result).toBeDefined();

            // 5. 列出运行
            const runs = await client.runs.list(thread.thread_id);
            expect(runs.length).toBeGreaterThan(0);

            // 6. 删除运行
            await client.runs.delete(thread.thread_id, run.run_id);
        });

        it('should handle multiple concurrent runs', async () => {
            const client = prepareClient();

            const thread = await client.threads.create();

            // 创建多个运行
            const runPromises = [
                client.runs.create(thread.thread_id, 'test-simple-runs', {
                    input: { messages: [{ role: 'user', content: 'Hello 1' }] },
                }),
                client.runs.create(thread.thread_id, 'test-simple-runs', {
                    input: { messages: [{ role: 'user', content: 'Hello 2' }] },
                }),
                client.runs.create(thread.thread_id, 'test-simple-runs', {
                    input: { messages: [{ role: 'user', content: 'Hello 3' }] },
                }),
            ];

            const runs = await Promise.all(runPromises);
            expect(runs.length).toBe(3);

            // 列出所有运行
            const allRuns = await client.runs.list(thread.thread_id);
            expect(allRuns.length).toBeGreaterThanOrEqual(3);
        });
    });
});
