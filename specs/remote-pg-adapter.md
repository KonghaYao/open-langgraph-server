# Remote PostgreSQL Adapter 设计方案

## 1. 背景

当前项目中，PostgreSQL 适配器（`src/storage/kysely/pg-adapter.ts`）直接建立数据库连接，这导致：
- 连接建立耗时较长
- 每个服务实例都需要维护数据库连接池
- 难以在分布式环境中统一管理连接

为了解决这些问题，我们计划实现一个基于远程服务器的 PostgreSQL 适配器。

## 2. 目标

创建一个依赖远程服务器接口的 Adapter，通过 HTTP/REST API 与专门对接 PostgreSQL 的服务器通信，实现与本地 PG 适配器相同的功能。

## 3. 架构设计

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                     主服务器                              │
│  ┌────────────────────────────────────────────────────┐ │
│  │  RemoteKyselyThreadsManager                          │ │
│  │  - HTTP 客户端（fetch API）                          │ │
│  └──────────────────────┬─────────────────────────────┘ │
│                         │ HTTP/REST API                 │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                   PG 服务器                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │  RemoteServer                                       │ │
│  │  - HTTP 服务器（Hono.js）                            │ │
│  │  - PostgresAdapter (直接连接 PG)                    │ │
│  │  - KyselyThreadsManager                             │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                   PostgreSQL 数据库                       │
└─────────────────────────────────────────────────────────┘
```

### 3.2 技术选型

| 组件 | 技术选择 | 说明 |
|-----|---------|------|
| 传输协议 | HTTP/REST API | 标准协议，易于调试和扩展 |
| 数据格式 | JSON | 通用数据交换格式 |
| 服务器框架 | Hono.js | 项目已有 Hono 适配器 |
| HTTP 客户端 | fetch API | 标准 Web API，跨平台 |
| 认证机制 | 无 | 内网环境，信任网络 |
| 连接池 | 无连接池 | 每次请求新连接，简化实现 |
| 重试策略 | 不实现 | 由调用方处理错误 |

## 4. 组件设计

### 4.1 客户端：RemoteKyselyThreadsManager

**文件位置：** `src/storage/kysely/remote-threads.ts`

**职责：**
- 实现 `BaseThreadsManager` 接口
- 通过 HTTP 调用远程服务器的 Threads API
- 提供 Thread 和 Run 的完整 CRUD 操作

**核心接口：**

```typescript
export class RemoteKyselyThreadsManager<ValuesType = unknown>
    implements BaseThreadsManager<ValuesType> {

    constructor(
        serverUrl: string,
        httpClient?: typeof fetch
    );

    async setup(): Promise<void>;
    async create(payload?: {...}): Promise<Thread<ValuesType>>;
    async search(query?: {...}): Promise<Thread<ValuesType>[]>;
    async get(threadId: string): Promise<Thread<ValuesType>>;
    async set(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<void>;
    async updateState(threadId: string, thread: Partial<Thread<ValuesType>>): Promise<Pick<Config, 'configurable'>>;
    async delete(threadId: string): Promise<void>;
    async createRun(threadId: string, assistantId: string, payload?: {...}): Promise<Run>;
    async listRuns(threadId: string, options?: {...}): Promise<Run[]>;
    async updateRun(runId: string, run: Partial<Run>): Promise<void>;
}
```

### 4.2 服务器端：RemoteServer

**文件位置：** `src/storage/remote/remote-server.ts`

**职责：**
- 提供 HTTP API 端点
- 使用本地 PostgresAdapter 和 KyselyThreadsManager
- 处理请求认证（预留接口）

**API 端点设计：**

| 方法 | 路径 | 说明 |
|-----|------|------|
| POST | `/setup` | 初始化数据库（创建表和索引） |
| POST | `/threads` | 创建线程 |
| GET | `/threads/:threadId` | 获取线程 |
| GET | `/threads` | 搜索线程 |
| PUT | `/threads/:threadId` | 更新线程 |
| DELETE | `/threads/:threadId` | 删除线程 |
| POST | `/threads/:threadId/state` | 更新状态 |
| POST | `/threads/:threadId/runs` | 创建运行 |
| GET | `/threads/:threadId/runs` | 列出运行 |
| PUT | `/runs/:runId` | 更新运行 |

**请求/响应格式：**

```typescript
// 响应格式（通用）
interface RemoteResponse<T = any> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}
```

### 4.3 HTTP 客户端：Fetch 工具函数

**文件位置：** `src/storage/remote/fetch.ts`

**职责：**
- 封装 fetch API，提供简化的函数式接口
- 统一错误处理
- 支持 GET/POST/PUT/DELETE 方法

**核心函数：**

```typescript
export async function remoteGet<T>(
    url: string,
    query?: Record<string, string | number | boolean>
): Promise<RemoteResponse<T>>;

