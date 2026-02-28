# Thread Title 自动生成功能设计

## 1. 功能概述

在 Graph 第一次更新状态时，自动从 `messages` 字段的第一个消息中提取内容，取前 15 个字符作为会话标题（title），并存储到数据库。

### 核心需求
- **触发时机**：Graph 第一次更新 state 时
- **数据来源**：state.messages[0].content
- **处理逻辑**：取前 15 个字符作为标题
- **可扩展性**：支持全局替换标题生成函数

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                 API Endpoint Layer                       │
│              (createEndpoint.runs.stream)               │
├─────────────────────────────────────────────────────────┤
│              Title Generation Hook                       │
│  1. 流结束后检测 thread.title                            │
│  2. 从最终 state 提取标题                                │
│  3. 调用标题生成函数                                      │
│  4. 更新 Thread.title                                    │
├─────────────────────────────────────────────────────────┤
│              ThreadsManager                              │
│              (存储到数据库)                               │
├─────────────────────────────────────────────────────────┤
│              Graph Stream Layer                          │
│              (streamState)                               │
└─────────────────────────────────────────────────────────┘
```

**设计原则**：
- ✅ 集成到 API 层而非流处理层，避免增加流处理的复杂度
- ✅ 在流结束后统一处理，不侵入核心流程
- ✅ 失败不影响用户获取流数据

**执行流程**：
```
用户调用 runs.stream()
    ↓
配置 graph_id 和 thread_id
    ↓
创建 Run 记录
    ↓
执行 streamState() ← 原有流程不变
    ↓ (流结束)
generateThreadTitle()
    ├─ 检查 thread.title 是否存在
    ├─ 从 thread.values 获取 state
    ├─ 调用全局标题生成器
    └─ 保存标题到数据库
    ↓
返回（标题生成失败不影响）
```

## 3. 数据库设计

### 3.1 表结构更新

**threads 表** 已有 title 字段（见 `src/storage/kysely/types.ts`）：

```typescript
export interface ThreadsTable {
    thread_id: string;
    created_at: Date;
    updated_at: Date;
    metadata: Record<string, any>;
    status: string;
    values: any;
    interrupts: Record<string, any>;
    title: string | null;  // ✅ 已存在
}
```

### 3.2 迁移脚本

只需添加字段，不处理历史数据（现有 thread 保持 title 为 null）：

**PostgreSQL:**
```sql
ALTER TABLE threads ADD COLUMN IF NOT EXISTS title TEXT;
```

**SQLite:**
```sql
ALTER TABLE threads ADD COLUMN title TEXT;
```

**注意**：历史 thread 的 title 保持 null，只有新运行的 thread 会自动生成标题。

## 4. 核心实现

### 4.1 标题生成函数类型定义

创建文件：`src/utils/titleGenerator.ts`

```typescript
/**
 * 标题生成函数类型
 * @param state Graph 的 state 对象
 * @param context 上下文信息（thread_id, graph_id 等）
 * @returns 生成的标题，返回 null 表示不生成标题
 */
export type TitleGenerator = (
    state: Record<string, any>,
    context: {
        thread_id: string;
        graph_id: string;
        run_id: string;
    }
) => Promise<string | null> | string | null;

/**
 * 默认标题生成器
 * 从 messages[0].content 提取前 15 个字符
 */
export const defaultTitleGenerator: TitleGenerator = (state, context) => {
    const messages = state?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return null;
    }

    const firstMessage = messages[0];
    let content: string;

    // 处理不同类型的 content
    if (typeof firstMessage.content === 'string') {
        content = firstMessage.content;
    } else if (Array.isArray(firstMessage.content)) {
        // 处理多部分内容（如图片+文本）
        const textPart = firstMessage.content.find(part => part.type === 'text');
        content = textPart?.text || '';
    } else if (firstMessage.content?.text) {
        content = firstMessage.content.text;
    } else {
        return null;
    }

    // 清理并截取前 15 个字符
    const cleanedContent = content.trim().replace(/\n/g, ' ');
    if (!cleanedContent) {
        return null;
    }

    // 截取前 15 个字符（支持多字节字符）
    const title = cleanedContent.slice(0, 15);
    return title.length < cleanedContent.length ? `${title}...` : title;
};
```

### 4.2 全局标题生成器管理

在 `src/global.ts` 中添加：

```typescript
import { TitleGenerator, defaultTitleGenerator } from './utils/titleGenerator.js';

