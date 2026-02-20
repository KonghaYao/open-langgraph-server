import { CancelEventMessage, EventMessage } from '../../queue/event_message.js';
import { BaseStreamQueue } from '../../queue/stream_queue.js';
import { BaseStreamQueueInterface } from '../../queue/stream_queue.js';

/** 内存实现的消息队列，用于存储消息 */
export class MemoryStreamQueue extends BaseStreamQueue implements BaseStreamQueueInterface {
    private data: EventMessage[] = [];
    private activeGenerators: Set<AbortController> = new Set();
    private isDestroyed = false;

    async push(item: EventMessage): Promise<void> {
        if (this.isDestroyed) return;

        const data = this.compressMessages ? ((await this.encodeData(item)) as unknown as EventMessage) : item;
        this.data.push(data);
        this.emit('dataChange', data);
    }

    onDataChange(listener: (data: EventMessage) => void): () => void {
        if (this.isDestroyed) return () => {};

        this.on('dataChange', async (item) => {
            if (this.isDestroyed) return;
            listener(this.compressMessages ? ((await this.decodeData(item)) as EventMessage) : item);
        });
        return () => this.off('dataChange', listener);
    }

    /**
     * 异步生成器：支持 for await...of 方式消费队列数据
     */
    async *onDataReceive(): AsyncGenerator<EventMessage, void, unknown> {
        if (this.isDestroyed) {
            return;
        }

        // 每个生成器独立的 AbortController
        const localAbortController = new AbortController();
        this.activeGenerators.add(localAbortController);

        let localQueue: EventMessage[] = [];
        let pendingResolve: (() => void) | null = null;
        let isStreamEnded = false;
        let isCleanupDone = false;
        let endTimeoutId: ReturnType<typeof setTimeout> | null = null;

        // 事件处理函数
        const handleData = async (item: EventMessage) => {
            if (isCleanupDone || localAbortController.signal.aborted) return;

            try {
                const data = this.compressMessages ? ((await this.decodeData(item as any)) as EventMessage) : item;
                localQueue.push(data);
                // 检查是否为流结束或错误信号
                if (
                    data.event === '__stream_end__' ||
                    data.event === '__stream_error__' ||
                    data.event === '__stream_cancel__'
                ) {
                    // 清理之前的定时器
                    if (endTimeoutId) {
                        clearTimeout(endTimeoutId);
                        endTimeoutId = null;
                    }
                    endTimeoutId = setTimeout(() => {
                        isStreamEnded = true;
                        if (pendingResolve) {
                            pendingResolve();
                            pendingResolve = null;
                        }
                    }, 300);

                    if (data.event === '__stream_cancel__') {
                        localAbortController.abort('stream cancelled');
                    }
                }

                if (pendingResolve) {
                    pendingResolve();
                    pendingResolve = null;
                }
            } catch (error) {
                // 即使解码出错，也要通知等待的消费者
                console.error('Error in handleData:', error);
                if (pendingResolve) {
                    pendingResolve();
                    pendingResolve = null;
                }
            }
        };

        // 添加事件监听
        this.on('dataChange', handleData as any);

        // 监听取消信号
        const abortHandler = () => {
            isStreamEnded = true;
            if (pendingResolve) {
                pendingResolve();
                pendingResolve = null;
            }
        };
        localAbortController.signal.addEventListener('abort', abortHandler);

        // 清理函数
        const cleanup = () => {
            if (isCleanupDone) return;
            isCleanupDone = true;

            // 清理定时器
            if (endTimeoutId) {
                clearTimeout(endTimeoutId);
                endTimeoutId = null;
            }

            // 移除事件监听器
            try {
                this.off('dataChange', handleData as any);
            } catch (e) {
                // 忽略错误
            }

            // 移除 abort 监听器
            try {
                localAbortController.signal.removeEventListener('abort', abortHandler);
            } catch (e) {
                // 忽略错误
            }

            // 清理 pending promise
            if (pendingResolve) {
                pendingResolve();
                pendingResolve = null;
            }

            // 清理局部队列
            localQueue.length = 0;

            // 从活跃生成器集合中移除
            this.activeGenerators.delete(localAbortController);
        };

        try {
            // 检查是否已取消
            if (localAbortController.signal.aborted || this.isDestroyed) {
                return;
            }

            while (!isStreamEnded && !localAbortController.signal.aborted && !this.isDestroyed) {
                if (localQueue.length > 0) {
                    for (const item of localQueue) {
                        yield item;
                    }
                    localQueue.length = 0;
                } else {
                    await new Promise((resolve) => {
                        pendingResolve = resolve as () => void;
                    });
                }
            }
        } finally {
            // 确保清理总是执行
            cleanup();
        }
    }

    async getAll(): Promise<EventMessage[]> {
        if (this.isDestroyed) return [];

        return this.compressMessages
            ? ((await Promise.all(
                  this.data.map((i) => this.decodeData(i as unknown as string | Uint8Array)),
              )) as unknown as EventMessage[])
            : [...this.data];
    }

    clear(): void {
        this.data.length = 0;
    }

    public cancelSignal = new AbortController();

    async cancel(): Promise<void> {
        // 取消所有活跃的生成器
        for (const controller of this.activeGenerators) {
            try {
                controller.abort('user cancel this run');
            } catch (e) {
                // 忽略错误
            }
        }
        this.activeGenerators.clear();

        // 同时取消全局信号
        if (!this.cancelSignal.signal.aborted) {
            this.cancelSignal.abort('user cancel this run');
        }

        // 推送取消消息
        if (!this.isDestroyed) {
            await this.push(new CancelEventMessage());
        }
    }

    async copyToQueue(toId: string, ttl?: number): Promise<MemoryStreamQueue> {
        // 深拷贝数据，避免共享引用
        const data = this.data.slice();
        const queue = new MemoryStreamQueue(toId, this.compressMessages, ttl ?? this.ttl);
        queue.data = data;
        return queue;
    }

    /**
     * 销毁队列，释放所有资源
     */
    async destroy(): Promise<void> {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        // 取消所有活跃的生成器
        await this.cancel();

        // 清空数据
        this.clear();

        // 移除所有事件监听器
        this.removeAllListeners();

        // 清空活跃生成器集合
        this.activeGenerators.clear();
    }
}