export async function remotePost<T>(
    url: string,
    body?: any,
    query?: Record<string, string | number | boolean>
): Promise<RemoteResponse<T>>;

export async function remotePut<T>(
    url: string,
    body?: any,
    query?: Record<string, string | number | boolean>
): Promise<RemoteResponse<T>>;

export async function remoteDelete<T>(
    url: string,
    query?: Record<string, string | number | boolean>
): Promise<RemoteResponse<T>>;
```

## 5. 实现细节

### 5.1 数据序列化

**日期处理：**
- 客户端：使用 ISO 8601 字符串传输
- 服务器：转换为 PostgreSQL TIMESTAMP 类型

**JSON 处理：**
- 客户端：直接传输 JSON 对象
- 服务器：PostgreSQL JSONB 类型

**特殊类型：**
- `Command` 对象：需要序列化为可传输格式
- `ValuesType`：使用 `serialiseAsDict` 和 `JSON.parse` 处理

### 5.2 错误处理

**错误分类：**
- 网络错误：连接超时、DNS 解析失败等
- 服务器错误：500 错误、异常抛出
- 业务错误：404、400 等状态码

**错误转换：**
- 客户端捕获 HTTP 错误并转换为标准异常
- 保持错误信息一致性

**错误码设计：**

```typescript
enum RemoteErrorCode {
    // 网络错误
    NETWORK_ERROR = 'NETWORK_ERROR',
    CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',

    // 服务器错误
    INTERNAL_ERROR = 'INTERNAL_ERROR',

    // 业务错误
    THREAD_NOT_FOUND = 'THREAD_NOT_FOUND',
    THREAD_BUSY = 'THREAD_BUSY',
    RUN_NOT_FOUND = 'RUN_NOT_FOUND',
    GRAPH_NOT_FOUND = 'GRAPH_NOT_FOUND',
    INVALID_REQUEST = 'INVALID_REQUEST',
}

