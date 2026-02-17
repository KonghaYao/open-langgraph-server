# ShallowMemorySaver 设计与实现文档

> **状态**: ✅ 已完成 (2026年2月)
> 
> **实现文件**: `src/storage/memory/shallow-memory.ts`
> 
> **测试文件**: `test/storage/shallow-memory.test.ts` (23个测试全部通过)

## 1. 背景

当前项目中，`MemorySaver`（`src/storage/memory/checkpoint.ts`）是完整的内存检查点保存器实现，它支持：
- 保留所有历史 checkpoint
- 每个线程可以有多个 checkpoint 版本
- 完整的 pending writes 支持

然而，对于某些简单场景（如开发测试、单次对话），我们只需要保留最新的 checkpoint，不需要完整的历史记录。参考 Redis 的 `ShallowRedisSaver` 实现，我们实现了 `ShallowMemorySaver`。

## 2. 实现状态

✅ **已完成** - 2026年2月

### 文件清单

| 文件 | 说明 |
|-----|------|
| `src/storage/memory/shallow-memory.ts` | ShallowMemorySaver 核心实现 |
| `test/storage/shallow-memory.test.ts` | 23 个单元测试（全部通过） |
| `src/storage/index.ts` | 导出和环境变量支持 |

## 3. 功能对比

### 3.1 与 ShallowRedisSaver 对比

| 功能 | ShallowRedisSaver | ShallowMemorySaver | 状态 |
|-----|-------------------|-------------------|------|
| **put()** | ✅ | ✅ | 一致 |
| - 覆盖旧 checkpoint | ✅ | ✅ | 一致 |
| - 自动清理旧 writes | ✅ | ✅ | 一致 |
| - 使用 `uuid6(0)` 生成 ID | ✅ | ✅ | 一致 |
| - 错误消息 `'thread_id is required'` | ✅ | ✅ | 一致 |
| **getTuple()** | ✅ | ✅ | 一致 |
| - checkpoint_id 严格匹配 | ✅ | ✅ | 一致 |
| - 返回 undefined（不匹配时） | ✅ | ✅ | 一致 |
| **get()** | ✅ | ✅ | 一致 |
| **list()** | ✅ | ✅ | 一致 |
| - 按 timestamp 降序排序 | ✅ | ✅ | 一致 |
| - filter 元数据过滤 | ✅ | ✅ | 一致 |
| - 深度对象比较 | ✅ | ✅ | 一致 |
| - null 值过滤 | ✅ | ✅ | 一致 |
| - limit 支持 | ✅ | ✅ | 一致 |
| - before 支持 | ✅ | ✅ | 一致 |
| **putWrites()** | ✅ | ✅ | 一致 |
| - 错误消息合并 | ✅ | ✅ | 一致 |
| **deleteThread()** | ✅ | ✅ | 一致 |
| **v < 4 迁移** | ✅ | ✅ | 一致 |

### 3.2 预期差异

| 差异 | ShallowRedisSaver | ShallowMemorySaver |
|-----|-------------------|-------------------|
| 存储后端 | Redis JSON | 内存对象 |
| TTL 支持 | ✅ | ❌ (不需要) |
| 索引管理 | ✅ (ensureIndexes) | ❌ (不需要) |
| end() 方法 | ✅ (关闭连接) | ❌ (不需要) |

### 3.3 与 MemorySaver 对比

| 场景 | MemorySaver | ShallowMemorySaver |
|-----|-------------|-------------------|
| 内存占用 | 保留所有历史，占用较大 | 仅保留最新，占用最小 |
| 时间旅行 | ✅ 支持 | ❌ 不支持 |
| 回滚 | ✅ 支持 | ❌ 不支持 |
| 简单对话 | 可用但浪费 | ✅ 最佳选择 |
| 测试场景 | 可用 | ✅ 推荐 |

## 4. 架构设计

### 4.1 数据结构

