import { LangGraphGlobal } from '../../global';
import { searchAssistants, getAssistantGraph } from './assistants';
import { createThread, searchThreads, getThread, deleteThread } from './threads';
import { streamRun, joinRunStream, listRuns, cancelRun, updateThreadState } from './runs';
import { errorResponse } from './utils';
import type { LangGraphServerContext } from './context';
/**
 * 路由匹配器
 */
interface Route {
    method: string;
    pattern: RegExp;
    handler: (req: Request, context: LangGraphServerContext) => Promise<Response>;
}

const routes: Route[] = [
    // Assistants
    {
        method: 'POST',
        pattern: /^\/assistants\/search$/,
        handler: searchAssistants,
    },
    {
        method: 'GET',
        pattern: /^\/assistants\/[^/]+\/graph$/,
        handler: getAssistantGraph,
    },

    // Threads
    {
        method: 'POST',
        pattern: /^\/threads$/,
        handler: createThread,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/search$/,
        handler: searchThreads,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+$/,
        handler: getThread,
    },
    {
        method: 'DELETE',
        pattern: /^\/threads\/[^/]+$/,
        handler: deleteThread,
    },

    // Runs
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/runs\/stream$/,
        handler: streamRun,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+\/stream$/,
        handler: joinRunStream,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/runs$/,
        handler: listRuns,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+\/cancel$/,
        handler: cancelRun,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/state$/,
        handler: updateThreadState,
    },
];

const replaceRequest = (req: Request) => {
    const path = new URL(req.url).pathname.toString();
    let basePath = '';
    if (path.includes('/threads')) {
        basePath = path.split('/threads')[0];
    } else if (path.includes('/assistants')) {
        basePath = path.split('/assistants')[0];
    }
    return new Request(req.url.replace(basePath, ''), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: req.duplex,
    });
};

/**
 * 主路由处理器
 */
export async function handleRequest(req: Request, context: LangGraphServerContext = {}): Promise<Response> {
    req = replaceRequest(req);
    try {
        // 初始化全局配置
        await LangGraphGlobal.initGlobal();

        const url = new URL(req.url);
        const pathname = url.pathname;
        const method = req.method;

        // 查找匹配的路由
        for (const route of routes) {
            if (route.method === method && route.pattern.test(pathname)) {
                return await route.handler(req, context);
            }
        }

        // 未找到路由
        return new Response('Not Found', { status: 404 });
    } catch (error) {
        console.error('Request error:', error);
        return errorResponse(error);
    }
}

// 导出所有处理函数供直接使用
export * from './assistants';
export * from './threads';
export * from './runs';
