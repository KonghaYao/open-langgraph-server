/**
 * @langchain/langgraph-sdk Stateless Runs API 集成测试
 *
 * 这个测试展示了如何使用 LangGraph SDK 来对接 pure-graph server 的 stateless runs API
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@langchain/langgraph-sdk';
import { registerGraph } from '../../src/createEndpoint';
import { handleRequest } from '../../src/adapter/fetch/index';
import { MessagesAnnotation } from '@langchain/langgraph';
import { AIMessage, HumanMessage } from 'langchain';

describe('LangGraph SDK Stateless Runs 集成测试', () => {
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

    describe('Stateless Runs API', () => {
        let client: ReturnType<typeof prepareClient>;

        beforeEach(() => {
            client = prepareClient();
        });

        describe('POST /runs - Create Background Run (Stateless)', () => {
            it('should create a background run with threadId=null', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
                expect(run).toHaveProperty('thread_id');
                expect(run).toHaveProperty('assistant_id', 'test-simple');
                expect(run).toHaveProperty('status', 'pending');
            });

            it('should create a background run with messages', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
                expect(run).toHaveProperty('thread_id');
            });

            it('should create a background run with metadata', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    metadata: { test_key: 'test_value', source: 'test' },
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
                expect(run).toHaveProperty('metadata');
                if (run.metadata) {
                    expect(run.metadata).toHaveProperty('test_key', 'test_value');
                    expect(run.metadata).toHaveProperty('source', 'test');
                }
            });

            it('should create a background run with config', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    config: {
                        tags: ['test-tag'],
                        recursion_limit: 5,
                    },
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
                // Note: config may not be returned in the run object
                // The important thing is the run was created successfully
            });

            it('should create a background run with streamMode', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamMode: ['values', 'messages'],
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should create a background run with streamSubgraphs', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamSubgraphs: true,
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should create a background run with streamResumable', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamResumable: true,
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should create a background run with interruptBefore', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    interruptBefore: ['simple'],
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should create a background run with interruptAfter', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    interruptAfter: ['simple'],
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should create a background run without input', async () => {
                const run = await client.runs.create(null, 'test-simple');

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });
        });

        describe('POST /runs/stream - Create Run, Stream Output (Stateless)', () => {
            it('should create a run and stream output', async () => {
                const stream = client.runs.stream(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                });

                const events: any[] = [];
                for await (const event of stream) {
                    events.push(event);
                    // Break after receiving some events to avoid infinite loop in test
                    if (events.length > 5) break;
                }

                expect(events.length).toBeGreaterThan(0);
            });

            it('should stream output with values mode', async () => {
                const stream = client.runs.stream(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamMode: 'values',
                });

                const events: any[] = [];
                for await (const event of stream) {
                    events.push(event);
                    if (events.length > 5) break;
                }

                expect(events.length).toBeGreaterThan(0);
            });

            it('should stream output with messages mode', async () => {
                const stream = client.runs.stream(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamMode: 'messages',
                });

                const events: any[] = [];
                for await (const event of stream) {
                    events.push(event);
                    if (events.length > 5) break;
                }

                expect(events.length).toBeGreaterThan(0);
            });

            it('should stream output with multiple stream modes', async () => {
                const stream = client.runs.stream(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamMode: ['values', 'messages', 'updates'],
                });

                const events: any[] = [];
                for await (const event of stream) {
                    events.push(event);
                    if (events.length > 10) break;
                }

                expect(events.length).toBeGreaterThan(0);
            });

            it('should stream output with streamSubgraphs enabled', async () => {
                const stream = client.runs.stream(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    streamSubgraphs: true,
                });

                const events: any[] = [];
                for await (const event of stream) {
                    events.push(event);
                    if (events.length > 5) break;
                }

                expect(events.length).toBeGreaterThan(0);
            });
        });

        describe('POST /runs/wait - Create Run, Wait for Output (Stateless)', () => {
            it('should create a run and wait for output', async () => {
                const result = await client.runs.wait(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                });

                expect(result).toBeDefined();
                // Result should be final state values (object, not necessarily with 'messages' property)
                expect(typeof result).toBe('object');
            });

            it('should wait for output with complex input', async () => {
                const result = await client.runs.wait(null, 'test-simple', {
                    input: {
                        messages: [
                            new HumanMessage('First message'),
                            new AIMessage('First response'),
                            new HumanMessage('Second message'),
                        ],
                    },
                });

                expect(result).toBeDefined();
                expect(typeof result).toBe('object');
            });

            it('should wait for output with metadata', async () => {
                const result = await client.runs.wait(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    metadata: { test_key: 'test_value' },
                });

                expect(result).toBeDefined();
                expect(typeof result).toBe('object');
            });

            it('should wait for output with config', async () => {
                const result = await client.runs.wait(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    config: {
                        tags: ['test-tag'],
                        recursion_limit: 5,
                    },
                });

                expect(result).toBeDefined();
                expect(typeof result).toBe('object');
            });
        });

        describe('POST /runs/batch - Create Run Batch (Stateless)', () => {
            it('should create a batch of runs using createBatch', async () => {
                const results = await client.runs.createBatch([
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Test 1')] },
                    },
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Test 2')] },
                    },
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Test 3')] },
                    },
                ]);

                expect(Array.isArray(results)).toBe(true);
                expect(results.length).toBe(3);
                results.forEach((result) => {
                    expect(result).toHaveProperty('thread_id');
                    expect(result).toHaveProperty('run_id');
                });
            });

            it('should create a batch with single run', async () => {
                const results = await client.runs.createBatch([
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Test')] },
                    },
                ]);

                expect(Array.isArray(results)).toBe(true);
                expect(results.length).toBe(1);
                expect(results[0]).toHaveProperty('thread_id');
                expect(results[0]).toHaveProperty('run_id');
            });

            it('should create a batch with metadata for each run', async () => {
                const results = await client.runs.createBatch([
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Test 1')] },
                        metadata: { batch_index: '0' },
                    },
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Test 2')] },
                        metadata: { batch_index: '1' },
                    },
                ]);

                expect(Array.isArray(results)).toBe(true);
                expect(results.length).toBe(2);
            });

            it('should create a batch with different inputs', async () => {
                const results = await client.runs.createBatch([
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Hello')] },
                    },
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Hi')] },
                    },
                    {
                        assistantId: 'test-simple',
                        input: { messages: [new HumanMessage('Hey')] },
                    },
                ]);

                expect(Array.isArray(results)).toBe(true);
                expect(results.length).toBe(3);
            });

            it('should throw error for empty batch array', async () => {
                await expect(client.runs.createBatch([])).rejects.toThrow();
            });

            it('should create a large batch', async () => {
                const batchSize = 10;
                const batch = Array.from({ length: batchSize }, (_, i) => ({
                    assistantId: 'test-simple',
                    input: { messages: [new HumanMessage(`Test ${i}`)] },
                }));

                const results = await client.runs.createBatch(batch);

                expect(Array.isArray(results)).toBe(true);
                expect(results.length).toBe(batchSize);
            });
        });

        describe('Cancel Runs - Individual Run Cancellation', () => {
            it('should cancel a specific run by threadId and runId', async () => {
                // First, create a run in a thread
                const thread = await client.threads.create();
                const run = await client.runs.create(thread.thread_id, 'test-simple', {
                    input: { messages: [new HumanMessage('Test')] },
                });

                // Cancel the specific run
                await client.runs.cancel(thread.thread_id, run.run_id);

                expect(run).toBeDefined();
                expect(thread).toBeDefined();
            });

            it('should cancel a stateless run by threadId and runId', async () => {
                // Create a stateless run (threadId will be null in request, but we get back a thread)
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Test')] },
                });

                // Cancel the specific run using the returned thread_id
                await client.runs.cancel(run.thread_id, run.run_id);

                expect(run).toBeDefined();
            });

            it('should cancel a run with wait=true', async () => {
                const thread = await client.threads.create();
                const run = await client.runs.create(thread.thread_id, 'test-simple', {
                    input: { messages: [new HumanMessage('Test')] },
                });

                // Cancel with wait=true
                await client.runs.cancel(thread.thread_id, run.run_id, true);

                expect(run).toBeDefined();
            });

            it('should cancel a run with action=interrupt', async () => {
                const thread = await client.threads.create();
                const run = await client.runs.create(thread.thread_id, 'test-simple', {
                    input: { messages: [new HumanMessage('Test')] },
                });

                // Cancel with interrupt action
                await client.runs.cancel(thread.thread_id, run.run_id, false, 'interrupt');

                expect(run).toBeDefined();
            });

            it('should cancel a run with action=rollback', async () => {
                const thread = await client.threads.create();
                const run = await client.runs.create(thread.thread_id, 'test-simple', {
                    input: { messages: [new HumanMessage('Test')] },
                });

                // Cancel with rollback action
                await client.runs.cancel(thread.thread_id, run.run_id, false, 'rollback');

                expect(run).toBeDefined();
            });
        });

        describe('POST /runs - Additional Features', () => {
            it('should support command parameter', async () => {
                const run = await client.runs.create(null, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    command: {
                        goto: 'simple',
                    },
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should support multitaskStrategy parameter', async () => {
                const thread = await client.threads.create();
                const run = await client.runs.create(thread.thread_id, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    multitaskStrategy: 'reject',
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });

            it('should support onCompletion parameter', async () => {
                const thread = await client.threads.create();
                const run = await client.runs.create(thread.thread_id, 'test-simple', {
                    input: { messages: [new HumanMessage('Hello')] },
                    onCompletion: 'continue',
                });

                expect(run).toBeDefined();
                expect(run).toHaveProperty('run_id');
            });
        });
    });
});
