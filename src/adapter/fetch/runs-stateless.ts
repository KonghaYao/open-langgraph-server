import { client } from './endpoint';
import { RunCreateStatelessSchema, RunBatchCreateSchema, RunsCancelSchema, RunsCancelQuerySchema } from '../zod';
import camelcaseKeys from 'camelcase-keys';
import { validate, errorResponse, jsonResponse, createSSEStream, withHeartbeat } from './utils';
import { LangGraphServerContext } from './context';
import { getGraph } from '../../utils/getGraph';
import { streamState } from '../../graph/stream';
import { LangGraphGlobal } from '../../global';

/**
 * POST /runs - Create Background Run (Stateless)
 * Create a run in a new thread, return run ID immediately.
 * Don't wait for final run output.
 */
export async function createStatelessRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(RunCreateStatelessSchema, body);

        const camelPayload = camelcaseKeys(payload) as any;
        camelPayload.config = camelPayload.config || {};
        camelPayload.config.configurable = camelPayload.config.configurable || {};

        const langgraphContext = context?.langgraph_context;
        if (langgraphContext) {
            Object.assign(camelPayload.config.configurable, langgraphContext);
        }

        // Create a temporary thread for stateless run
        const threads = client.threads;
        const thread = await threads.create({
            metadata: { ...camelPayload.metadata, temporary: true },
        });

        // Ensure graph_id and thread_id in configurable
        camelPayload.config.configurable.graph_id = payload.assistant_id;
        camelPayload.config.configurable.thread_id = thread.thread_id;
        // Mark as temporary (no state persistence)
        camelPayload.temporary = true;

        // Create Run object
        const run = await threads.createRun(thread.thread_id, payload.assistant_id, camelPayload);

        // Execute the graph stream in background (don't wait)
        // streamState 内部已处理队列清理，这里添加兜底清理防止异常情况
        (async () => {
            let queueCleared = false;
            try {
                for await (const _ of streamState(threads, run, camelPayload, {
                    attempt: 0,
                    getGraph,
                })) {
                    // Consume the stream without doing anything
                }
            } catch (error) {
                console.error('Stateless run error:', error);
            } finally {
                // Clean up temporary thread after completion
                try {
                    await threads.delete(thread.thread_id);
                } catch (e) {
                    console.error('Error cleaning up temporary thread:', e);
                }
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
            'Content-Location': `/threads/${thread.thread_id}/runs/${run.run_id}`,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /runs/stream - Create Run, Stream Output (Stateless)
 * Create a run in a new thread and stream the output.
 */
export async function streamStatelessRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(RunCreateStatelessSchema, body);

        const camelPayload = camelcaseKeys(payload) as any;
        camelPayload.config = camelPayload.config || {};
        camelPayload.config.configurable = camelPayload.config.configurable || {};

        const langgraphContext = context?.langgraph_context;
        if (langgraphContext) {
            Object.assign(camelPayload.config.configurable, langgraphContext);
        }

        // Create a temporary thread for stateless run
        const threads = client.threads;
        const thread = await threads.create({
            metadata: { ...camelPayload.metadata, temporary: true },
        });

        // Ensure graph_id and thread_id in configurable
        camelPayload.config.configurable.graph_id = payload.assistant_id;
        camelPayload.config.configurable.thread_id = thread.thread_id;
        camelPayload.temporary = true;

        // Create Run object
        const run = await threads.createRun(thread.thread_id, payload.assistant_id, camelPayload);

        return createSSEStream(
            withHeartbeat(async (writer) => {
                try {
                    for await (const event of streamState(threads, run, camelPayload, {
                        attempt: 0,
                        getGraph,
                    })) {
                        await writer.writeSSE({ data: JSON.stringify(event), event: 'data' });
                    }
                } catch (error: unknown) {
                    if (error instanceof Error && error.name !== 'AbortError') {
                        console.error('Stream error:', error);
                        throw error;
                    }
                } finally {
                    // Clean up temporary thread after completion
                    try {
                        await threads.delete(thread.thread_id);
                    } catch (e) {
                        console.error('Error cleaning up temporary thread:', e);
                    }
                }
            }),
        );
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /runs/wait - Create Run, Wait for Output (Stateless)
 * Create a run in a new thread. Wait for the final output and then return it.
 */
export async function waitStatelessRun(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(RunCreateStatelessSchema, body);

        const camelPayload = camelcaseKeys(payload) as any;
        camelPayload.config = camelPayload.config || {};
        camelPayload.config.configurable = camelPayload.config.configurable || {};

        const langgraphContext = context?.langgraph_context;
        if (langgraphContext) {
            Object.assign(camelPayload.config.configurable, langgraphContext);
        }

        // Create a temporary thread for stateless run
        const threads = client.threads;
        const thread = await threads.create({
            metadata: { ...camelPayload.metadata, temporary: true },
        });

        // Ensure graph_id and thread_id in configurable
        camelPayload.config.configurable.graph_id = payload.assistant_id;
        camelPayload.config.configurable.thread_id = thread.thread_id;
        camelPayload.temporary = true;

        // Create Run object
        const run = await threads.createRun(thread.thread_id, payload.assistant_id, camelPayload);

        // Execute the graph stream and wait for completion
        const stateValues: any = {};
        try {
            for await (const { event, data } of streamState(threads, run, camelPayload, {
                attempt: 0,
                getGraph,
            })) {
                // Collect final state values
                if (event === 'end' || event === 'writes/value') {
                    if (data && typeof data === 'object') {
                        Object.assign(stateValues, data);
                    }
                }
            }
        } finally {
            // Clean up temporary thread after completion
            try {
                await threads.delete(thread.thread_id);
            } catch (e) {
                console.error('Error cleaning up temporary thread:', e);
            }
        }

        return jsonResponse(stateValues, 200, {
            'Content-Location': `/threads/${thread.thread_id}/runs/${run.run_id}`,
        });
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /runs/batch - Create Run Batch (Stateless)
 * Create a batch of runs in new threads, return immediately.
 */
export async function createBatchRuns(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payloads = validate(RunBatchCreateSchema, body);

        const threads = client.threads;
        const results: Array<{ thread_id: string; run_id: string } | { error: string }> = [];

        // Create all runs in parallel
        const runPromises = payloads.map(async (payload) => {
            try {
                const camelPayload = camelcaseKeys(payload) as any;
                camelPayload.config = camelPayload.config || {};
                camelPayload.config.configurable = camelPayload.config.configurable || {};

                const langgraphContext = context?.langgraph_context;
                if (langgraphContext) {
                    Object.assign(camelPayload.config.configurable, langgraphContext);
                }

                // Create a temporary thread for each run
                const thread = await threads.create({
                    metadata: { ...camelPayload.metadata, temporary: true },
                });

                // Ensure graph_id and thread_id in configurable
                camelPayload.config.configurable.graph_id = payload.assistant_id;
                camelPayload.config.configurable.thread_id = thread.thread_id;
                camelPayload.temporary = true;

                // Create Run object
                const run = await threads.createRun(thread.thread_id, payload.assistant_id, camelPayload);

                // Execute each run in background
                // streamState 内部已处理队列清理，这里添加兜底清理防止异常情况
                (async () => {
                    let queueCleared = false;
                    try {
                        for await (const _ of streamState(threads, run, camelPayload, {
                            attempt: 0,
                            getGraph,
                        })) {
                            // Consume the stream without doing anything
                        }
                    } catch (error) {
                        console.error('Batch run error:', error);
                    } finally {
                        // Clean up temporary thread after completion
                        try {
                            await threads.delete(thread.thread_id);
                        } catch (e) {
                            console.error('Error cleaning up temporary thread:', e);
                        }
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

                return { thread_id: thread.thread_id, run_id: run.run_id };
            } catch (error: unknown) {
                console.error('Batch run creation error:', error);
                return { error: (error instanceof Error ? error.message : 'Unknown error') || 'Unknown error' };
            }
        });

        // Wait for all run creations to complete
        const runResults = await Promise.all(runPromises);
        results.push(...runResults);

        return jsonResponse(results, 200);
    } catch (error) {
        return errorResponse(error);
    }
}

/**
 * POST /runs/cancel - Cancel Runs
 * Cancel one or more runs. Can cancel runs by thread ID and run IDs,
 * or by status filter.
 */
export async function cancelRuns(req: Request, context: LangGraphServerContext): Promise<Response> {
    try {
        const body = await req.json();
        const payload = validate(RunsCancelSchema, body);

        // Parse query parameters for action
        const url = new URL(req.url);
        const queryParams = validate(RunsCancelQuerySchema, {
            action: url.searchParams.get('action') || 'interrupt',
        });

        const threads = client.threads;
        let cancelledRuns: string[] = [];

        if ('run_ids' in payload && payload.run_ids) {
            // Cancel by run IDs - need to find threads for these runs
            // This is more complex as we need to look up runs by ID
            // For now, we'll implement a simplified version
            for (const runId of payload.run_ids) {
                try {
                    // Find thread for this run (this would require a search capability)
                    // For now, we'll just skip as this needs additional thread manager support
                    console.warn(`Cancel by run_id ${runId} not fully implemented yet`);
                } catch (error) {
                    console.error(`Error cancelling run ${runId}:`, error);
                }
            }
        } else if ('thread_id' in payload && payload.thread_id) {
            // Cancel all runs in a specific thread
            const threadId = payload.thread_id;
            try {
                // List all runs for the thread
                const runs = await threads.listRuns(threadId, {
                    limit: 1000,
                    offset: 0,
                });
                
                // Filter runs by status and cancel each
                for (const run of runs) {
                    try {
                        // Use cancel from client.runs directly
                        client.runs.cancel(threadId, run.run_id, queryParams.wait, queryParams.action);
                        cancelledRuns.push(run.run_id);
                    } catch (error) {
                        console.error(`Error cancelling run ${run.run_id}:`, error);
                    }
                }
            } catch (error) {
                console.error(`Error listing runs for thread ${threadId}:`, error);
            }
        } else if ('status' in payload && payload.status) {
            // Cancel runs by status (this would require searching across all threads)
            // For now, we'll implement a simplified version
            console.warn(`Cancel by status ${payload.status} not fully implemented yet`);
        }

        // Return 204 No Content on success
        return new Response(null, { status: 204 });
    } catch (error) {
        return errorResponse(error);
    }
}
