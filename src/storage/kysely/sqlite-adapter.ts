import { Kysely, sql, SqlBool, Expression, SqliteDialect } from 'kysely';
import { DatabaseAdapter } from './adapter';
import { Database } from './types';

/**
 * SQLite 适配器
 * - 时间类型：TEXT (ISO 8601 字符串)
 * - JSON 类型：TEXT
 * - JSON 查询：使用 json_extract 函数
 */
export class SQLiteAdapter implements DatabaseAdapter {
    db: Kysely<Database>;
    constructor(database: Kysely<any>) {
        this.db = database;
    }
    dateToDb(date: Date): string {
        // SQLite 存储为 ISO 8601 字符串
        return date.toISOString();
    }

    dbToDate(dbValue: any): Date {
        // SQLite 返回字符串，需要转换为 Date
        return new Date(dbValue);
    }

    jsonToDb(obj: any): string {
        // SQLite 存储为 JSON 字符串
        return JSON.stringify(obj);
    }

    dbToJson(dbValue: any): any {
        // SQLite 返回字符串，需要解析
        if (typeof dbValue === 'string') {
            try {
                return JSON.parse(dbValue);
            } catch {
                return dbValue;
            }
        }
        return dbValue;
    }

    buildJsonQuery(
        db: Kysely<Database>,
        field: 'metadata' | 'interrupts',
        key: string,
        value: any,
    ): Expression<SqlBool> {
        const jsonString = JSON.stringify(value);
        
        // 改进的 JSON 查询，添加 NULL 值处理
        // json_extract 会返回 NULL 当键不存在或值为 NULL
        return sql<boolean>`(
            json_extract(${sql.ref(field)}, ${sql.lit('$.' + key)}) = ${sql.lit(jsonString)}
        ) OR (
            json_extract(${sql.ref(field)}, ${sql.lit('$.' + key)}) IS NULL
            AND ${sql.lit(jsonString)} IS NULL
        )`;
    }

    now(): string {
        return new Date().toISOString();
    }

    async createTables(db: Kysely<Database>): Promise<void> {
        // 创建 threads 表
        await sql`
            CREATE TABLE IF NOT EXISTS threads (
                thread_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'idle',
                "values" TEXT,
                interrupts TEXT NOT NULL DEFAULT '{}'
            )
        `.execute(db);

        // 创建 runs 表
        await sql`
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                assistant_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                metadata TEXT NOT NULL DEFAULT '{}',
                multitask_strategy TEXT NOT NULL DEFAULT 'reject',
                FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
            )
        `.execute(db);
    }

    async createIndexes(db: Kysely<Database>): Promise<void> {
        await sql`CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_runs_thread_id ON runs(thread_id)`.execute(db);
        await sql`CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`.execute(db);
    }
}
