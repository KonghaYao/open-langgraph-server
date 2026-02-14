/**
 * Remote PostgreSQL Server 启动示例
 *
 * 这个文件展示如何启动一个远程 PG 服务器
 * 运行: bun run src/storage/remote/server.ts
 */

import { Hono } from 'hono';
import { RemoteServer } from './remote-server';
import { PostgresAdapter } from '../kysely/pg-adapter';
import { KyselyThreadsManager } from '../kysely/threads';
import { Pool } from 'pg';

const app = new Hono();
// 从环境变量获取数据库连接字符串
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    console.error('Example: DATABASE_URL=postgresql://user:password@localhost:5432/dbname');
    process.exit(1);
}

console.log('Starting Remote PostgreSQL Server...');

// 创建 PG 连接池
const pool = new Pool({
    connectionString: databaseUrl,
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

// 添加健康检查端点
app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 获取配置的端口
const port = parseInt(process.env.PORT || '3001');

console.log(`Remote PostgreSQL Server is running on port ${port}`);
console.log(`API Base URL: http://localhost:${port}/api/remote`);
console.log(`Health Check: http://localhost:${port}/health`);
console.log('');
console.log('Client Configuration:');
console.log(`  DATABASE_URL=http://localhost:${port}/api/remote`);
// 启动服务器
export default {
    fetch: app.fetch,
    port,
};
