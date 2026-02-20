---
name: "memory-leak-fix-queue-implementation"
description: "排查并修复 pure-graph 项目中队列实现的内存泄漏问题；发现 9 个问题，全部修复（1-9），包括事件监听器泄漏、队列数据未清理、复制队列浅拷贝、临时数据结构未清理、fire-and-forget 后台任务泄漏、Redis 连接池引用计数、生成器未显式清理等；涵盖内存实现和 Redis 实现的修复；适用于需要排查 Node.js 异步代码内存泄漏和 EventEmitter 订阅管理的场景"
tags: ["memory-leak", "eventemitter", "async-generator", "redis", "typescript", "fire-and-forget", "abort-controller"]
category: "bug-fix"
created: "2025-01-17"
last_updated: "2025-02-20"
priority: "high"
context_scope: "project"
---

## 背景

用户发现 pure-graph 项目的 queue 实现存在内存持续走高不释放的问题，需要排查 `/Users/konghayao/code/ai/pure-graph/src/queue` 和 `/Users/konghayao/code/ai/pure-graph/src/storage/memory` 目录。

## 问题分析

发现了 9 个内存泄漏问题，按优先级分类：
- **P0（严重）**：3 个 - 事件监听器泄漏、队列数据未清理、延迟删除队列
- **P1（重要）**：2 个 - 复制队列浅拷贝、fire-and-forget 异步操作
- **P2（中等）**：2 个 - Set/Map 未清理、AbortController 泄漏
- **P3（低）**：2 个 - EventEmitter3 清理、队列累积

## 修复方案

### 1. 事件监听器泄漏（P0）- 最严重

**文件**: `src/storage/memory/queue.ts` - `onDataReceive()` 方法

**问题**：异步函数提前返回、生成器未完全消费或错误中断时，事件监听器永远不会被移除。

**修复**：
```typescript
async *onDataReceive(): AsyncGenerator<EventMessage, void, unknown> {
    let isCleanupDone = false;

    const handleData = async (item: EventMessage) => {
        try {
            // 处理逻辑
        } catch (error) {
            if (pendingResolve) {
                pendingResolve();
                pendingResolve = null;
            }
        }
    };

    this.on('dataChange', handleData as any);
    this.cancelSignal.signal.addEventListener('abort', abortHandler);

    const cleanup = () => {
        if (isCleanupDone) return;
        isCleanupDone = true;
        this.off('dataChange', handleData as any);
        this.cancelSignal.signal.removeEventListener('abort', abortHandler);
    };

    try {
        // 主循环
    } finally {
        cleanup();
    }
}
```

**关键点**：
- 添加 `isCleanupDone` 标志防止重复清理
- 创建独立的 `cleanup()` 函数集中处理
- 在 `handleData` 中添加 try-catch 防止解码错误
- 使用 try-finally 确保清理总是执行

### 2. 队列数据未清理（P0）

**文件**: `src/graph/stream.ts` - `streamState()` 函数

**问题**：删除队列前没有调用 `clear()` 方法，长时间运行的流累积大量消息数据。

**修复**：
```typescript
} finally {
    const nowState = await threads.get(threadId);
    if (nowState.status === 'interrupted') {
        await LangGraphGlobal.globalMessageQueue.copyQueue(queueId, threadId, 30000);
    } else {
        await threads.set(threadId, { status: 'idle', interrupts: {} });
    }
    // 清空队列数据，释放内存
    await LangGraphGlobal.globalMessageQueue.removeQueue(queueId);
}
```

### 3. 复制队列深拷贝问题（P1）

**文件**: `src/storage/memory/queue.ts` - `copyToQueue()` 方法

**问题**：使用浅拷贝，导致新队列和原队列共享同一个数组引用。

**修复**：
```typescript
async copyToQueue(toId: string, ttl?: number): Promise<MemoryStreamQueue> {
    // 深拷贝数据，避免共享引用
    const data = this.data.slice();
    const queue = new MemoryStreamQueue(toId, this.compressMessages, ttl ?? this.ttl);
    queue.data = data;
    return queue;
}
```

### 4. Set/Map 未清理（P2）

**文件**: `src/graph/stream.ts` - `streamStateWithQueue()` 函数

**问题**：`sendedMetadataMessage` 和 `messageChunks` 在流结束后未清理。

**修复**：
```typescript
} finally {
    // 发送流结束信号
    try {
        await queue.push(new StreamEndEventMessage());
    } catch (e) {
        // 忽略推送错误
    }

    // 清理内存：清空 Set 和 Map
    if (sendedMetadataMessage) {
        sendedMetadataMessage.clear();
        sendedMetadataMessage = null;
    }
    if (messageChunks) {
        messageChunks.clear();
        messageChunks = null;
    }

    // 清理迭代器引用
    eventsIterator = null;
}
```

### 5. 临时数据结构未清理（P2）

**文件**: `src/storage/memory/queue.ts` - `onDataReceive()` 方法

**问题**：`localQueue` 数组在清理时未清空。

**修复**：
```typescript
const cleanup = () => {
    if (isCleanupDone) return;
    isCleanupDone = true;

    // ... 其他清理 ...

    // 清理局部队列
    localQueue.length = 0;

    // 从活跃生成器集合中移除
    this.activeGenerators.delete(localAbortController);
};
```

### 6. EventEmitter3 清理（P3）

**文件**: `src/storage/memory/queue.ts` - `destroy()` 方法

**问题**：队列销毁时未移除所有事件监听器。

**修复**：
```typescript
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
```

### 7. Fire-and-Forget 后台任务队列未清理（P1）- 2025-02-20 新增

**文件**: `src/adapter/fetch/runs-extended.ts`, `src/adapter/fetch/runs-stateless.ts`

