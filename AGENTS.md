# AI Agents 系统

本项目提供了一套完整的 AI Agents 开发系统，支持在 LangGraph 框架中创建和管理多代理协作系统。

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    Framework Adapters                   │
│  (Next.js, Hono.js, Fetch API - Cloudflare/Deno/etc.)   │
├─────────────────────────────────────────────────────────┤
│                    Core Implementation                   │
│              createEndpoint, Graph Execution             │
├─────────────────────────────────────────────────────────┤
│              Storage & Queue Layer                       │
│  Checkpointer | ThreadsManager | StreamQueue             │
├─────────────────────────────────────────────────────────┤
│                    Agents System                         │
│              ask_subagents, Graph Registry              │
└─────────────────────────────────────────────────────────┘
```

## 核心模块

### 1. 全局状态管理 (`global.ts`)

**LangGraphGlobal**: 单例类，管理全局组件

```typescript
export class LangGraphGlobal {
    // 消息队列管理器
    static globalMessageQueue: StreamQueueManager<BaseStreamQueueInterface>

    // 检查点保存器（状态持久化）
    static globalCheckPointer: BaseCheckpointSaver

    // 线程管理器
    static globalThreadsManager: BaseThreadsManager

    // 初始化全局组件
    static async initGlobal(): Promise<void>
}
```

**存储后端选择优先级**：
1. Redis (if `REDIS_URL` set and `CHECKPOINT_TYPE` matches)
2. PostgreSQL (if `DATABASE_URL` set)
3. SQLite (if `SQLITE_DATABASE_URI` set)
4. Memory (fallback default)

### 2. 图注册系统 (`utils/getGraph.ts`)

```typescript
// 图注册表
export const GRAPHS: Record<string, CompiledGraph<string> | CompiledGraphFactory<string>>;

// 注册图
export async function registerGraph(
    graphId: string,
    graph: CompiledGraph | CompiledGraphFactory
)

// 获取图实例
export async function getGraph(
    graphId: string,
    config: LangGraphRunnableConfig,
    options?: { checkpointer?: BaseCheckpointSaver | null; store?: BaseStore }
)
```

### 3. 端点创建 (`createEndpoint.ts`)

创建标准的 LangGraph API 端点：

```typescript
export const createEndpoint = () => ({
    assistants: {
        search(): Promise<Assistant[]>
        getGraph(assistantId): Promise<AssistantGraph>
    },
    threads: BaseThreadsManager,
    runs: {
        list(): Promise<Run[]>
        cancel(): Promise<void>
        stream(): AsyncGenerator<EventMessage>
        joinStream(): AsyncGenerator<{ event: StreamEvent; data: any }>
    }
})
```

### 4. 流处理引擎 (`graph/stream.ts`)

```typescript
export async function* streamState(
    threads: BaseThreadsManager,
    run: Run,
    payload: StreamInputData,
    options: {
        attempt: number
        getGraph: (graphId: string, config, options) => Promise<Pregel>
        compressMessages?: boolean
    }
): AsyncGenerator<EventMessage>
```

**核心流程**：
1. 创建运行队列
2. 异步执行图流处理（streamStateWithQueue）
3. 从队列读取事件并生成数据流
4. 清理资源（队列、状态）

### 5. 流队列管理 (`queue/stream_queue.ts`)

**StreamQueueManager**: 管理多个流队列实例

```typescript
export class StreamQueueManager<Q extends BaseStreamQueueInterface> {
    // 创建队列
    createQueue(id: string, ttl?: number): Q

    // 获取队列
    async getQueue(id: string): Promise<Q>

    // 取消队列
    async cancelQueue(id: string): Promise<void>

    // 复制队列
    async copyQueue(fromId: string, toId: string, ttl?: number): Promise<BaseStreamQueueInterface>

    // 清理队列
    removeQueue(id: string)
}
```

**队列实现**：
- `MemoryStreamQueue`: 内存队列（开发/测试）
- `RedisStreamQueue`: Redis 流队列（生产环境）

### 6. 线程管理 (`threads/index.ts`)

```typescript
export interface BaseThreadsManager {
    setup(): Promise<void>
    create(payload): Promise<Thread>
    get(threadId: string): Promise<Thread>
    search(query): Promise<Thread[]>
    delete(threadId: string): Promise<void>
    updateState(threadId, thread): Promise<Pick<Config, 'configurable'>>
    createRun(threadId, assistantId, payload): Promise<Run>
    listRuns(threadId, options): Promise<Run[]>
}
```

**实现**：
- `MemoryThreadsManager`: 内存线程管理
- `KyselyThreadsManager`: 基于 Kysely 的数据库线程管理

### 7. Agents 协作系统 (`agents/ask_subagents.ts`)

**核心功能**：创建子代理工具，实现多代理协作

```typescript
export const ask_subagents = (
    agentCreator: (task_id: string, args, parent_state: any) => Promise<any>,
    options?: {
        name?: string
        description?: string
        pass_through_keys?: string[]
    }
) => Tool
```

**使用示例**：

```typescript
import { ask_subagents } from '@langgraph-js/pure-graph';

