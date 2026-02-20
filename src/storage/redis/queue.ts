import { CancelEventMessage, EventMessage } from '../../queue/event_message.js';
import { BaseStreamQueue } from '../../queue/stream_queue.js';
import { BaseStreamQueueInterface } from '../../queue/stream_queue.js';
import { createClient, RedisClientType } from 'redis';

// 全局共享的 Redis 连接池
let sharedRedisClient: RedisClientType | null = null;
let connectionRefCount = 0;
let connectionPromise: Promise<void> | null = null;
let releaseTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * 获取共享的 Redis 连接（线程安全）
 */
async function getSharedRedisClient(): Promise<RedisClientType> {
    // 如果已有连接，直接返回
    if (sharedRedisClient && sharedRedisClient.isOpen) {
        connectionRefCount++;
        return sharedRedisClient;
    }

    // 如果正在建立连接，等待现有 Promise
    if (connectionPromise) {
        await connectionPromise;
        if (sharedRedisClient) {
            connectionRefCount++;
            return sharedRedisClient;
        }
        // 连接失败，继续尝试创建
    }

    // 创建新的连接 Promise，防止并发创建多个连接
    connectionPromise = (async () => {
        const client = createClient({
            url: process.env.REDIS_URL,
        });
        await client.connect();
        sharedRedisClient = client as RedisClientType;
    })();

    try {
        await connectionPromise;
        connectionRefCount++;
        return sharedRedisClient!;
    } catch (error) {
        // 连接失败时清理状态
        connectionPromise = null;
        throw error;
    } finally {
        connectionPromise = null;
    }
}

/**
 * 释放 Redis 连接引用
 */
async function releaseRedisClient(): Promise<void> {
    if (connectionRefCount > 0) {
        connectionRefCount--;
    }

    // 引用计数为 0 且超过一定时间没有新连接时才关闭
    // 避免频繁开关连接
    if (connectionRefCount <= 0 && sharedRedisClient) {
        // 清理之前的延迟关闭定时器
        if (releaseTimeoutId) {
            clearTimeout(releaseTimeoutId);
            releaseTimeoutId = null;
        }

        // 延迟关闭，给其他队列复用连接的机会
        releaseTimeoutId = setTimeout(async () => {
            if (connectionRefCount <= 0 && sharedRedisClient) {
                try {
                    await sharedRedisClient.quit();
                } catch (e) {
                    // 忽略关闭错误
                }
                sharedRedisClient = null;
                connectionRefCount = 0;
                releaseTimeoutId = null;
            }
        }, 5000);
    }
}

/**
 * Redis Stream 实现的消息队列，用于存储消息
 * 使用 Redis Streams 替代 pub/sub，支持集群模式
 */
export class RedisStreamQueue extends BaseStreamQueue implements BaseStreamQueueInterface {
    private redis: RedisClientType | null = null;
    private streamKey: string;
    private listKey: string;
    private isConnected = false;
    public cancelSignal: AbortController;
    private lastStreamId: string = '0'; // 最后读取的 Stream ID
    private pollInterval: number = 100; // 轮询间隔（毫秒）
    private connectionReady: Promise<void>;

    constructor(readonly id: string, readonly compressMessages: boolean = true, readonly ttl: number = 300) {
        super(id, true, ttl);
        this.streamKey = `stream:${this.id}`;
        this.listKey = `queue:${this.id}`;
        this.cancelSignal = new AbortController();

        // 异步初始化 Redis 连接
        this.connectionReady = this.initConnection();
    }

    /**
     * 初始化 Redis 连接（使用共享连接池）
     */
    private async initConnection(): Promise<void> {
        try {
            this.redis = await getSharedRedisClient();
            this.isConnected = true;
        } catch (error) {
            console.error('Failed to connect to Redis:', error);
            throw error;
        }
    }

    /**
     * 确保连接已建立
     */
    private async ensureConnected(): Promise<void> {
        if (!this.isConnected || !this.redis) {
            await this.connectionReady;
        }
    }

    /**
     * 推送消息到 Redis Stream 和 List
     * - Stream: 用于实时推送（集群友好）
     * - List: 用于 getAll() 批量获取历史数据
     */
    async push(item: EventMessage): Promise<void> {
        await this.ensureConnected();
        if (!this.redis) throw new Error('Redis connection not available');

        const encodedData = await this.encodeData(item);
        // 将 Uint8Array 转换为 base64 字符串，以便存储到 Redis Stream
        const dataString = Buffer.from(encodedData).toString('base64');
        const serializedData = Buffer.from(encodedData);

        // 推送到 Stream（实时推送）
        // 注意：xAdd 的第三个参数必须是简单的键值对对象，值必须是字符串
        await this.redis.xAdd(this.streamKey, '*', { data: dataString });

        // 设置 Stream TTL
        await this.redis.expire(this.streamKey, this.ttl);

        // 同时推送到 List（用于 getAll）
        await this.redis.rPush(this.listKey, serializedData);
        await this.redis.expire(this.listKey, this.ttl);

        this.emit('dataChange', dataString);
    }