class RemoteApiError extends Error {
    constructor(
        public code: string,
        message: string,
        public statusCode?: number
    ) {
        super(message);
        this.name = 'RemoteApiError';
    }
}
```

### 5.3 HTTP 客户端实现

```typescript
// src/storage/remote/fetch.ts
async function request<T>(
    url: string,
    method: string,
    options?: {
        query?: Record<string, string | number | boolean>;
        body?: any;
    }
): Promise<RemoteResponse<T>> {
    try {
        // 添加查询参数
        let requestUrl = url;
        if (options?.query) {
            const searchParams = new URLSearchParams();
            Object.entries(options.query).forEach(([key, value]) => {
                searchParams.append(key, String(value));
            });
            requestUrl += `?${searchParams.toString()}`;
        }

        // 发起请求
        const response = await fetch(requestUrl, {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: options?.body ? JSON.stringify(options.body) : undefined,
        });

        // 解析响应
        const data: RemoteResponse<T> = (await response.json()) as any;

        // 检查响应状态
        if (!response.ok || !data.success) {
            throw new RemoteApiError(
                data.error?.code || RemoteErrorCode.INTERNAL_ERROR,
                data.error?.message || 'Unknown error',
                response.status,
            );
        }

        return data;
    } catch (error) {
        // 如果是 RemoteApiError，直接抛出
        if (error instanceof RemoteApiError) {
            throw error;
        }

        // 网络错误转换为 RemoteApiError
        throw new RemoteApiError(
            RemoteErrorCode.NETWORK_ERROR,
            `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}
```

## 6. 使用示例

### 6.1 服务器端初始化

```typescript
import { Hono } from 'hono';
import { RemoteServer } from './storage/remote/remote-server';
import { PostgresAdapter } from './storage/kysely/pg-adapter';
import { KyselyThreadsManager } from './storage/kysely/threads';
import { Pool } from 'pg';

const app = new Hono();

// 创建 PG 连接池
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// 创建适配器
const pgAdapter = new PostgresAdapter(pool);

// 创建 ThreadsManager
const threadsManager = new KyselyThreadsManager(pgAdapter);
await threadsManager.setup();

// 创建远程服务器
const remoteServer = new RemoteServer(threadsManager);

// 注册路由
app.route('/api/remote', remoteServer.getRouter());

// 启动服务器
export default {
    fetch: app.fetch,
    port: 3001,
};
```

### 6.2 客户端使用

```typescript
import { RemoteKyselyThreadsManager } from './storage/kysely/remote-threads';

// 创建远程线程管理器
const threadsManager = new RemoteKyselyThreadsManager('http://localhost:3001/api/remote');

// 使用方式与本地 KyselyThreadsManager 相同
await threadsManager.setup();
const thread = await threadsManager.create({ metadata: { graph_id: 'my-agent' } });
const foundThread = await threadsManager.get(thread.thread_id);
```

### 6.3 与现有系统集成 - 自动检测机制

**在 `src/storage/index.ts` 中，根据 `DATABASE_URL` 的前缀自动选择适配器：**

```typescript
// 检测 DATABASE_URL 类型
function getDatabaseType(databaseUrl: string): 'postgres' | 'remote' {
    const url = databaseUrl.toLowerCase();
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return 'remote';
    }
    return 'postgres';
}

// 创建 ThreadsManager 的统一工厂函数
export async function createThreadsManager(
    databaseUrl: string,
    checkpointer?: BaseCheckpointSaver | null
): Promise<BaseThreadsManager> {
    const dbType = getDatabaseType(databaseUrl);

    if (dbType === 'remote') {
        // 使用远程 PG 适配器
        const { RemoteKyselyThreadsManager } = await import('./kysely/remote-threads');
        const manager = new RemoteKyselyThreadsManager(databaseUrl);
        await manager.setup();
        return manager;
    } else {
        // 使用本地 PG 适配器（现有逻辑）
        const { PostgresAdapter } = await import('./kysely/pg-adapter');
        const { Pool } = await import('pg');
        const { KyselyThreadsManager } = await import('./kysely/threads');

        const pool = new Pool({ connectionString: databaseUrl });
        const adapter = new PostgresAdapter(pool);
        const manager = new KyselyThreadsManager(adapter);
        await manager.setup();
        return manager;
    }
}
```

**环境变量配置：**

```bash
# 本地 PostgreSQL 连接（使用 PostgresAdapter）
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# 远程 PG 服务器（使用 RemoteKyselyThreadsManager）
DATABASE_URL=http://localhost:3001/api/remote
DATABASE_URL=https://remote-pg-server.example.com/api/remote
```

## 7. 文件结构

```
src/storage/
├── remote/
│   ├── types.ts              # 类型定义（RemoteResponse、RemoteApiError、RemoteErrorCode）
│   ├── fetch.ts              # Fetch 工具函数（remoteGet、remotePost、remotePut、remoteDelete）
│   ├── remote-server.ts      # RemoteServer 核心实现
│   ├── server.ts             # 服务器启动示例
│   └── __tests__/
│       └── integration.test.ts  # 集成测试
├── kysely/
│   ├── remote-threads.ts     # RemoteKyselyThreadsManager 客户端实现
│   └── index.ts             # 导出
└── index.ts                  # 工厂函数（createThreadManager）
```

## 8. API 端点参考

### Setup

**POST** `/setup`
- 初始化数据库表和索引

### Threads

- **POST** `/threads` - 创建线程
- **GET** `/threads` - 搜索线程（支持 metadata、limit、offset、status、sortBy、sortOrder、withoutDetails 参数）
- **GET** `/threads/:threadId` - 获取指定线程
- **PUT** `/threads/:threadId` - 更新线程
- **DELETE** `/threads/:threadId` - 删除线程
- **POST** `/threads/:threadId/state` - 更新线程状态

### Runs

- **POST** `/threads/:threadId/runs` - 创建运行（assistantId 通过 query 参数传递）
- **GET** `/threads/:threadId/runs` - 列出运行（支持 limit、offset、status 参数）
- **PUT** `/runs/:runId` - 更新运行

## 9. 实现状态

### Phase 1: 核心类型定义 ✅
- [x] 定义 RemoteKyselyThreadsManager 接口
- [x] 定义 API 请求/响应类型
- [x] 定义 RemoteApiError 类
- [x] 定义 RemoteErrorCode 枚举

### Phase 2: HTTP 客户端 ✅
- [x] 实现 remoteGet、remotePost、remotePut、remoteDelete 工具函数
- [x] 实现错误处理逻辑

### Phase 3: 服务器端实现 ✅
- [x] 实现 RemoteServer 类（类名已从 RemotePgServer 简化）
- [x] 实现所有 Threads API 端点
- [x] 实现所有 Runs API 端点
- [x] 添加错误处理中间件

### Phase 4: 客户端实现 ✅
- [x] 实现 RemoteKyselyThreadsManager 类
- [x] 实现 HTTP 客户端调用
- [x] 实现数据序列化/反序列化
- [x] 实现错误转换

### Phase 5: 集成 ✅
- [x] 实现自动检测机制（getDatabaseType）
- [x] 修改 createThreadManager 函数
- [x] 创建服务器启动示例（使用 Bun 的 export default { fetch, port } 格式）
- [x] 编写集成测试

### Phase 6: 文档 ✅
- [x] 编写使用文档（docs/remote-pg-adapter.md）
- [x] 更新 README（添加 Remote PostgreSQL Adapter 说明）

## 10. 测试

### 集成测试

位置：`src/storage/remote/__tests__/integration.test.ts`

运行测试：
```bash
bun test src/storage/remote/__tests__/integration.test.ts
```

测试覆盖：
- Setup API
- Thread CRUD 操作
- Run CRUD 操作
- 错误处理

## 11. 最佳实践

### 11.1 生产部署

1. **使用 HTTPS**: 在生产环境中使用 HTTPS 传输
2. **添加认证**: 实现认证机制（API Token、JWT 等）
3. **健康检查**: 添加 `/health` 端点用于监控
4. **日志记录**: 记录所有请求和响应
5. **监控指标**: 添加性能指标和错误率监控

### 11.2 性能优化

1. **使用内网通信**: 降低延迟
2. **HTTP/2 或 HTTP/3**: 如果服务器支持
3. **连接池**: 考虑添加 HTTP 连接池（可选）
4. **缓存层**: 实现查询结果缓存（可选）
5. **超时设置**: 客户端设置合理的请求超时

### 11.3 错误处理

1. **重试机制**: 对于网络错误实现指数退避重试（可选）
2. **错误日志**: 记录所有错误以便排查
3. **错误分类**: 区分可重试错误和不可重试错误
4. **用户友好**: 对外提供友好的错误信息

## 12. 参考资料

- [Hono.js 文档](https://hono.dev/)
- [Fetch API 规范](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [Kysely 文档](https://kysely.dev/)
- [项目 README](../README.md)
- [项目文档](../PROJECT_DOCUMENTATION.md)
- [Remote PG Adapter 使用文档](../docs/remote-pg-adapter.md)
