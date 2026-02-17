import type { RunnableConfig } from '@langchain/core/runnables';
import {
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointListOptions,
    CheckpointTuple,
    copyCheckpoint,
    getCheckpointId,
    maxChannelVersion,
    WRITES_IDX_MAP,
    uuid6,
} from '@langchain/langgraph-checkpoint';
import { SerializerProtocol } from '@langchain/langgraph-checkpoint';
import { CheckpointMetadata, CheckpointPendingWrite, PendingWrite } from '@langchain/langgraph-checkpoint';
import { TASKS } from '@langchain/langgraph-checkpoint';

/**
 * 生成 shallow 存储键（不含 checkpoint_id）
 * 格式: thread_id::checkpoint_ns
 */
function _getShallowKey(threadId: string, checkpointNamespace: string): string {
    return `${threadId}::${checkpointNamespace}`;
}

/**
 * 解析 shallow 存储键
 */
function _parseShallowKey(key: string): { threadId: string; checkpointNs: string } {
    const [threadId, checkpointNs] = key.split('::');
    return { threadId, checkpointNs: checkpointNs ?? '' };
}

/**
 * 生成 writes 存储键（含 checkpoint_id）
 * 格式: thread_id::checkpoint_ns::checkpoint_id
 */
function _getWritesKey(threadId: string, checkpointNs: string, checkpointId: string): string {
    return `${threadId}::${checkpointNs}::${checkpointId}`;
}

/**
 * Helper function for deterministic object comparison
 * Used for deep metadata filtering
 */
function deterministicStringify(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return JSON.stringify(obj.map((item) => deterministicStringify(item)));
    }
    const sortedObj: Record<string, any> = {};
    const sortedKeys = Object.keys(obj).sort();
    for (const key of sortedKeys) {
        sortedObj[key] = obj[key];
    }
    return JSON.stringify(sortedObj, (_, value) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const sorted: Record<string, any> = {};
            const keys = Object.keys(value).sort();
            for (const k of keys) {
                sorted[k] = value[k];
            }
            return sorted;
        }
        return value;
    });
}
type CheckPointType = {
    checkpoint: Uint8Array;
    metadata: Uint8Array;
    checkpoint_id: string;
    parent_checkpoint_id: string | undefined;
    checkpoint_ts: number; // Timestamp for sorting
};
/**
 * ShallowMemorySaver - A memory checkpoint saver that only keeps the latest checkpoint per thread/namespace.
 *
 * This is a memory-optimized variant that:
 * - Only stores the most recent checkpoint for each thread/namespace combination
 * - Automatically cleans up old writes when new checkpoint is added
 * - Reduces memory usage for applications that don't need checkpoint history
 * - Provides the same API as MemorySaver for seamless replacement
 */
export class ShallowMemorySaver extends BaseCheckpointSaver {
    // thread ID -> checkpoint namespace -> checkpoint data
    // Each namespace only keeps ONE checkpoint
    storage: Record<string, Record<string, CheckPointType>> = {};

    // writes storage: composite key -> writes data
    // Key format: thread_id::checkpoint_ns::checkpoint_id
    writes: Record<string, Record<string, [string, string, Uint8Array]>> = {};

    constructor(serde?: SerializerProtocol) {
        super(serde);
    }