    /**
     * 异步生成器：使用 Redis Streams XREAD 轮询消费队列数据
     */
    async *onDataReceive(): AsyncGenerator<EventMessage, void, unknown> {
        let isStreamEnded = false;
        let isCleanupDone = false;

        // 等待连接建立
        await this.ensureConnected();
        if (!this.redis) {
            throw new Error('Redis connection not available');
        }

        // 检查是否已取消
        if (this.cancelSignal.signal.aborted) {
            return;
        }

        // 监听取消信号
        const abortHandler = () => {
            isStreamEnded = true;
        };
        this.cancelSignal.signal.addEventListener('abort', abortHandler);

        const cleanup = () => {
            if (isCleanupDone) return;
            isCleanupDone = true;
            try {
                this.cancelSignal.signal.removeEventListener('abort', abortHandler);
            } catch (e) {
                console.error('Error removing abort listener:', e);
            }
        };

        try {
            while (!isStreamEnded && !this.cancelSignal.signal.aborted) {
                // 检查 Redis 连接是否仍然有效
                if (!this.redis || !this.isConnected) {
                    break;
                }

                // 从 Stream 读取新消息（XREAD 阻塞读取）
                const streams = await this.redis.xRead([{ key: this.streamKey, id: this.lastStreamId }], {
                    BLOCK: this.pollInterval,
                    COUNT: 10,
                });

                if (streams && streams.length > 0) {
                    for (const stream of streams) {
                        for (const message of stream.messages) {
                            // 更新最后读取的 ID
                            this.lastStreamId = message.id;

                            // 解析消息：从 base64 字符串转换回 Uint8Array
                            const dataString = message.message.data as string;
                            const data = Buffer.from(dataString, 'base64');
                            const item = (await this.decodeData(data)) as EventMessage;

                            // 检查是否为流结束或错误信号
                            if (
                                item.event === '__stream_end__' ||
                                item.event === '__stream_error__' ||
                                item.event === '__stream_cancel__'
                            ) {
                                // 延迟 300ms 后结束，确保消息被消费
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                isStreamEnded = true;

                                if (item.event === '__stream_cancel__') {
                                    await this.cancel();
                                }
                            }

                            yield item;

                            if (isStreamEnded) {
                                break;
                            }
                        }
                        if (isStreamEnded) {
                            break;
                        }
                    }
                }

                // 轮询间隔
                if (!isStreamEnded && !this.cancelSignal.signal.aborted) {
                    await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
                }
            }
        } finally {
            cleanup();
        }
    }

    /**
     * 获取队列中的所有数据（从 List 获取历史数据）
     */
    async getAll(): Promise<EventMessage[]> {
        await this.ensureConnected();
        if (!this.redis) return [];

        const data = await this.redis.lRange(this.listKey, 0, -1);

        if (!data || data.length === 0) {
            return [];
        }

        if (this.compressMessages) {
            return (await Promise.all(
                data.map((item: Buffer | string) => {
                    // 处理 Buffer 或字符串类型
                    const buffer = typeof item === 'string' ? Buffer.from(item, 'binary') : item;
                    return this.decodeData(buffer);
                }),
            )) as EventMessage[];
        } else {
            return data.map((item: string) => JSON.parse(item) as EventMessage);
        }
    }

    /**
     * 清空队列
     */
    async clear(): Promise<void> {
        if (this.isConnected && this.redis) {
            // 同时清空 Stream 和 List
            await Promise.all([this.redis.del(this.streamKey), this.redis.del(this.listKey)]);
        }
    }

    /**
     * 销毁队列实例，释放 Redis 连接引用
     */
    async destroy(): Promise<void> {
        await this.clear();
        this.isConnected = false;
        this.redis = null;
        await releaseRedisClient();
    }

    /**
     * 取消操作
     */
    async cancel(): Promise<void> {
        // First abort to stop any waiting generators
        this.cancelSignal.abort('user cancel this run');
        // Then push the cancel message to signal other consumers
        await this.push(new CancelEventMessage());
    }

    /**
     * 复制队列到另一个队列
     */
    async copyToQueue(toId: string, ttl?: number): Promise<RedisStreamQueue> {
        await this.ensureConnected();
        if (!this.redis) throw new Error('Redis connection not available');

        const queue = new RedisStreamQueue(toId, this.compressMessages, ttl ?? this.ttl);
        await queue.ensureConnected();

        if (!queue.redis) throw new Error('Target Redis connection not available');

        // 复制 List
        await this.redis.copy(this.listKey, queue.listKey);
        await this.redis.expire(queue.listKey, ttl ?? this.ttl);

        // 复制 Stream（需要遍历并重新添加）
        const allStreamData = await this.redis.xRange(this.streamKey, '-', '+');
        if (allStreamData && allStreamData.length > 0) {
            for (const message of allStreamData) {
                // 确保所有值都是字符串，Redis Streams 只支持 string 值
                const fields: Record<string, string> = {};
                for (const [key, value] of Object.entries(message.message)) {
                    fields[key] = String(value);
                }
                await this.redis.xAdd(queue.streamKey, '*', fields);
            }
            await this.redis.expire(queue.streamKey, ttl ?? this.ttl);
        }

        return queue;
    }
}
