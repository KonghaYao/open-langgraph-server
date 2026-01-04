import { CancelEventMessage, EventMessage } from '../../queue/event_message.js';
import { BaseStreamQueue } from '../../queue/stream_queue.js';
import { BaseStreamQueueInterface } from '../../queue/stream_queue.js';
import { createClient, RedisClientType } from 'redis';

/**
 * Redis 实现的消息队列，用于存储消息
 */
export class RedisStreamQueue extends BaseStreamQueue implements BaseStreamQueueInterface {
    static redis: RedisClientType = createClient({ url: process.env.REDIS_URL! });
    static subscriberRedis: RedisClientType = createClient({ url: process.env.REDIS_URL! });
    static isQueueExist(id: string): Promise<boolean> {
        return this.redis.exists(`queue:${id}`).then((exists) => exists > 0);
    }
    private redis: RedisClientType;
    private subscriberRedis: RedisClientType;
    private queueKey: string;
    private channelKey: string;
    private isConnected = false;
    public cancelSignal: AbortController;

    constructor(readonly id: string, readonly compressMessages: boolean = true, readonly ttl: number = 300) {
        super(id, true, ttl);
        this.queueKey = `queue:${this.id}`;
        this.channelKey = `channel:${this.id}`;
        this.redis = RedisStreamQueue.redis;
        this.subscriberRedis = RedisStreamQueue.subscriberRedis;
        this.cancelSignal = new AbortController();

        // 连接 Redis 客户端（检查是否已经连接）
        if (!this.redis.isOpen) {
            this.redis.connect();
        }
        if (!this.subscriberRedis.isOpen) {
            this.subscriberRedis.connect();
        }
        this.isConnected = true;
    }

    /**
     * 推送消息到 Redis 队列
     */
    async push(item: EventMessage): Promise<void> {
        const data = await this.encodeData(item);
        const serializedData = Buffer.from(data);

        // 推送到队列
        await this.redis.rPush(this.queueKey, serializedData);

        // 设置队列 TTL 为 300 秒
        await this.redis.expire(this.queueKey, this.ttl);

        // 发布到频道通知有新数据
        await this.redis.publish(this.channelKey, serializedData);

        this.emit('dataChange', data);
    }

    /**
     * 异步生成器：支持 for await...of 方式消费队列数据
     */
    async *onDataReceive(): AsyncGenerator<EventMessage, void, unknown> {
        let queue: EventMessage[] = [];
        let pendingResolve: (() => void) | null = null;
        let isStreamEnded = false;
        
        // 检查是否已取消
        if (this.cancelSignal.signal.aborted) {
            return;
        }

        const handleMessage = async (message: string) => {
            const data = (await this.decodeData(message)) as EventMessage;
            queue.push(data);
            // 检查是否为流结束或错误信号
            if (
                data.event === '__stream_end__' ||
                data.event === '__stream_error__' ||
                data.event === '__stream_cancel__'
            ) {
                setTimeout(() => {
                    isStreamEnded = true;
                    if (pendingResolve) {
                        pendingResolve();
                        pendingResolve = null;
                    }
                }, 300);

                if (data.event === '__stream_cancel__') {
                    await this.cancel();
                }
            }

            if (pendingResolve) {
                pendingResolve();
                pendingResolve = null;
            }
        };

        // 订阅 Redis 频道
        await this.subscriberRedis.subscribe(this.channelKey, (message) => {
            handleMessage(message);
        });

        // 监听取消信号
        const abortHandler = () => {
            isStreamEnded = true;
            if (pendingResolve) {
                pendingResolve();
                pendingResolve = null;
            }
        };
        this.cancelSignal.signal.addEventListener('abort', abortHandler);

        try {
            while (!isStreamEnded && !this.cancelSignal.signal.aborted) {
                if (queue.length > 0) {
                    for (const item of queue) {
                        yield item;
                    }
                    queue = [];
                } else {
                    await new Promise((resolve) => {
                        pendingResolve = resolve as () => void;
                    });
                }
            }
        } finally {
            await this.subscriberRedis.unsubscribe(this.channelKey);
            this.cancelSignal.signal.removeEventListener('abort', abortHandler);
        }
    }

    /**
     * 获取队列中的所有数据
     */
    async getAll(): Promise<EventMessage[]> {
        const data = await this.redis.lRange(this.queueKey, 0, -1);

        if (!data || data.length === 0) {
            return [];
        }

        if (this.compressMessages) {
            return (await Promise.all(
                data.map((item: string) => {
                    return this.decodeData(item);
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
            this.redis.del(this.queueKey);
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
    async copyToQueue(toId: string, ttl?: number): Promise<RedisStreamQueue> {
        const queue = new RedisStreamQueue(toId, this.compressMessages, ttl ?? this.ttl);
        await this.redis.copy(this.queueKey, queue.queueKey);
        await this.redis.expire(queue.queueKey, ttl ?? this.ttl);
        return queue;
    }
}
