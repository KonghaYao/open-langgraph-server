/**
 * Remote PostgreSQL Adapter - 简化的 Fetch 工具函数
 */

import { RemoteResponse } from './types';
import { RemoteApiError, RemoteErrorCode } from './types';

/**
 * 发起 HTTP 请求的简化函数
 */
async function request<T>(
    url: string,
    method: string,
    options?: {
        query?: Record<string, string | number | boolean>;
        body?: any;
    },
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
            `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
    }
}

/**
 * GET 请求
 */
export async function remoteGet<T>(
    url: string,
    query?: Record<string, string | number | boolean>,
): Promise<RemoteResponse<T>> {
    return request<T>(url, 'GET', { query });
}

/**
 * POST 请求
 */
export async function remotePost<T>(
    url: string,
    body?: any,
    query?: Record<string, string | number | boolean>,
): Promise<RemoteResponse<T>> {
    return request<T>(url, 'POST', { body, query });
}

/**
 * PUT 请求
 */
export async function remotePut<T>(
    url: string,
    body?: any,
    query?: Record<string, string | number | boolean>,
): Promise<RemoteResponse<T>> {
    return request<T>(url, 'PUT', { body, query });
}

/**
 * DELETE 请求
 */
export async function remoteDelete<T>(
    url: string,
    query?: Record<string, string | number | boolean>,
): Promise<RemoteResponse<T>> {
    return request<T>(url, 'DELETE', { query });
}
