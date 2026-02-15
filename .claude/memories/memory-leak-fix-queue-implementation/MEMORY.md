---
name: "memory-leak-fix-queue-implementation"
description: "排查并修复 pure-graph 项目中队列实现的内存泄漏问题；发现 9 个问题，修复了 6 个（1-6），包括事件监听器泄漏、队列数据未清理、复制队列浅拷贝、临时数据结构未清理等；涵盖内存实现和 Redis 实现的修复；适用于需要排查 Node.js 异步代码内存泄漏和 EventEmitter 订阅管理的场景"
tags: ["memory-leak", "eventemitter", "async-generator", "redis", "typescript"]
category: "bug-fix"
created: "2025-01-17"
last_updated: "2025-01-17"
priority: "high"
context_scope: "project"
---

# ## 背景

## 背景

用户发现 pure-graph 项目的 queue 实现存在内存持续走高不释放的问题，需要排查 `/Users/konghayao/code/ai/pure-graph/src/queue` 和 `/Users/konghayao/code/ai/pure-graph/src/storage/memory` 目录。

## 问题分析

发现了 9 个内存泄漏问题，按优先级分类：
- **P0（严重）**：3 个 - 事件监听器泄漏、队列数据未清理、延迟删除队列
- **P1（重要）**：2 个 - 复制队列浅拷贝、fire-and-forget 异步操作
- **P2（中等）**：2 个 - Set/Map 未清理、AbortController 泄漏
- **P3（低）**：2 个 - EventEmitter3 清理、队列累积

## 修复方案（问题 1-6）

### 1. 事件监听器泄漏（P0）- 最严重

**文件**: `src/storage/memory/queue.ts` - `onDataReceive()` 方法

**问题**：异步函数提前返回、生成器未完全消费或错误中断时，事件监听器永远不会被移除。

**修复**：
```typescript
async *onDataReceive(): AsyncGeneratorEventMessage, void, unknown {
    let isCleanupDone = false;

    const handleData = async (item: EventMessage) {
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

    const cleanup = () {
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
    await LangGraphGlobal.globalMessageQueue.clearQueue(queueId);
    LangGraphGlobal.globalMessageQueue.removeQueue(queueId);
}
```

### 3. 复制队列深拷贝问题（P1）

**文件**: `src/storage/memory/queue.ts` - `copyToQueue()` 方法

**问题**：使用浅拷贝，导致新队列和原队列共享同一个数组引用。

**修复**：
```typescript
async copyToQueue(toId: string, ttl?: number): Promise</arg_value>
</tool_call>
