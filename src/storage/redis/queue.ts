import { CancelEventMessage, EventMessage } from '../../queue/event_message.js';
import { BaseStreamQueue } from '../../queue/stream_queue.js';
import { BaseStreamQueueInterface } from '../../queue/stream_queue.js';
import { createClient, RedisClientType } from 'redis';

/**
 * Redis Stream 实现的消息队列，用于存储消息
 * 使用 Redis Streams 替代 pub/sub，支持集群模式
 */
export class RedisStreamQueue extends BaseStreamQueue implements BaseStreamQueueInterface {
    private redis: RedisClientType;
    private streamKey: string;
    private listKey: string;
    private isConnected = false;
    public cancelSignal: AbortController;
    private lastStreamId: string = '0'; // 最后读取的 Stream ID
    private pollInterval: number = 100; // 轮询间隔（毫秒）

    constructor(readonly id: string, readonly compressMessages: boolean = true, readonly ttl: number = 300) {
        super(id, true, ttl);
        this.streamKey = `stream:${this.id}`;
        this.listKey = `queue:${this.id}`;
        this.redis = createClient({
            url: process.env.REDIS_URL,
        });
        this.cancelSignal = new AbortController();

        // 连接 Redis 客户端（检查是否已经连接）
        if (!this.redis.isOpen) {
            this.redis.connect();
        }
        this.isConnected = true;
    }

    /**
     * 推送消息到 Redis Stream 和 List
     * - Stream: 用于实时推送（集群友好）
     * - List: 用于 getAll() 批量获取历史数据
     */
    async push(item: EventMessage): Promise<void> {
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

        // 检查是否已取消
        if (this.cancelSignal.signal.aborted) {
            return;
        }

        // 监听取消信号
        const abortHandler = () => {
            isStreamEnded = true;
        };
        this.cancelSignal.signal.addEventListener('abort', abortHandler);

        try {
            while (!isStreamEnded && !this.cancelSignal.signal.aborted) {
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
            this.cancelSignal.signal.removeEventListener('abort', abortHandler);
        }
    }

    /**
     * 获取队列中的所有数据（从 List 获取历史数据）
     */
    async getAll(): Promise<EventMessage[]> {
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
    clear(): void {
        if (this.isConnected) {
            // 同时清空 Stream 和 List
            this.redis.del(this.streamKey);
            this.redis.del(this.listKey);
        }
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
        const queue = new RedisStreamQueue(toId, this.compressMessages, ttl ?? this.ttl);

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
