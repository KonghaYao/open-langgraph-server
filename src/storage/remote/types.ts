/**
 * Remote PostgreSQL Adapter 类型定义
 * 定义 API 请求/响应格式和错误类型
 */

import { Metadata, OnConflictBehavior, Run, Thread, ThreadStatus, Command } from '@langgraph-js/sdk';
import { RunStatus, SortOrder, ThreadSortBy } from '../../types';

/**
 * API 响应通用格式
 */
export interface RemoteResponse<T = any> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}

/**
 * 错误码枚举
 */
export enum RemoteErrorCode {
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

/**
 * 远程 API 错误类
 */
export class RemoteApiError extends Error {
    constructor(
        public code: string,
        message: string,
        public statusCode?: number
    ) {
        super(message);
        this.name = 'RemoteApiError';
    }
}

/**
 * Setup API 响应
 */
export interface SetupResponse {
    message: string;
}

/**
 * Create Thread API 请求
 */
export interface CreateThreadRequest {
    metadata?: Metadata;
    threadId?: string;
    ifExists?: OnConflictBehavior;
    graphId?: string;
    supersteps?: Array<{ updates: Array<{ values: unknown; command?: Command; asNode: string }> }>;
}

/**
 * Search Threads API 请求
 */
export interface SearchThreadsRequest {
    metadata?: Metadata;
    limit?: number;
    offset?: number;
    status?: ThreadStatus;
    sortBy?: ThreadSortBy;
    sortOrder?: SortOrder;
    withoutDetails?: boolean;
}

/**
 * Update Thread API 请求
 */
export interface UpdateThreadRequest {
    metadata?: Metadata;
    status?: ThreadStatus;
    values?: any;
    interrupts?: Record<string, any>;
}

/**
 * Update State API 请求
 */
export interface UpdateStateRequest {
    values?: any;
}

/**
 * Update State API 响应
 */
export interface UpdateStateResponse {
    configurable: Record<string, any>;
}

/**
 * Create Run API 请求
 */
export interface CreateRunRequest {
    metadata?: Metadata;
}

/**
 * List Runs API 请求
 */
export interface ListRunsRequest {
    limit?: number;
    offset?: number;
    status?: RunStatus;
}

/**
 * Update Run API 请求
 */
export interface UpdateRunRequest {
    status?: RunStatus;
    metadata?: Metadata;
    multitask_strategy?: 'reject' | 'interrupt' | 'rollback';
}