```typescript
export class ShallowMemorySaver extends BaseCheckpointSaver {
    // 存储结构: thread_id -> checkpoint_ns -> checkpoint 数据
    // 每个组合只保留一个 checkpoint
    storage: Record<
        string,  // thread_id
        Record<
            string,  // checkpoint_ns
            {
                checkpoint: Uint8Array;      // 序列化的 checkpoint
                metadata: Uint8Array;        // 序列化的 metadata
                checkpoint_id: string;       // checkpoint ID
                parent_checkpoint_id: string | undefined;  // 父 checkpoint ID
                checkpoint_ts: number;       // 时间戳（用于排序）
            }
        >
    > = {};

    // writes 存储: 复合键 -> writes 数据
    // 键格式: `${thread_id}::${checkpoint_ns}::${checkpoint_id}`
    writes: Record<
        string,  // composite key
        Record<
            string,  // `${taskId},${idx}`
            [string, string, Uint8Array]  // [taskId, channel, serializedValue]
        >
    > = {};
}
```

### 4.2 键生成策略

```typescript
// 生成 shallow 存储键（不含 checkpoint_id）
function _getShallowKey(threadId: string, checkpointNamespace: string): string {
    return `${threadId}::${checkpointNamespace}`;
}

// 生成 writes 存储键（含 checkpoint_id）
function _getWritesKey(threadId: string, checkpointNs: string, checkpointId: string): string {
    return `${threadId}::${checkpointNs}::${checkpointId}`;
}
```

## 5. API 文档

### 5.1 构造函数

```typescript
constructor(serde?: SerializerProtocol)
```

### 5.2 get()

```typescript
async get(config: RunnableConfig): Promise<Checkpoint | undefined>
```

便捷方法，仅返回 checkpoint 而不包含 metadata。

### 5.3 getTuple()

```typescript
async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>
```

**行为：**
- 如果未指定 `checkpoint_id`，返回最新的 checkpoint
- 如果指定了 `checkpoint_id`：
  - 匹配最新 checkpoint 的 ID → 返回该 checkpoint
  - 不匹配最新 checkpoint 的 ID → 返回 `undefined`

### 5.4 put()

```typescript
async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions?: ChannelVersions
): Promise<RunnableConfig>
```

**行为：**
- 存储最新的 checkpoint，覆盖同一线程/命名空间的旧 checkpoint
- 自动清理旧的 pending writes
- 如果 checkpoint.id 为空，使用 `uuid6(0)` 生成

### 5.5 list()

```typescript
async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
): AsyncGenerator<CheckpointTuple>
```

**行为：**
- 遍历所有线程/命名空间
- 每个线程/命名空间只返回一个 checkpoint（最新的）
- 按 `checkpoint_ts` 降序排序（最新的在前）
- 支持 `filter`、`limit`、`before` 参数
- 支持深度对象比较和 null 值过滤

### 5.6 putWrites()

```typescript
async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
): Promise<void>
```

**行为：**
- 与完整版相同的逻辑
- 将 writes 存储到当前 checkpoint 下
- 支持 WRITES_IDX_MAP 确定性写入

### 5.7 deleteThread()

```typescript
async deleteThread(threadId: string): Promise<void>
```

**行为：**
- 删除指定线程的所有 checkpoint
- 删除指定线程的所有 writes

## 6. 使用示例

### 6.1 基本使用

```typescript
import { ShallowMemorySaver } from '@langgraph-js/pure-graph';

// 创建 saver
const checkpointer = new ShallowMemorySaver();

// 在图中使用
const graph = workflow.compile({ checkpointer });
```

### 6.2 通过环境变量

```bash
# 设置环境变量
CHECKPOINT_TYPE=shallow/memory
```

```typescript
// 自动使用 ShallowMemorySaver
import { LangGraphGlobal } from '@langgraph-js/pure-graph';

await LangGraphGlobal.initGlobal();
// 如果 CHECKPOINT_TYPE=shallow/memory，将使用 ShallowMemorySaver
```

### 6.3 完整示例

