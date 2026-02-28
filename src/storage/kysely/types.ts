/**
 * Kysely 数据库类型定义
 * 这里定义的是应用层的类型，不是数据库原始类型
 */

export interface ThreadsTable {
    thread_id: string;
    created_at: Date;
    updated_at: Date;
    metadata: Record<string, any>;
    status: string;
    values: any;
    interrupts: Record<string, any>;
    title: string | null;
}

export interface CheckpointsTable {
    checkpoint_id: string;
    thread_id: string;
    values: any;
    next: string[];
    config: any;
    created_at: Date;
    metadata: Record<string, any>;
}

export interface RunsTable {
    run_id: string;
    thread_id: string;
    assistant_id: string;
    created_at: Date;
    updated_at: Date;
    status: string;
    metadata: Record<string, any>;
    multitask_strategy: string;
}

export interface Database {
    threads: ThreadsTable;
    checkpoints: CheckpointsTable;
    runs: RunsTable;
}
