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
    private pragmaPromise: Promise<void> | null = null;

    constructor(database: Kysely<any>) {
        this.db = database;
    }

    /**
     * 设置 SQLite PRAGMA 配置，解决锁问题
     * 使用 Promise 缓存确保并发安全且只执行一次
     */
    private ensurePragma(): Promise<void> {
        if (!this.pragmaPromise) {
            this.pragmaPromise = this.doEnsurePragma();
        }
        return this.pragmaPromise;
    }

    private async doEnsurePragma(): Promise<void> {
        // 锁等待超时 5 秒
        await sql`PRAGMA busy_timeout = 5000`.execute(this.db);
        // WAL 模式 - 读写并发
        await sql`PRAGMA journal_mode = WAL`.execute(this.db);
        // 平衡安全与性能
        await sql`PRAGMA synchronous = NORMAL`.execute(this.db);
        // 自动清理 WAL
        await sql`PRAGMA wal_autocheckpoint = 1000`.execute(this.db);
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
        // SQLite json_extract 的行为:
        // - 字符串: 返回不带引号的文本
        // - 数字: 返回数字
        // - 布尔值: 返回 1/0
        // - null: 返回 NULL
        // 所以比较时需要根据类型处理

        // 构建 JSON 路径
        // 在 SQLite 中，所有键都需要用双引号括起来以确保正确解析
        // json_extract 语法: $.key 或 $."key-with-special"
        const jsonPath = `$.${JSON.stringify(key)}`;

        // 构建 NULL 处理条件
        // 注意：SQLite 中 json_extract 对键不存在和值为 null 都返回 NULL
        // 使用 json_type 函数区分：
        // - 键不存在：json_type 返回 NULL
        // - 值为 null：json_type 返回 'null' 字符串
        if (value === null) {
            return sql<boolean>`
                json_type(${sql.ref(field)}, ${sql.lit(jsonPath)}) = 'null'
            `;
        }

        // 处理其他类型的值
        let compareValue: any;
        if (typeof value === 'string') {
            // 字符串: json_extract 返回不带引号的字符串，直接比较
            compareValue = value;
        } else if (typeof value === 'number') {
            // 数字: json_extract 返回数字
            compareValue = value;
        } else if (typeof value === 'boolean') {
            // 布尔值: json_extract 返回 1/0
            compareValue = value ? 1 : 0;
        } else {
            // 其他类型（对象、数组）: 使用 JSON 字符串
            compareValue = JSON.stringify(value);
        }

        // 构建普通比较条件
        return sql<boolean>`json_extract(${sql.ref(field)}, ${sql.lit(jsonPath)}) = ${sql.lit(compareValue)}`;
    }

    now(): string {
        return new Date().toISOString();
    }

    async createTables(db: Kysely<Database>): Promise<void> {
        // 先设置 PRAGMA
        await this.ensurePragma();

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
