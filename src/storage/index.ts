import { BaseStreamQueueInterface, StreamQueueManager } from '../queue/stream_queue';
import { KyselyThreadsManager } from './kysely/threads';
import { MemorySaver } from './memory/checkpoint';
import { MemoryStreamQueue } from './memory/queue';
import { MemoryThreadsManager } from './memory/threads';
import type { SqliteSaver as SqliteSaverType } from './sqlite/checkpoint';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

// 所有的适配实现，都请写到这里，通过环境变量进行判断使用哪种方式进行适配
export const createCheckPointer = async () => {
    if (
        (process.env.REDIS_URL && process.env.CHECKPOINT_TYPE === 'redis') ||
        process.env.CHECKPOINT_TYPE === 'shallow/redis'
    ) {
        if (process.env.CHECKPOINT_TYPE === 'redis') {
            console.debug('LG | Using redis as checkpoint');
            const { RedisSaver } = await import('@langchain/langgraph-checkpoint-redis');
            return await RedisSaver.fromUrl(process.env.REDIS_URL!, {
                defaultTTL: 60, // TTL in minutes
                refreshOnRead: true,
            });
        }
        if (process.env.CHECKPOINT_TYPE === 'shallow/redis') {
            console.debug('LG | Using shallow redis as checkpoint');
            const { ShallowRedisSaver } = await import('@langchain/langgraph-checkpoint-redis/shallow');
            return await ShallowRedisSaver.fromUrl(process.env.REDIS_URL!);
        }
    }

    if (process.env.DATABASE_URL && getDatabaseType(process.env.DATABASE_URL) === 'postgres') {
        console.debug('LG | Using postgres as checkpoint');
        const { createPGCheckpoint } = await import('./pg/checkpoint');
        return createPGCheckpoint();
    }

    if (process.env.SQLITE_DATABASE_URI) {
        console.debug('LG | Using sqlite as checkpoint');
        const { SqliteSaver } = await import('./sqlite/checkpoint');
        const db = await SqliteSaver.fromConnStringAsync(process.env.SQLITE_DATABASE_URI);
        return db;
    }
    console.log('LG | You are using memory as checkpoint!');
    console.log(
        '\x1b[33m%s\x1b[0m',
        'LG | set SQLITE_DATABASE_URI=./.langgraph_api/langgraph.db to your .env file to use \x1b[1mSQLite\x1b[0m for dev!',
    );
    console.log(
        '\x1b[33m%s\x1b[0m',
        'LG | set DATABASE_URL=postgresql://user:pass@localhost:5432/db to your .env file to use \x1b[1mPostgreSQL\x1b[0m for prod!',
    );
    return new MemorySaver();
};

export const createMessageQueue = async () => {
    let q: new (id: string) => BaseStreamQueueInterface;
    if (process.env.REDIS_URL) {
        console.debug('LG | Using redis as stream queue');
        const { RedisStreamQueue } = await import('./redis/queue');
        q = RedisStreamQueue;
    } else {
        q = MemoryStreamQueue;
    }
    return new StreamQueueManager(q);
};

/**
 * 检测 DATABASE_URL 类型
 */
function getDatabaseType(databaseUrl: string): 'postgres' | 'remote' {
    const url = databaseUrl.toLowerCase();
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return 'remote';
    }
    return 'postgres';
}

export const createThreadManager = async (config: { checkpointer?: SqliteSaverType | PostgresSaver }) => {
    if (process.env.DATABASE_URL) {
        const dbType = getDatabaseType(process.env.DATABASE_URL);

        if (dbType === 'remote') {
            // 使用远程 PG 适配器
            console.debug('LG | Using Remote PostgreSQL ThreadsManager');
            const { RemoteKyselyThreadsManager } = await import('./kysely/remote-threads');
            const threadsManager = new RemoteKyselyThreadsManager(process.env.DATABASE_URL);
            if (process.env.DATABASE_INIT === 'true') {
                await threadsManager.setup();
            }
            return threadsManager;
        } else {
            // 使用本地 PG 适配器（现有逻辑）
            if (config.checkpointer) {
                console.debug('LG | Using PostgreSQL ThreadsManager');
                const { PostgresAdapter } = await import('./kysely/pg-adapter');
                const pool = (config.checkpointer as PostgresSaver as any).pool;
                const threadsManager = new KyselyThreadsManager(new PostgresAdapter(pool));
                if (process.env.DATABASE_INIT === 'true') {
                    await threadsManager.setup();
                }
                return threadsManager;
            }
        }
    }
    if (process.env.SQLITE_DATABASE_URI && config.checkpointer) {
        console.debug('LG | Using SQLite ThreadsManager');
        const { SQLiteAdapter } = await import('./kysely/sqlite-adapter');
        const database = (config.checkpointer as SqliteSaverType).db;
        const threadsManager = new KyselyThreadsManager(new SQLiteAdapter(database));
        // sqlite 可以执行多次，速度很快
        await threadsManager.setup();
        return threadsManager;
    }
    return new MemoryThreadsManager();
};