// 创建代码实现助手
const implementCode = ask_subagents(
    async (taskId, args, parentState) => {
        // 创建子代理实例
        const subAgent = await createCodeImplementationAgent();
        return subAgent.invoke(subState);
    },
    {
        name: 'implement_code',
        description: '实现代码功能',
        pass_through_keys: ['context', 'metadata']
    }
);

// 在图中使用
const graph = workflow.addNode('implement', implementCode);
```

**参数说明**：
- `agentCreator`: 子代理创建函数，返回 LangGraph 代理实例
- `options.name`: 工具名称（默认: `ask_subagents`）
- `options.description`: 工具描述
- `options.pass_through_keys`: 从子代理状态传递回父代理的键名

**状态管理**：
- 使用 `task_store` 存储子代理状态
- 支持 `task_id` 复用或创建新状态
- 消息隔离：子代理消息存储在 `task_store[taskId].messages`

## 框架适配器

### Fetch 适配器（标准 Web API）

```typescript
import { handleRequest } from '@langgraph-js/pure-graph/dist/adapter/fetch';
import { registerGraph } from '@langgraph-js/pure-graph';

registerGraph('my-graph', graph);

export default async function handler(req: Request) {
    const context = { langgraph_context: { userId: req.headers.get('x-user-id') } };
    return await handleRequest(req, context);
}
```

**支持平台**：Cloudflare Workers, Deno Deploy, Vercel Edge, Bun

### Hono 适配器

```typescript
import { createHonoAdapter } from '@langgraph-js/pure-graph/dist/adapter/hono';
import { Hono } from 'hono';

registerGraph('my-graph', graph);

const app = new Hono<{ Variables: LangGraphServerContext }>();
app.use('/api/*', async (c, next) => {
    c.set('langgraph_context', { userId: c.req.header('x-user-id') });
    await next();
});

const langGraphApp = createHonoAdapter({ basePath: '/api' });
app.route('/api', langGraphApp);
```

### Next.js 适配器

```typescript
import { ensureInitialized } from '@langgraph-js/pure-graph/dist/adapter/nextjs';

const registerGraph = async () => {
    const { registerGraph } = await import('@langgraph-js/pure-graph');
    const { graph } = await import('@/agent/graph');
    registerGraph('my-graph', graph);
};

export const GET = async (req: NextRequest) => {
    const { GET } = await ensureInitialized(registerGraph);
    return GET(req);
};
```

## 存储配置

### Checkpointer（状态持久化）

| 类型 | 环境变量 | 说明 |
|------|---------|------|
| Memory | - | 默认，无持久化 |
| SQLite | `SQLITE_DATABASE_URI` | 文件数据库 |
| PostgreSQL | `DATABASE_URL` + `CHECKPOINT_TYPE=postgres` | 生产环境 |
| Redis | `REDIS_URL` + `CHECKPOINT_TYPE=redis` | 完整 Redis |
| Redis (Shallow) | `REDIS_URL` + `CHECKPOINT_TYPE=shallow/redis` | 轻量级 Redis |

### Message Queue（消息队列）

| 类型 | 环境变量 | TTL |
|------|---------|-----|
| Memory | - | 进程生命周期 |
| Redis | `REDIS_URL` | 300 秒 |

### Threads Manager（线程管理）

| 类型 | 环境变量 | 初始化 |
|------|---------|--------|
| Memory | - | 自动 |
| SQLite | `SQLITE_DATABASE_URI` | 自动执行 |
| PostgreSQL | `DATABASE_URL` | 需 `DATABASE_INIT=true` |

## 开发工作流

### 1. 初始化项目

```typescript
import { LangGraphGlobal } from '@langgraph-js/pure-graph';

// 初始化全局组件
await LangGraphGlobal.initGlobal();
```

### 2. 创建图

```typescript
import { registerGraph } from '@langgraph-js/pure-graph';
import { StateGraph } from '@langchain/langgraph';

const graph = new StateGraph({ channels })
    .addNode('agent', agentNode)
    .addEdge('__start__', 'agent')
    .compile();

registerGraph('my-agent', graph);
```

### 3. 使用子代理

```typescript
import { ask_subagents } from '@langgraph-js/pure-graph';

// 定义子代理创建函数
const createSubAgent = async (taskId, args, parentState) => {
    const agent = await loadAgent(args.subagent_id);
    return agent;
};

// 创建工具
const subAgentTool = ask_subagents(createSubAgent, {
    name: 'delegate_task',
    description: '委托任务给子代理'
});

// 添加到节点
const workflow = new StateGraph({ channels })
    .addNode('delegate', subAgentTool);
```

### 4. 创建 API 端点

```typescript
import { createEndpoint } from '@langgraph-js/pure-graph';

const endpoint = createEndpoint();