```typescript
import { ShallowMemorySaver } from '@langgraph-js/pure-graph';
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph';

// 创建 checkpointer
const checkpointer = new ShallowMemorySaver();

// 创建图
const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', agentNode)
    .addEdge('__start__', 'agent')
    .compile({ checkpointer });

// 使用
const config = { configurable: { thread_id: 'user-123' } };
await graph.invoke({ messages: [new HumanMessage('Hello')] }, config);

// 只有最新的 checkpoint 会被保留
```

## 7. 测试覆盖

### 7.1 测试统计

- **总测试数**: 23
- **通过**: 23
- **失败**: 0
- **expect() 调用**: 47

### 7.2 测试用例

| 分类 | 测试用例 |
|-----|---------|
| **put() 和 getTuple()** | 存储和检索 checkpoint |
| | 只保留最新 checkpoint（shallow 行为） |
| | checkpoint_id 不匹配返回 undefined |
| | checkpoint_id 匹配返回 checkpoint |
| | namespace 隔离 |
| | 缺少 thread_id 抛出错误 |
| **list()** | 列出所有 checkpoint |
| | 按 thread_id 过滤 |
| | 按 namespace 过滤 |
| | 按 metadata 过滤 |
| | limit 限制 |
| | 只返回每个线程/命名空间一个 checkpoint |
| | 按时间戳降序排序 |
| **putWrites()** | 存储 pending writes |
| | 新 checkpoint 时清理旧 writes |
| | 缺少参数抛出错误 |
| **deleteThread()** | 删除线程所有数据 |
| | 不影响其他线程 |
| **父 checkpoint 追踪** | 追踪父 checkpoint ID |
| **get() 便捷方法** | 仅返回 checkpoint |
| | checkpoint 不存在返回 undefined |
| **复杂 metadata 过滤** | 深度对象比较 |
| | null 值过滤 |

## 8. 实现细节

### 8.1 序列化

使用 `BaseCheckpointSaver` 提供的 `serde` 进行序列化：

```typescript
// 序列化
const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
    this.serde.dumpsTyped(preparedCheckpoint),
    this.serde.dumpsTyped(metadata),
]);

// 反序列化
const checkpoint = await this.serde.loadsTyped('json', serializedCheckpoint);
const metadata = await this.serde.loadsTyped('json', serializedMetadata);
```

### 8.2 v < 4 迁移处理

与完整版相同，处理 v < 4 的 checkpoint 的 pending sends 迁移：

```typescript
async _migratePendingSends(
    mutableCheckpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
): Promise<void>
```

### 8.3 深度 Metadata 过滤

支持深度对象比较，使用 `deterministicStringify` 函数：

```typescript
private _checkMetadataFilterMatch(metadata: any, filter: CheckpointMetadata): boolean {
    for (const [key, value] of Object.entries(filter)) {
        const metadataValue = metadata?.[key];

        if (value === null) {
            // null 值特殊处理
            if (!(key in (metadata || {})) || metadataValue !== null) {
                return false;
            }
        } else if (typeof value === 'object' && !Array.isArray(value)) {
            // 深度对象比较
            if (deterministicStringify(value) !== deterministicStringify(metadataValue)) {
                return false;
            }
        } else if (metadataValue !== value) {
            return false;
        }
    }
    return true;
}
```

## 9. 注意事项

1. **API 兼容性**: 与 `MemorySaver` 和 `ShallowRedisSaver` 保持相同的 API 接口
2. **序列化一致性**: 使用相同的 serde 机制
3. **错误处理**: 与 ShallowRedisSaver 保持一致的错误信息
4. **类型安全**: 完整的 TypeScript 类型定义
5. **无持久化**: 数据仅存在于内存中，进程重启后丢失

## 10. 参考实现

- 完整版 MemorySaver: `src/storage/memory/checkpoint.ts`
- ShallowRedisSaver: `src/storage/memory/shallow.ts`（注意：此文件实际是 Redis shallow 实现的参考代码）
- LangGraph Checkpointer 接口: `@langchain/langgraph-checkpoint`