export class LangGraphGlobal {
    // ... 现有代码 ...
    
    /**
     * 全局标题生成器
     * 可通过 setTitleGenerator 替换
     */
    private static _titleGenerator: TitleGenerator = defaultTitleGenerator;

    /**
     * 设置自定义标题生成器
     */
    static setTitleGenerator(generator: TitleGenerator): void {
        LangGraphGlobal._titleGenerator = generator;
    }

    /**
     * 获取当前标题生成器
     */
    static getTitleGenerator(): TitleGenerator {
        return LangGraphGlobal._titleGenerator;
    }
}
```

### 4.3 标题生成工具函数

创建文件：`src/utils/titleGeneratorHelper.ts`

```typescript
import { BaseThreadsManager } from '../threads/index.js';
import { LangGraphGlobal } from '../global.js';

/**
 * 为 thread 生成并保存标题
 * 在流结束后调用，避免侵入流处理逻辑
 *
 * 并发安全：使用 setTitleIfNull 原子操作，避免 TOCTOU 问题
 */
export async function generateThreadTitle(
    threads: BaseThreadsManager,
    threadId: string,
    graphId: string,
    runId: string,
): Promise<void> {
    const logContext = { threadId, graphId, runId };

    try {
        // 1. 获取 thread 以检查是否有 messages
        const thread = await threads.get(threadId);
        const state = thread.values;

        // 没有消息则跳过
        if (!state?.messages || !Array.isArray(state.messages) || state.messages.length === 0) {
            return;
        }

        // 2. 调用全局标题生成器
        const titleGenerator = LangGraphGlobal.getTitleGenerator();
        const title = await titleGenerator(state, {
            thread_id: threadId,
            graph_id: graphId,
            run_id: runId,
        });

        // 3. 使用原子操作保存标题（仅当标题为空时）
        if (title) {
            const success = await threads.setTitleIfNull(threadId, title);
            if (!success) {
                // 已有标题，跳过（正常情况，非错误）
                return;
            }
        }
    } catch (error) {
        // 标题生成失败不应影响主流程
        console.warn('Failed to generate thread title:', {
            ...logContext,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
```

**并发安全设计**：
- 使用 `setTitleIfNull` 原子操作，在数据库层面确保只有当 `title IS NULL` 时才更新
- 避免 TOCTOU (Time-of-check to Time-of-use) 并发问题

### 4.4 集成到 API 端点

修改 `src/createEndpoint.ts` 中的 `runs.stream` 方法：

```typescript
import { generateThreadTitle } from './utils/titleGeneratorHelper.js';

export const createEndpoint = () => {
    const getThreads = () => {
        return LangGraphGlobal.globalThreadsManager;
    };
    
    return {
        // ... 其他代码 ...
        
        runs: {
            // ... 其他方法 ...

            async *stream(threadId: string, assistantId: string, payload: StreamInputData) {
                payload.config = {
                    ...(payload.config ?? {}),
                    configurable: {
                        ...(payload.config?.configurable ?? {}),
                        graph_id: assistantId,
                        thread_id: threadId,
                    },
                };
                const threads = getThreads();
                const runPromise = threads.createRun(threadId, assistantId, payload);

                try {
                    // 执行流处理
                    for await (const data of streamState(
                        threads,
                        runPromise,
                        payload,
                        {
                            attempt: 0,
                            getGraph,
                        },
                    )) {
                        yield data;
                    }

                    // 🔥 流结束后生成标题
                    const run = await runPromise;
                    await generateThreadTitle(
                        threads,
                        threadId,
                        assistantId,
                        run.run_id,
                    );
                } catch (error) {
                    // 即使流失败，也尝试生成标题
                    try {
                        const run = await runPromise;
                        await generateThreadTitle(
                            threads,
                            threadId,
                            assistantId,
                            run.run_id,
                        );
                    } catch {
                        // 忽略标题生成错误
                    }
                    throw error;
                }
            },
            
            // ... 其他方法 ...
        },
    };
};
```

**优势**：
- ✅ 不侵入 `streamState` 核心流程
- ✅ 在流完全结束后执行，不影响性能
- ✅ 即使流失败也尝试生成标题（如果已有部分 state）
- ✅ 错误隔离，标题生成失败不影响流数据返回

## 5. ThreadsManager 更新

### 5.1 接口更新

修改 `src/threads/index.ts`：

```typescript
export interface BaseThreadsManager<ValuesType = unknown> {
    // ... 现有方法 ...

    /**
     * 原子性地设置标题（仅当标题为空时）
     * 用于解决并发条件下的 TOCTOU 问题
     * @returns 是否成功设置（true 表示设置成功，false 表示已有标题）
     */
    setTitleIfNull(threadId: string, title: string): Promise<boolean>;
}
```

**设计说明**：
- `setTitleIfNull` 使用数据库层面的条件更新，确保并发安全
- 返回布尔值表示是否成功设置，调用方可据此判断

### 5.2 Kysely 实现

修改 `src/storage/kysely/threads.ts`：

```typescript
async setTitleIfNull(threadId: string, title: string): Promise<boolean> {
    const result = await this.db
        .updateTable('threads')
        .set({
            title,
            updated_at: this.adapter.dateToDb(new Date()),
        })
        .where('thread_id', '=', threadId)
        .where('title', 'is', null)  // 关键：仅当 title 为 null 时更新
        .executeTakeFirst();

    // numUpdatedRows 表示实际更新的行数
    return result.numUpdatedRows > 0n;
}
```

**并发安全原理**：
- SQL 语句 `WHERE title IS NULL` 确保只有当标题为空时才执行更新
- 数据库层面的原子性保证，即使多个并发请求也只有第一个会成功

### 5.3 更新查询接口

修改 `search` 和 `get` 方法以支持 title 字段：

```typescript
async get(threadId: string): Promise<Thread<ValuesType> & { title?: string | null }> {
    const row = await this.db
        .selectFrom('threads')
        .selectAll()
        .where('thread_id', '=', threadId)
        .executeTakeFirst();

    if (!row) {
        throw new Error(`Thread with ID ${threadId} not found.`);
    }

    return {
        thread_id: row.thread_id,
        created_at: this.adapter.dbToDate(row.created_at).toISOString(),
        updated_at: this.adapter.dbToDate(row.updated_at).toISOString(),
        metadata: this.adapter.dbToJson(row.metadata),
        status: row.status as ThreadStatus,
        values: row.values ? this.adapter.dbToJson(row.values) : (null as unknown as ValuesType),
        interrupts: this.adapter.dbToJson(row.interrupts),
        title: row.title, // 🔥 新增
    };
}
```

## 6. 使用示例

### 6.1 使用默认标题生成器

```typescript
import { LangGraphGlobal } from '@langgraph-js/pure-graph';

// 初始化（会自动使用默认生成器）
await LangGraphGlobal.initGlobal();

// Graph 运行时，首次更新会自动生成标题
```

### 6.2 自定义标题生成器

```typescript
import { LangGraphGlobal } from '@langgraph-js/pure-graph';

// 设置自定义标题生成器
LangGraphGlobal.setTitleGenerator(async (state, context) => {
    const messages = state?.messages;
    if (!messages?.length) return null;

    // 自定义逻辑：使用 AI 生成标题
    const firstMessage = messages[0];
    const content = typeof firstMessage.content === 'string' 
        ? firstMessage.content 
        : firstMessage.content.text;

    // 可以调用 LLM 生成更智能的标题
    const title = await generateTitleWithAI(content);
    return title;
});
```

### 6.3 禁用标题生成

```typescript
import { LangGraphGlobal } from '@langgraph-js/pure-graph';

// 设置为 null 来禁用
LangGraphGlobal.setTitleGenerator(() => null);
```

## 7. 测试计划

### 7.1 单元测试

创建文件：`test/title-generator.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { defaultTitleGenerator } from '../src/utils/titleGenerator';

describe('TitleGenerator', () => {
    it('should extract title from string content', () => {
        const state = {
            messages: [{ content: '这是一段很长的文本内容，用于测试标题提取功能是否正常工作' }]
        };
        const result = defaultTitleGenerator(state, { thread_id: '1', graph_id: 'g1', run_id: 'r1' });
        expect(result).toBe('这是一段很长的文本内容，用...');
    });

    it('should handle empty messages', () => {
        const state = { messages: [] };
        const result = defaultTitleGenerator(state, { thread_id: '1', graph_id: 'g1', run_id: 'r1' });
        expect(result).toBeNull();
    });

    it('should handle multi-part content', () => {
        const state = {
            messages: [{
                content: [
                    { type: 'image', image: 'url' },
                    { type: 'text', text: '这是文本部分' }
                ]
            }]
        };
        const result = defaultTitleGenerator(state, { thread_id: '1', graph_id: 'g1', run_id: 'r1' });
        expect(result).toBe('这是文本部分');
    });

    it('should handle short content', () => {
        const state = {
            messages: [{ content: '短文本' }]
        };
        const result = defaultTitleGenerator(state, { thread_id: '1', graph_id: 'g1', run_id: 'r1' });
        expect(result).toBe('短文本');
    });
});
```

### 7.2 集成测试

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { KyselyThreadsManager } from '../src/storage/kysely/threads';
import { SQLiteAdapter } from '../src/storage/kysely/sqlite-adapter';
import { LangGraphGlobal } from '../src/global';
import { generateThreadTitle } from '../src/utils/titleGeneratorHelper';

describe('Thread Title Integration', () => {
    let threadsManager: KyselyThreadsManager;

    beforeEach(async () => {
        // 初始化内存数据库
        const adapter = new SQLiteAdapter(':memory:');
        threadsManager = new KyselyThreadsManager(adapter);
        await threadsManager.setup();
        LangGraphGlobal.globalThreadsManager = threadsManager as any;
    });

    it('should generate title after state update', async () => {
        // 创建 thread
        const thread = await threadsManager.create({ threadId: 'test-1' });
        
        // 模拟流结束后 state 被保存
        await threadsManager.set('test-1', {
            values: { messages: [{ content: '用户提问的内容用于测试标题生成' }] }
        });

        // 调用标题生成
        await generateThreadTitle(
            threadsManager,
            'test-1',
            'test-graph',
            'test-run-1'
        );

        // 验证标题已生成
        const updated = await threadsManager.get('test-1');
        expect(updated.title).toBe('用户提问的内容用于测试...');
    });

    it('should not override existing title', async () => {
        // 创建 thread 并设置初始 title
        const thread = await threadsManager.create({ threadId: 'test-2' });
        await threadsManager.set('test-2', { title: '已有标题' } as any);

        // 模拟 state 更新
        await threadsManager.set('test-2', {
            values: { messages: [{ content: '新的内容' }] }
        });

        // 调用标题生成
        await generateThreadTitle(
            threadsManager,
            'test-2',
            'test-graph',
            'test-run-2'
        );

        // 验证标题未被覆盖
        const updated = await threadsManager.get('test-2');
        expect(updated.title).toBe('已有标题');
    });

    it('should handle empty messages gracefully', async () => {
        const thread = await threadsManager.create({ threadId: 'test-3' });
        await threadsManager.set('test-3', {
            values: { messages: [] }
        });

        await generateThreadTitle(
            threadsManager,
            'test-3',
            'test-graph',
            'test-run-3'
        );

        const updated = await threadsManager.get('test-3');
        expect(updated.title).toBeNull();
    });

    it('should use custom title generator when set', async () => {
        // 设置自定义生成器
        LangGraphGlobal.setTitleGenerator(async (state) => {
            return 'Custom Title';
        });

        const thread = await threadsManager.create({ threadId: 'test-4' });
        await threadsManager.set('test-4', {
            values: { messages: [{ content: '任意内容' }] }
        });

        await generateThreadTitle(
            threadsManager,
            'test-4',
            'test-graph',
            'test-run-4'
        );

        const updated = await threadsManager.get('test-4');
        expect(updated.title).toBe('Custom Title');
    });
});
```

## 8. 数据库迁移

### 8.1 添加字段

**仅需添加 title 字段，不需要处理历史数据：**

**PostgreSQL:**
```sql
ALTER TABLE threads ADD COLUMN IF NOT EXISTS title TEXT;
```

**SQLite:**
```sql
ALTER TABLE threads ADD COLUMN title TEXT;
```

**Memory Adapter:**
无需迁移，类型定义中已有 title 字段。

### 8.2 历史数据处理

- ❌ 不需要为历史 thread 生成标题
- ✅ 历史线程的 title 字段保持 null
- ✅ 只有新运行的 thread 会自动生成标题

### 8.3 升级步骤

1. 添加数据库字段（如使用 PostgreSQL/SQLite）
2. 更新代码版本
3. （可选）设置自定义标题生成器

## 9. 性能考虑

### 9.1 优化策略

- **延迟生成**：仅在首次更新时生成，避免每次更新都检查
- **异步执行**：标题生成失败不影响主流程
- **缓存检查**：通过 `thread.title` 快速判断是否需要生成

### 9.2 性能影响

- 额外的 `threads.get()` 调用（仅在首次更新时）
- 标题生成函数执行时间（通常 < 1ms）
- 一次额外的数据库更新操作

## 10. 未来扩展

### 10.1 可能的增强

1. **AI 生成标题**：集成 LLM 生成更语义化的标题
2. **标题模板**：支持基于 graph 类型的不同模板
3. **多语言支持**：针对不同语言的优化截断
4. **标题更新策略**：支持定期或手动更新标题

### 10.2 配置选项

```typescript
interface TitleGeneratorConfig {
    enabled: boolean;
    maxLength: number;
    ellipsis: string;
    fallbackTitle: string;
    updateExisting: boolean;
}
```

## 11. 实施步骤

### Phase 1: 基础实现（核心功能）
1. ✅ 创建 `src/utils/titleGenerator.ts` - 标题生成器类型和默认实现
2. ✅ 创建 `src/utils/titleGeneratorHelper.ts` - 标题生成辅助函数
3. ✅ 更新 `src/global.ts` - 添加全局标题生成器管理
4. ✅ 修改 `src/createEndpoint.ts` - 在 `runs.stream` 结束后调用标题生成

### Phase 2: 数据库支持
1. ✅ 更新类型定义（`src/storage/kysely/types.ts` 已有 title 字段）
2. ✅ 更新 `KyselyThreadsManager.set()` 支持 title 字段
3. ✅ 更新 `KyselyThreadsManager.get()` 和 `search()` 返回 title
4. ✅ 更新 `MemoryThreadsManager` 支持 title
5. ✅ 更新 `RemoteKyselyThreadsManager` 支持 title
6. ✅ 添加 SQLite 迁移脚本（幂等添加 title 列）

### Phase 3: 测试与文档
1. ✅ 编写单元测试（`test/title-generator.test.ts`）
2. ✅ 编写集成测试（`test/api/threads.test.ts` 添加 title 验证）
3. ⏳ 更新 API 文档
4. ⏳ 更新 AGENTS.md

## 12. 风险与缓解

| 风险 | 影响 | 缓解措施 | 状态 |
|------|------|----------|------|
| 标题生成失败导致流程中断 | 高 | 使用 try-catch，失败不影响主流程 | ✅ 已实施 |
| 并发条件下的 TOCTOU 问题 | 高 | 使用 `setTitleIfNull()` 原子操作 | ✅ 已实施 |
| 数据库迁移失败 | 高 | 提供幂等迁移脚本，测试多种环境 | ✅ 已实施 |
| 自定义生成器性能问题 | 中 | 文档中提供性能建议 | ⏳ 待完善 |
| 多字节字符截断问题 | 低 | 使用正确的字符串切片方法 | ✅ 已实施 |
| 调试日志遗留 | 低 | 代码审查中移除 `console.log` | ✅ 已修复 |

## 13. 相关文件

### 需要创建的文件
- `src/utils/titleGenerator.ts` - 标题生成器类型和默认实现
- `src/utils/titleGeneratorHelper.ts` - 标题生成辅助函数
- `test/title-generator.test.ts` - 单元测试

### 需要修改的文件
- `src/global.ts` - 添加全局标题生成器管理
- `src/createEndpoint.ts` - 在 `runs.stream` 结束后调用标题生成
- `src/storage/kysely/threads.ts` - 支持 title 字段的读写
- `src/storage/kysely/types.ts` - 已有 title 字段，无需修改
- `src/threads/index.ts` - Thread 类型添加 title 字段
- `src/storage/memory/threads.ts` - 支持 title 字段（可选）

### 数据库变更
- PostgreSQL/SQLite: 需添加 `title TEXT` 字段（可用 `ALTER TABLE`）
- Memory: 无需迁移，类型定义已支持

## 14. 参考资料

- [LangGraph State Management](https://langchain-ai.github.io/langgraph/)
- [Kysely Query Builder](https://kysely.dev/)
- [AGENTS.md - 项目架构文档](../AGENTS.md)