// 使用端点
const assistants = await endpoint.assistants.search({ graphId: 'my-agent' });
const thread = await endpoint.threads.create();
const run = await endpoint.runs.stream(thread.thread_id, 'my-agent', { input });
```

## 类型定义

### 核心类型

```typescript
// 流模式
export type StreamMode = 'values' | 'updates' | 'messages' | 'messages-tuple' | 'events' | 'debug';

// 运行状态
export type RunStatus = 'pending' | 'running' | 'error' | 'success' | 'timeout' | 'interrupted';

// 线程状态
export type ThreadStatus = 'idle' | 'busy' | 'error' | 'interrupted';

// 流输入数据
export type StreamInputData = {
    input?: Record<string, unknown>
    metadata?: Metadata
    config?: RunnableConfig
    interruptBefore?: '*' | string[]
    interruptAfter?: '*' | string[]
    command?: Command
    streamMode?: StreamMode[]
    streamSubgraphs?: boolean
    temporary?: boolean
    // ... 更多选项
}

// LangGraph 客户端接口
export interface ILangGraphClient {
    assistants: { ... }
    threads: { ... }
    runs: { ... }
}
```

## 最佳实践

### 1. 图注册隔离

```typescript
// ✅ 分离注册和路由文件
// agent/index.ts
import { registerGraph } from '@langgraph-js/pure-graph';
import graph from './graph';
registerGraph('my-graph', graph);

// route.ts
const registerGraph = async () => {
    await import('@/agent/index');
};
```

### 2. 上下文传递

```typescript
// Next.js 中间件
export function middleware(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.set('x-langgraph-context', JSON.stringify({
        userId: request.cookies.get('user-id')?.value,
        sessionId: request.cookies.get('session-id')?.value
    }));
    return NextResponse.next({ request: { headers } });
}

// 在图中访问
const config = getConfig();
const userId = config.configurable?.userId;
```

### 3. 错误处理

```typescript
try {
    const stream = endpoint.runs.stream(threadId, assistantId, payload);
    for await (const event of stream) {
        // 处理事件
    }
} catch (error) {
    if (error.message === 'Graph not found') {
        // 图不存在
    } else {
        // 其他错误
    }
}
```

### 4. 资源清理

```typescript
try {
    // 执行流处理
    await threads.set(threadId, { status: 'busy' });
    for await (const data of stream) {
        yield data;
    }
} finally {
    // 清理队列
    LangGraphGlobal.globalMessageQueue.removeQueue(queueId);
    // 更新线程状态
    await threads.set(threadId, { status: 'idle' });
}
```

## 项目目录结构

```
src/
├── adapter/           # 框架适配器
│   ├── fetch/         # 标准 Fetch API 适配器
│   ├── hono/          # Hono.js 适配器
│   └── nextjs/        # Next.js 适配器
├── agents/            # Agents 系统
│   ├── ask_subagents.ts  # 子代理工具创建
│   └── index.ts
├── graph/             # 图处理
│   ├── stream.ts      # 流处理引擎
│   └── stringify.ts   # 序列化工具
├── queue/             # 消息队列
│   ├── stream_queue.ts    # 队列管理器
│   ├── event_message.ts   # 事件消息
│   └── JsonPlusSerializer.ts
├── storage/           # 存储层
│   ├── index.ts       # 存储工厂
│   ├── memory/        # 内存存储
│   ├── sqlite/        # SQLite 存储
│   ├── redis/         # Redis 存储
│   └── pg/            # PostgreSQL 存储
├── threads/           # 线程管理
│   └── index.ts       # 线程管理接口
├── utils/             # 工具函数
│   ├── getGraph.ts    # 图注册系统
│   └── ...
├── createEndpoint.ts  # 端点创建
├── global.ts          # 全局状态
├── index.ts           # 主入口
└── types.ts           # 类型定义
```

## 常见问题

### Q: 如何添加新的存储后端？

A: 实现 `BaseCheckpointSaver` 接口，然后在 `storage/index.ts` 的 `createCheckPointer` 中添加判断逻辑。

### Q: 如何创建自定义适配器？

A: 使用 `adapter/fetch` 的 `handleRequest` 函数，将其包装到目标框架的处理器中。

### Q: 子代理之间如何共享状态？

A: 使用 `task_store` 管理子代理状态，通过 `pass_through_keys` 配置需要传递的键。

### Q: 如何实现流的中断和恢复？

A: 设置 `interruptBefore`/`interruptAfter` 参数，中断状态会自动保存到队列，可通过 `joinStream` 恢复。

### Q: 生产环境推荐使用什么存储？

A: PostgreSQL + Redis 组合：
- PostgreSQL: Checkpointer 和 ThreadsManager
- Redis: Message Queue（高性能流传输）

## 相关资源

- [README.md](./README.md) - 用户文档
- [API 文档](https://open-langgraph-server.agent-aura.top/docs/index.md) - API 参考
- [LangGraph 文档](https://langchain-ai.github.io/langgraph/) - LangGraph 官方文档