    /**
     * Get just the checkpoint without metadata
     * Convenience method matching ShallowRedisSaver API
     */
    async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
        const tuple = await this.getTuple(config);
        return tuple?.checkpoint;
    }

    /**
     * Migrate pending sends for checkpoints with version < 4
     * @internal
     */
    async _migratePendingSends(
        mutableCheckpoint: Checkpoint,
        threadId: string,
        checkpointNs: string,
        parentCheckpointId: string,
    ): Promise<void> {
        const deseriablizableCheckpoint = mutableCheckpoint;
        const parentKey = _getWritesKey(threadId, checkpointNs, parentCheckpointId);

        const pendingSends = await Promise.all(
            Object.values(this.writes[parentKey] ?? {})
                .filter(([_taskId, channel]) => channel === TASKS)
                .map(async ([_taskId, _channel, writes]) => await this.serde.loadsTyped('json', writes)),
        );

        deseriablizableCheckpoint.channel_values ??= {};
        deseriablizableCheckpoint.channel_values[TASKS] = pendingSends;

        deseriablizableCheckpoint.channel_versions ??= {};
        deseriablizableCheckpoint.channel_versions[TASKS] =
            Object.keys(deseriablizableCheckpoint.channel_versions).length > 0
                ? maxChannelVersion(...Object.values(deseriablizableCheckpoint.channel_versions))
                : this.getNextVersion(undefined);
    }

    /**
     * Load pending writes for a specific checkpoint
     */
    private async _loadPendingWrites(
        threadId: string,
        checkpointNs: string,
        checkpointId: string,
    ): Promise<CheckpointPendingWrite[]> {
        const key = _getWritesKey(threadId, checkpointNs, checkpointId);
        const writes = this.writes[key] ?? {};

        if (Object.keys(writes).length === 0) {
            return [];
        }

        return await Promise.all(
            Object.values(writes).map(async ([taskId, channel, value]) => {
                return [taskId, channel, await this.serde.loadsTyped('json', value)];
            }),
        );
    }

    /**
     * Clean up old writes for a checkpoint
     */
    private _cleanupOldWrites(threadId: string, checkpointNs: string, checkpointId: string): void {
        const key = _getWritesKey(threadId, checkpointNs, checkpointId);
        delete this.writes[key];
    }

    /**
     * Check metadata filter matches (with deep comparison support)
     * Matches ShallowRedisSaver behavior
     */
    private _checkMetadataFilterMatch(metadata: any, filter: CheckpointMetadata): boolean {
        for (const [key, value] of Object.entries(filter)) {
            const metadataValue = metadata?.[key];

            if (value === null) {
                // For null filter value, check if key doesn't exist or value is null
                if (!(key in (metadata || {})) || metadataValue !== null) {
                    return false;
                }
            } else if (typeof value === 'object' && !Array.isArray(value)) {
                // Deep comparison for objects with deterministic key ordering
                if (typeof metadataValue !== 'object' || metadataValue === null) {
                    return false;
                }
                if (deterministicStringify(value) !== deterministicStringify(metadataValue)) {
                    return false;
                }
            } else if (metadataValue !== value) {
                return false;
            }
        }
        return true;
    }

    async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
        const threadId = config.configurable?.thread_id;
        const checkpointNs = config.configurable?.checkpoint_ns ?? '';
        const requestedCheckpointId = getCheckpointId(config);

        if (threadId === undefined) {
            return undefined;
        }

        const namespaceData = this.storage[threadId]?.[checkpointNs];
        if (namespaceData === undefined) {
            return undefined;
        }

        // In shallow mode, we only have one checkpoint per namespace
        const { checkpoint, metadata, checkpoint_id, parent_checkpoint_id } = namespaceData;

        // If a specific checkpoint_id was requested, check if it matches
        if (requestedCheckpointId && checkpoint_id !== requestedCheckpointId) {
            return undefined;
        }

        // Deserialize checkpoint
        const deserializedCheckpoint: Checkpoint = await this.serde.loadsTyped('json', checkpoint);

        // Handle v < 4 migration
        if (deserializedCheckpoint.v < 4 && parent_checkpoint_id !== undefined) {
            await this._migratePendingSends(deserializedCheckpoint, threadId, checkpointNs, parent_checkpoint_id);
        }

        // Load pending writes
        const pendingWrites = await this._loadPendingWrites(threadId, checkpointNs, checkpoint_id);

        // Deserialize metadata
        const deserializedMetadata = (await this.serde.loadsTyped('json', metadata)) as CheckpointMetadata;

        const checkpointTuple: CheckpointTuple = {
            config: {
                configurable: {
                    thread_id: threadId,
                    checkpoint_ns: checkpointNs,
                    checkpoint_id: checkpoint_id,
                },
            },
            checkpoint: deserializedCheckpoint,
            metadata: deserializedMetadata,
            pendingWrites,
        };

        if (parent_checkpoint_id !== undefined) {
            checkpointTuple.parentConfig = {
                configurable: {
                    thread_id: threadId,
                    checkpoint_ns: checkpointNs,
                    checkpoint_id: parent_checkpoint_id,
                },
            };
        }

        return checkpointTuple;
    }

    async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
        let { before, limit, filter } = options ?? {};

        // Determine which threads to iterate
        const threadIds = config.configurable?.thread_id ? [config.configurable.thread_id] : Object.keys(this.storage);

        const configCheckpointNamespace = config.configurable?.checkpoint_ns;
        const configCheckpointId = config.configurable?.checkpoint_id;

        // Collect all matching checkpoints first (for sorting)
        const matchingCheckpoints: {
            threadId: string;
            checkpointNs: string;
            namespaceData: CheckPointType;
        }[] = [];

        for (const threadId of threadIds) {
            const namespaces = this.storage[threadId];
            if (namespaces === undefined) continue;

            for (const checkpointNs of Object.keys(namespaces)) {
                // Filter by namespace if specified
                if (configCheckpointNamespace !== undefined && checkpointNs !== configCheckpointNamespace) {
                    continue;
                }

                const namespaceData = namespaces[checkpointNs];
                if (namespaceData === undefined) continue;

                const { checkpoint_id } = namespaceData;

                // Filter by checkpoint ID from config
                if (configCheckpointId && checkpoint_id !== configCheckpointId) {
                    continue;
                }

                // Filter by checkpoint ID from before config
                if (before?.configurable?.checkpoint_id && checkpoint_id >= before.configurable.checkpoint_id) {
                    continue;
                }

                // Parse metadata for filtering
                const deserializedMetadata = (await this.serde.loadsTyped(
                    'json',
                    namespaceData.metadata,
                )) as CheckpointMetadata;

                // Apply metadata filter with deep comparison
                if (filter && !this._checkMetadataFilterMatch(deserializedMetadata, filter as CheckpointMetadata)) {
                    continue;
                }

                matchingCheckpoints.push({ threadId, checkpointNs, namespaceData });
            }
        }

        // Sort by checkpoint_ts descending (newest first) - matching ShallowRedisSaver behavior
        matchingCheckpoints.sort((a, b) => b.namespaceData.checkpoint_ts - a.namespaceData.checkpoint_ts);

        // Apply limit and yield
        let count = 0;
        for (const { threadId, checkpointNs, namespaceData } of matchingCheckpoints) {
            if (limit !== undefined && count >= limit) {
                return;
            }

            const { checkpoint, metadata, checkpoint_id, parent_checkpoint_id } = namespaceData;

            // Deserialize checkpoint
            const deserializedCheckpoint = await this.serde.loadsTyped('json', checkpoint);

            // Handle v < 4 migration
            if (deserializedCheckpoint.v < 4 && parent_checkpoint_id !== undefined) {
                await this._migratePendingSends(deserializedCheckpoint, threadId, checkpointNs, parent_checkpoint_id);
            }

            // Load pending writes
            const pendingWrites = await this._loadPendingWrites(threadId, checkpointNs, checkpoint_id);

            // Deserialize metadata
            const deserializedMetadata = (await this.serde.loadsTyped('json', metadata)) as CheckpointMetadata;

            const checkpointTuple: CheckpointTuple = {
                config: {
                    configurable: {
                        thread_id: threadId,
                        checkpoint_ns: checkpointNs,
                        checkpoint_id: checkpoint_id,
                    },
                },
                checkpoint: deserializedCheckpoint,
                metadata: deserializedMetadata,
                pendingWrites,
            };

            if (parent_checkpoint_id !== undefined) {
                checkpointTuple.parentConfig = {
                    configurable: {
                        thread_id: threadId,
                        checkpoint_ns: checkpointNs,
                        checkpoint_id: parent_checkpoint_id,
                    },
                };
            }

            count++;
            yield checkpointTuple;
        }
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        _newVersions?: ChannelVersions,
    ): Promise<RunnableConfig> {
        const preparedCheckpoint: Partial<Checkpoint> = copyCheckpoint(checkpoint);
        const threadId = config.configurable?.thread_id;
        const checkpointNamespace = config.configurable?.checkpoint_ns ?? '';
        const parentCheckpointId = config.configurable?.checkpoint_id;

        if (threadId === undefined) {
            throw new Error('thread_id is required');
        }

        // Use checkpoint.id or generate a new one (matching ShallowRedisSaver)
        const checkpointId = checkpoint.id || uuid6(0);

        // Initialize storage structure if needed
        if (!this.storage[threadId]) {
            this.storage[threadId] = {};
        }

        // Check if there's an old checkpoint to clean up
        const oldNamespaceData = this.storage[threadId][checkpointNamespace];
        if (oldNamespaceData !== undefined && oldNamespaceData.checkpoint_id !== checkpointId) {
            // Clean up old writes for the previous checkpoint
            this._cleanupOldWrites(threadId, checkpointNamespace, oldNamespaceData.checkpoint_id);
        }

        // Serialize checkpoint and metadata
        const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
            this.serde.dumpsTyped(preparedCheckpoint),
            this.serde.dumpsTyped(metadata),
        ]);

        // Store the new checkpoint (overwrites old one in shallow mode)
        this.storage[threadId][checkpointNamespace] = {
            checkpoint: serializedCheckpoint,
            metadata: serializedMetadata,
            checkpoint_id: checkpointId,
            parent_checkpoint_id: parentCheckpointId,
            checkpoint_ts: Date.now(), // Add timestamp for sorting
        };

        return {
            configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNamespace,
                checkpoint_id: checkpointId,
            },
        };
    }

    async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
        const threadId = config.configurable?.thread_id;
        const checkpointNamespace = config.configurable?.checkpoint_ns ?? '';
        const checkpointId = config.configurable?.checkpoint_id;

        if (!threadId || !checkpointId) {
            throw new Error('thread_id and checkpoint_id are required');
        }

        const outerKey = _getWritesKey(threadId, checkpointNamespace, checkpointId);
        const outerWrites_ = this.writes[outerKey];

        if (this.writes[outerKey] === undefined) {
            this.writes[outerKey] = {};
        }

        await Promise.all(
            writes.map(async ([channel, value], idx) => {
                const [, serializedValue] = await this.serde.dumpsTyped(value);
                const innerKey: [string, number] = [taskId, WRITES_IDX_MAP[channel] || idx];
                const innerKeyStr = `${innerKey[0]},${innerKey[1]}`;

                // Skip if already written (for deterministic writes)
                if (innerKey[1] >= 0 && outerWrites_ && innerKeyStr in outerWrites_) {
                    return;
                }

                this.writes[outerKey][innerKeyStr] = [taskId, channel, serializedValue];
            }),
        );
    }

    async deleteThread(threadId: string): Promise<void> {
        // Delete all checkpoints for this thread
        delete this.storage[threadId];

        // Delete all writes for this thread
        for (const key of Object.keys(this.writes)) {
            const { threadId: keyThreadId } = _parseShallowKey(key.split('::').slice(0, 2).join('::'));
            if (keyThreadId === threadId) {
                delete this.writes[key];
            }
        }
    }
}
