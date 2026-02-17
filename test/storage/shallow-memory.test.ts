/**
 * ShallowMemorySaver 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ShallowMemorySaver } from '../../src/storage/memory/shallow-memory';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { v4 as uuidv4 } from 'uuid';

// Helper to create a checkpoint
function createCheckpoint(id: string, parentId?: string): Checkpoint {
    return {
        v: 4,
        id,
        ts: Date.now().toString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
    };
}

// Helper to create a config
function createConfig(threadId: string, checkpointNs = '', checkpointId?: string): RunnableConfig {
    const config: RunnableConfig = {
        configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
        },
    };
    if (checkpointId) {
        config.configurable!.checkpoint_id = checkpointId;
    }
    return config;
}

// Helper to create metadata
function createMetadata(overrides: Partial<CheckpointMetadata> = {}): CheckpointMetadata {
    return {
        source: 'test',
        step: 0,
        ...overrides,
    };
}

describe('ShallowMemorySaver', () => {
    let saver: ShallowMemorySaver;

    beforeEach(() => {
        saver = new ShallowMemorySaver();
    });

    describe('put() and getTuple()', () => {
        it('should store and retrieve a checkpoint', async () => {
            const threadId = uuidv4();
            const checkpoint = createCheckpoint('checkpoint-1');
            const metadata = createMetadata();
            const config = createConfig(threadId);

            const resultConfig = await saver.put(config, checkpoint, metadata);
            expect(resultConfig.configurable?.thread_id).toBe(threadId);
            expect(resultConfig.configurable?.checkpoint_id).toBe('checkpoint-1');

            const tuple = await saver.getTuple(config);
            expect(tuple).toBeDefined();
            expect(tuple?.checkpoint.id).toBe('checkpoint-1');
            expect(tuple?.config.configurable?.thread_id).toBe(threadId);
        });

        it('should only keep the latest checkpoint (shallow behavior)', async () => {
            const threadId = uuidv4();

            // Store first checkpoint
            const checkpoint1 = createCheckpoint('checkpoint-1');
            await saver.put(createConfig(threadId), checkpoint1, createMetadata());

            // Store second checkpoint (should overwrite)
            const checkpoint2 = createCheckpoint('checkpoint-2');
            await saver.put(createConfig(threadId, '', 'checkpoint-1'), checkpoint2, createMetadata());

            // Should only get checkpoint-2
            const tuple = await saver.getTuple(createConfig(threadId));
            expect(tuple?.checkpoint.id).toBe('checkpoint-2');
            expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('checkpoint-1');
        });

        it('should return undefined when checkpoint_id does not match', async () => {
            const threadId = uuidv4();

            // Store a checkpoint
            const checkpoint = createCheckpoint('checkpoint-1');
            await saver.put(createConfig(threadId), checkpoint, createMetadata());

            // Try to get with wrong checkpoint_id
            const tuple = await saver.getTuple(createConfig(threadId, '', 'wrong-id'));
            expect(tuple).toBeUndefined();
        });

        it('should return the checkpoint when checkpoint_id matches', async () => {
            const threadId = uuidv4();

            // Store a checkpoint
            const checkpoint = createCheckpoint('checkpoint-1');
            await saver.put(createConfig(threadId), checkpoint, createMetadata());

            // Get with correct checkpoint_id
            const tuple = await saver.getTuple(createConfig(threadId, '', 'checkpoint-1'));
            expect(tuple).toBeDefined();
            expect(tuple?.checkpoint.id).toBe('checkpoint-1');
        });

        it('should support namespace isolation', async () => {
            const threadId = uuidv4();

            // Store checkpoints in different namespaces
            const checkpoint1 = createCheckpoint('checkpoint-ns1');
            await saver.put(createConfig(threadId, 'ns1'), checkpoint1, createMetadata({ source: 'ns1' }));

            const checkpoint2 = createCheckpoint('checkpoint-ns2');
            await saver.put(createConfig(threadId, 'ns2'), checkpoint2, createMetadata({ source: 'ns2' }));

            // Verify they are isolated
            const tuple1 = await saver.getTuple(createConfig(threadId, 'ns1'));
            expect(tuple1?.checkpoint.id).toBe('checkpoint-ns1');
            expect(tuple1?.metadata.source).toBe('ns1');

            const tuple2 = await saver.getTuple(createConfig(threadId, 'ns2'));
            expect(tuple2?.checkpoint.id).toBe('checkpoint-ns2');
            expect(tuple2?.metadata.source).toBe('ns2');
        });

        it('should throw error when thread_id is missing', async () => {
            const checkpoint = createCheckpoint('checkpoint-1');
            const config: RunnableConfig = { configurable: {} };

            // Match ShallowRedisSaver error message
            await expect(saver.put(config, checkpoint, createMetadata())).rejects.toThrow('thread_id is required');
        });
    });

    describe('list()', () => {
        it('should list all checkpoints', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();

            await saver.put(createConfig(threadId1), createCheckpoint('cp-1'), createMetadata());
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata());

            const tuples = [];
            for await (const tuple of saver.list({ configurable: {} })) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(2);
            const ids = tuples.map((t) => t.checkpoint.id);
            expect(ids).toContain('cp-1');
            expect(ids).toContain('cp-2');
        });

        it('should filter by thread_id', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();

            await saver.put(createConfig(threadId1), createCheckpoint('cp-1'), createMetadata());
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata());

            const tuples = [];
            for await (const tuple of saver.list(createConfig(threadId1))) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(1);
            expect(tuples[0].checkpoint.id).toBe('cp-1');
        });

        it('should filter by namespace', async () => {
            const threadId = uuidv4();

            await saver.put(createConfig(threadId, 'ns1'), createCheckpoint('cp-ns1'), createMetadata());
            await saver.put(createConfig(threadId, 'ns2'), createCheckpoint('cp-ns2'), createMetadata());

            const tuples = [];
            for await (const tuple of saver.list(createConfig(threadId, 'ns1'))) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(1);
            expect(tuples[0].checkpoint.id).toBe('cp-ns1');
        });

        it('should filter by metadata', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();

            await saver.put(createConfig(threadId1), createCheckpoint('cp-1'), createMetadata({ source: 'input' }));
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata({ source: 'loop' }));

            const tuples = [];
            for await (const tuple of saver.list({ configurable: {} }, { filter: { source: 'input' } })) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(1);
            expect(tuples[0].metadata.source).toBe('input');
        });

        it('should respect limit option', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();
            const threadId3 = uuidv4();

            await saver.put(createConfig(threadId1), createCheckpoint('cp-1'), createMetadata());
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata());
            await saver.put(createConfig(threadId3), createCheckpoint('cp-3'), createMetadata());

            const tuples = [];
            for await (const tuple of saver.list({ configurable: {} }, { limit: 2 })) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(2);
        });

        it('should only return one checkpoint per thread/namespace (shallow behavior)', async () => {
            const threadId = uuidv4();

            // Store multiple checkpoints in the same namespace
            await saver.put(createConfig(threadId), createCheckpoint('cp-1'), createMetadata());
            await saver.put(createConfig(threadId, '', 'cp-1'), createCheckpoint('cp-2'), createMetadata());
            await saver.put(createConfig(threadId, '', 'cp-2'), createCheckpoint('cp-3'), createMetadata());

            // List should only return one (the latest)
            const tuples = [];
            for await (const tuple of saver.list(createConfig(threadId))) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(1);
            expect(tuples[0].checkpoint.id).toBe('cp-3');
        });

        it('should sort by timestamp descending (newest first)', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();
            const threadId3 = uuidv4();

            // Create with small delays to ensure different timestamps
            await saver.put(createConfig(threadId1), createCheckpoint('cp-1'), createMetadata());
            await new Promise((r) => setTimeout(r, 10));
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata());
            await new Promise((r) => setTimeout(r, 10));
            await saver.put(createConfig(threadId3), createCheckpoint('cp-3'), createMetadata());

            const tuples = [];
            for await (const tuple of saver.list({ configurable: {} })) {
                tuples.push(tuple);
            }

            // Should be sorted by timestamp descending (newest first)
            expect(tuples[0].checkpoint.id).toBe('cp-3');
            expect(tuples[1].checkpoint.id).toBe('cp-2');
            expect(tuples[2].checkpoint.id).toBe('cp-1');
        });
    });

    describe('putWrites()', () => {
        it('should store pending writes', async () => {
            const threadId = uuidv4();

            await saver.put(createConfig(threadId), createCheckpoint('cp-1'), createMetadata());

            const config = createConfig(threadId, '', 'cp-1');
            await saver.putWrites(
                config,
                [
                    ['channel1', 'value1'],
                    ['channel2', 'value2'],
                ],
                'task-1',
            );

            const tuple = await saver.getTuple(createConfig(threadId));
            expect(tuple?.pendingWrites).toHaveLength(2);
            expect(tuple?.pendingWrites?.[0]).toEqual(['task-1', 'channel1', 'value1']);
            expect(tuple?.pendingWrites?.[1]).toEqual(['task-1', 'channel2', 'value2']);
        });

        it('should clean up old writes when new checkpoint is stored', async () => {
            const threadId = uuidv4();

            // Store first checkpoint with writes
            await saver.put(createConfig(threadId), createCheckpoint('cp-1'), createMetadata());
            await saver.putWrites(createConfig(threadId, '', 'cp-1'), [['channel1', 'value1']], 'task-1');

            // Store new checkpoint (should clean up old writes)
            await saver.put(createConfig(threadId, '', 'cp-1'), createCheckpoint('cp-2'), createMetadata());

            // Old writes should be gone
            const tuple = await saver.getTuple(createConfig(threadId));
            expect(tuple?.pendingWrites).toHaveLength(0);
        });

        it('should throw error when thread_id or checkpoint_id is missing', async () => {
            // Missing thread_id
            const config1: RunnableConfig = { configurable: { checkpoint_id: 'cp-1' } };
            await expect(saver.putWrites(config1, [['ch', 'val']], 'task-1')).rejects.toThrow(
                'thread_id and checkpoint_id are required',
            );

            // Missing checkpoint_id
            const config2: RunnableConfig = { configurable: { thread_id: 'thread-1' } };
            await expect(saver.putWrites(config2, [['ch', 'val']], 'task-1')).rejects.toThrow(
                'thread_id and checkpoint_id are required',
            );
        });
    });

    describe('deleteThread()', () => {
        it('should delete all data for a thread', async () => {
            const threadId = uuidv4();

            await saver.put(createConfig(threadId), createCheckpoint('cp-1'), createMetadata());
            await saver.putWrites(createConfig(threadId, '', 'cp-1'), [['ch', 'val']], 'task-1');

            await saver.deleteThread(threadId);

            const tuple = await saver.getTuple(createConfig(threadId));
            expect(tuple).toBeUndefined();
        });

        it('should not affect other threads', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();

            await saver.put(createConfig(threadId1), createCheckpoint('cp-1'), createMetadata());
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata());

            await saver.deleteThread(threadId1);

            const tuple1 = await saver.getTuple(createConfig(threadId1));
            expect(tuple1).toBeUndefined();

            const tuple2 = await saver.getTuple(createConfig(threadId2));
            expect(tuple2).toBeDefined();
        });
    });

    describe('parent checkpoint tracking', () => {
        it('should track parent checkpoint id', async () => {
            const threadId = uuidv4();

            // Store first checkpoint (no parent)
            await saver.put(createConfig(threadId), createCheckpoint('cp-1'), createMetadata());

            // Store second checkpoint with parent
            await saver.put(createConfig(threadId, '', 'cp-1'), createCheckpoint('cp-2'), createMetadata());

            const tuple = await saver.getTuple(createConfig(threadId));
            expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('cp-1');
        });
    });

    describe('get() convenience method', () => {
        it('should return just the checkpoint without metadata', async () => {
            const threadId = uuidv4();
            const checkpoint = createCheckpoint('checkpoint-1');
            await saver.put(createConfig(threadId), checkpoint, createMetadata({ source: 'test' }));

            const result = await saver.get(createConfig(threadId));
            expect(result).toBeDefined();
            expect(result?.id).toBe('checkpoint-1');
        });

        it('should return undefined when checkpoint not found', async () => {
            const result = await saver.get(createConfig('non-existent'));
            expect(result).toBeUndefined();
        });
    });

    describe('metadata filtering with complex objects', () => {
        it('should support deep object comparison in filter (exact match)', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();

            // Create two checkpoints with different nested objects
            await saver.put(
                createConfig(threadId1),
                createCheckpoint('cp-1'),
                createMetadata({ writes: { key: 'value', nested: { a: 1 } } }),
            );
            await saver.put(
                createConfig(threadId2),
                createCheckpoint('cp-2'),
                createMetadata({ writes: { key: 'different' } }),
            );

            // Filter with exact match
            const tuples = [];
            for await (const tuple of saver.list(
                { configurable: {} },
                { filter: { writes: { key: 'value', nested: { a: 1 } } } },
            )) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(1);
            expect(tuples[0].checkpoint.id).toBe('cp-1');
        });

        it('should handle null filter values', async () => {
            const threadId1 = uuidv4();
            const threadId2 = uuidv4();

            await saver.put(
                createConfig(threadId1),
                createCheckpoint('cp-1'),
                createMetadata({ source: 'input' } as any),
            );
            await saver.put(createConfig(threadId2), createCheckpoint('cp-2'), createMetadata({ source: null } as any));

            // Filter for null source
            const tuples = [];
            for await (const tuple of saver.list({ configurable: {} }, { filter: { source: null } })) {
                tuples.push(tuple);
            }

            expect(tuples.length).toBe(1);
            expect(tuples[0].checkpoint.id).toBe('cp-2');
        });
    });
});
