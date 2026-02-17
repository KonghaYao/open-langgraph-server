# SQLite Checkpoint 锁问题修复

## 问题描述

SQLite checkpoint 实现在并发场景下会出现数据库锁问题，导致以下错误：
- `SQLITE_BUSY` - 数据库被锁定
- `database is locked` - 写入阻塞
- 长事务导致其他操作超时

## 根因分析

### 1. 缺少 `busy_timeout` 设置

**位置**: `src/storage/sqlite/checkpoint.ts` Line 129

当前代码仅设置了 WAL 模式：
```typescript
await sql`PRAGMA journal_mode = WAL`.execute(this.db);
```

SQLite 默认 `busy_timeout` 为 0，遇到锁会立即返回 `SQLITE_BUSY` 错误，无法等待锁释放。

### 2. 事务无超时保护

**位置**:
- Line 486: `putWrites()` - 写入 pending writes
- Line 505: `deleteThread()` - 删除线程

这两个方法使用 Kysely 事务，但没有设置超时，长事务会阻塞其他操作。

### 3. WAL 配置不完整

虽然启用了 WAL 模式，但未配置配套参数：
- `synchronous` - 控制数据安全与性能
- `wal_autocheckpoint` - WAL 自动检查点频率

## 修复方案

### 修改 `setup()` 方法

在 `src/storage/sqlite/checkpoint.ts` 的 `setup()` 方法中添加完整的 PRAGMA 配置：

```typescript
protected async setup(): Promise<void> {
    if (this.isSetup) {
        return;
    }

    // 设置锁等待超时 5 秒，避免立即返回 SQLITE_BUSY
    await sql`PRAGMA busy_timeout = 5000`.execute(this.db);

    // WAL 模式 - 允许读写并发，减少锁冲突
    await sql`PRAGMA journal_mode = WAL`.execute(this.db);

    // NORMAL 模式 - 平衡数据安全与性能
    // FULL: 最安全，最慢
    // NORMAL: 推荐值，安全且性能好
    // OFF: 最快，但可能丢失数据
    await sql`PRAGMA synchronous = NORMAL`.execute(this.db);

    // WAL 自动检查点 - 每 1000 页执行一次
    // 避免 WAL 文件无限增长
    await sql`PRAGMA wal_autocheckpoint = 1000`.execute(this.db);

    // 表创建保持不变
    await sql`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
)`.execute(this.db);

    await sql`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
)`.execute(this.db);

    this.isSetup = true;
}
```

### PRAGMA 参数说明

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| `busy_timeout` | 5000ms | 锁等待时间，超过返回错误 |
| `journal_mode` | WAL | Write-Ahead Logging，支持读写并发 |
| `synchronous` | NORMAL | 平衡数据安全与性能 |
| `wal_autocheckpoint` | 1000 | WAL 自动检查点频率 |

## 预期效果

### 修复前
- ❌ 并发写入立即失败
- ❌ 读操作被写操作阻塞
- ❌ 长事务导致全局锁等待

### 修复后
- ✅ 锁冲突自动等待 5 秒
- ✅ 读写并发操作（WAL 模式）
- ✅ 自动清理 WAL 文件
- ✅ 平衡性能与安全

## 兼容性

### Bun 环境
使用 `BunWorkerDialect`，PRAGMA 配置仍然有效。

### Node.js 环境
使用 `node-sqlite3-wasm` + `kysely-wasm`，PRAGMA 配置仍然有效。

## 测试建议

### 并发写入测试
```typescript
import { SqliteSaver } from './sqlite/checkpoint';

const saver = await SqliteSaver.fromConnStringAsync('./test.db');

// 并发写入 100 个 checkpoint
const promises = Array.from({ length: 100 }, (_, i) =>
    saver.put(
        { configurable: { thread_id: `thread-${i}` } },
        { id: `cp-${i}`, v: 1, ts: Date.now(), channel_versions: {} },
        { source: 'test', step: 1 }
    )
);

await Promise.all(promises);
```

### 长事务测试
```typescript
// 测试事务期间其他操作不会阻塞
const writePromise = saver.putWrites(
    { configurable: { thread_id: 'test', checkpoint_id: 'cp-1' } },
    [[ 'channel', 'value' ]],
    'task-1'
);

// 立即执行读操作，应该能够成功
const readPromise = saver.getTuple({
    configurable: { thread_id: 'test' }
});

await Promise.all([writePromise, readPromise]);
```

## 注意事项

### 1. 持久化要求
这些 PRAGMA 配置需要在每个连接建立时执行一次，`setup()` 方法已经满足此要求。

### 2. 多进程访问
如果多个进程访问同一个 SQLite 文件：
- WAL 模式允许多个读进程 + 一个写进程
- 建议设置更大的 `busy_timeout`（如 10000ms）

### 3. 文件系统
WAL 模式会在同目录下生成 `.wal` 和 `.shm` 文件：
- 确保进程对数据库文件所在目录有写权限
- 定期清理旧的 WAL 文件（可通过 `wal_autocheckpoint` 控制）

## 相关问题

- [memory-leak-fix-queue-implementation](../.claude/memories/memory-leak-fix-queue-implementation/MEMORY.md) - 队列实现的内存泄漏修复
- [langgraph-openapi-implementation](../.claude/memories/langgraph-openapi-implementation/MEMORY.md) - OpenAPI 完整实现