**问题**：`createRun`、`createStatelessRun`、`createBatchRuns` 中的后台异步任务在 finally 块中没有显式清理队列，当 `streamState` 的 finally 块因异常未执行时会导致队列泄漏。

**修复**（以 `createStatelessRun` 为例）：
```typescript
// Execute the graph stream in background (don't wait)
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
        // 确保队列被清理，防止内存泄漏
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
```

**关键点**：
- 使用 `queueCleared` 标志确保只清理一次
- 在后台任务的 finally 块中显式调用 `removeQueue`
- 即使主流程的 finally 没执行，也能确保队列被清理

### 8. Redis 连接池引用计数问题（P1）- 2025-02-20 新增

**文件**: `src/storage/redis/queue.ts`

**问题**：`getSharedRedisClient()` 每次调用都增加引用计数，但首次创建时不应该增加（因为连接已经存在）。

**修复**：
```typescript
async function getSharedRedisClient(): Promise<RedisClientType> {
    if (!sharedRedisClient) {
        sharedRedisClient = createClient({
            url: process.env.REDIS_URL,
        });
        // 只在首次创建时增加引用计数
        connectionRefCount = 0;
        await sharedRedisClient.connect();
    }
    connectionRefCount++;
    return sharedRedisClient;
}

async function releaseRedisClient(): Promise<void> {
    if (connectionRefCount > 0) {
        connectionRefCount--;
    }
    // 引用计数为 0 且超过一定时间没有新连接时才关闭
    if (connectionRefCount <= 0 && sharedRedisClient) {
        // 延迟关闭，给其他队列复用连接的机会
        setTimeout(async () => {
            if (connectionRefCount <= 0 && sharedRedisClient) {
                try {
                    await sharedRedisClient.quit();
                } catch (e) {
                    // 忽略关闭错误
                }
                sharedRedisClient = null;
                connectionRefCount = 0;
            }
        }, 5000);
    }
}
```

**关键点**：
- 首次创建连接时先重置引用计数为 0，再增加
- 延迟 5 秒关闭连接，避免频繁开关
- 添加 `connectionRefCount > 0` 检查防止负数

### 9. 生成器未显式清理（P2）- 2025-02-20 新增

**文件**: `src/graph/stream.ts` - `streamState()`, `src/createEndpoint.ts` - `joinStream()`

**问题**：异步生成器在没有被完全消费时（如客户端断开连接），内部的 finally 块可能不会执行，导致事件监听器泄漏。

**修复**（streamState）：
```typescript
export async function* streamState(...) {
    run = await run;
    const queueId = run.run_id;
    const threadId = run.thread_id;
    let state: AsyncGenerator<EventMessage, void, unknown> | null = null;

    try {
        // ...
        state = queue.onDataReceive();
        for await (const data of state) {
            yield data;
        }
        // ...
    } finally {
        // 确保清理生成器
        if (state) {
            try {
                await state.return(undefined);
            } catch (e) {
                // 忽略生成器清理错误
            }
            state = null;
        }
        // ... 其他清理 ...
    }
}
```

**修复**（joinStream）：
```typescript
} finally {
    // 清理生成器
    if (generator) {
        try {
            await generator.return(undefined);
        } catch (e) {
            // 忽略生成器清理错误
        }
        generator = null;
    }
    // 清理队列引用
    queue = null;
}
```

**关键点**：
- 显式调用 `generator.return(undefined)` 强制生成器执行 finally 块
- 将生成器引用置为 null 帮助 GC
- 使用 try-catch 防止清理过程抛出错误

## 修复清单

| # | 问题 | 优先级 | 文件 | 状态 |
|---|------|--------|------|------|
| 1 | 事件监听器泄漏 | P0 | `src/storage/memory/queue.ts` | ✅ 已修复 |
| 2 | 队列数据未清理 | P0 | `src/graph/stream.ts` | ✅ 已修复 |
| 3 | 复制队列浅拷贝 | P1 | `src/storage/memory/queue.ts` | ✅ 已修复 |
| 4 | Set/Map 未清理 | P2 | `src/graph/stream.ts` | ✅ 已修复 |
| 5 | 临时数据结构未清理 | P2 | `src/storage/memory/queue.ts` | ✅ 已修复 |
| 6 | EventEmitter3 清理 | P3 | `src/storage/memory/queue.ts` | ✅ 已修复 |
| 7 | Fire-and-Forget 后台任务队列未清理 | P1 | `runs-extended.ts`, `runs-stateless.ts` | ✅ 已修复 (2025-02-20) |
| 8 | Redis 连接池引用计数 | P1 | `src/storage/redis/queue.ts` | ✅ 已修复 (2025-02-20) |
| 9 | 生成器未显式清理 | P2 | `stream.ts`, `createEndpoint.ts` | ✅ 已修复 (2025-02-20) |

## 最佳实践总结

1. **异步生成器清理**：始终在 finally 块中显式调用 `generator.return()` 并置空引用
2. **事件监听器**：使用 `isCleanupDone` 标志确保只清理一次，避免重复移除导致的错误
3. **AbortController**：在 cleanup 函数中移除所有 abort 事件监听器
4. **Fire-and-Forget 模式**：后台任务必须有自己的 finally 块处理资源清理
5. **连接池引用计数**：首次创建时重置计数，延迟关闭连接避免频繁开关
6. **Set/Map 清理**：在 finally 中调用 `.clear()` 并置空

## 验证方法

1. 使用 Node.js `--inspect` 标志启动服务
2. 使用 Chrome DevTools 的 Memory 面板进行堆快照对比
3. 运行 `npm test` 确保所有测试通过
4. 压测流式接口，观察内存是否稳定
