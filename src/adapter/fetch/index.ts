import { LangGraphGlobal } from '../../global';
import {
    searchAssistants,
    countAssistants,
    getAssistant,
    deleteAssistant,
    patchAssistant,
    getAssistantGraph,
    getAssistantSubgraphs,
    getAssistantSubgraphsByNamespace,
    getAssistantSchemas,
    getAssistantVersions,
    setLatestAssistantVersion,
    createAssistant,
} from './assistants';
import {
    createThread,
    searchThreads,
    getThread,
    deleteThread,
    patchThread,
    countThreads,
    getThreadState,
    updateThreadState,
    getThreadStateAtCheckpoint,
    getThreadHistory,
    getThreadHistoryPost,
    copyThread,
    joinThreadStream,
} from './threads';
import { streamRun, joinRunStream, listRuns, cancelRun } from './runs';
import { createRun, waitRun, getRun, deleteRun, joinRun } from './runs-extended';
import { createStatelessRun, streamStatelessRun, waitStatelessRun, createBatchRuns, cancelRuns } from './runs-stateless';
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
        method: 'POST',
        pattern: /^\/assistants\/count$/,
        handler: countAssistants,
    },
    {
        method: 'GET',
        pattern: /^\/assistants\/[^/]+$/,
        handler: getAssistant,
    },
    {
        method: 'DELETE',
        pattern: /^\/assistants\/[^/]+$/,
        handler: deleteAssistant,
    },
    {
        method: 'PATCH',
        pattern: /^\/assistants\/[^/]+$/,
        handler: patchAssistant,
    },
    {
        method: 'GET',
        pattern: /^\/assistants\/[^/]+\/graph$/,
        handler: getAssistantGraph,
    },
    {
        method: 'GET',
        pattern: /^\/assistants\/[^/]+\/subgraphs$/,
        handler: getAssistantSubgraphs,
    },
    {
        method: 'GET',
        pattern: /^\/assistants\/[^/]+\/subgraphs\/[^/]+$/,
        handler: getAssistantSubgraphsByNamespace,
    },
    {
        method: 'GET',
        pattern: /^\/assistants\/[^/]+\/schemas$/,
        handler: getAssistantSchemas,
    },
    {
        method: 'POST',
        pattern: /^\/assistants\/[^/]+\/versions$/,
        handler: getAssistantVersions,
    },
    {
        method: 'POST',
        pattern: /^\/assistants\/[^/]+\/latest$/,
        handler: setLatestAssistantVersion,
    },
    {
        method: 'POST',
        pattern: /^\/assistants$/,
        handler: createAssistant,
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
        method: 'POST',
        pattern: /^\/threads\/count$/,
        handler: countThreads,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+$/,
        handler: getThread,
    },
    {
        method: 'PATCH',
        pattern: /^\/threads\/[^/]+$/,
        handler: patchThread,
    },
    {
        method: 'DELETE',
        pattern: /^\/threads\/[^/]+$/,
        handler: deleteThread,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/state$/,
        handler: getThreadState,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/state$/,
        handler: updateThreadState,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/state\/checkpoint$/,
        handler: getThreadStateAtCheckpoint,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/history$/,
        handler: getThreadHistory,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/history$/,
        handler: getThreadHistoryPost,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/copy$/,
        handler: copyThread,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/stream$/,
        handler: joinThreadStream,
    },

    // Runs
    // POST requests must come before GET requests with same path prefix
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/runs$/,
        handler: createRun,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/runs\/stream$/,
        handler: streamRun,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/runs\/wait$/,
        handler: waitRun,
    },
    {
        method: 'POST',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+\/cancel$/,
        handler: cancelRun,
    },
    // GET requests
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/runs$/,
        handler: listRuns,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+$/,
        handler: getRun,
    },
    {
        method: 'DELETE',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+$/,
        handler: deleteRun,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+\/join$/,
        handler: joinRun,
    },
    {
        method: 'GET',
        pattern: /^\/threads\/[^/]+\/runs\/[^/]+\/stream$/,
        handler: joinRunStream,
    },

    // Stateless Runs
    {
        method: 'POST',
        pattern: /^\/runs$/,
        handler: createStatelessRun,
    },
    {
        method: 'POST',
        pattern: /^\/runs\/stream$/,
        handler: streamStatelessRun,
    },
    {
        method: 'POST',
        pattern: /^\/runs\/wait$/,
        handler: waitStatelessRun,
    },
    {
        method: 'POST',
        pattern: /^\/runs\/batch$/,
        handler: createBatchRuns,
    },
    {
        method: 'POST',
        pattern: /^\/runs\/cancel$/,
        handler: cancelRuns,
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

// Export all functions without conflict
export { searchAssistants, countAssistants, getAssistant, deleteAssistant, patchAssistant, getAssistantGraph, getAssistantSubgraphs, getAssistantSubgraphsByNamespace, getAssistantSchemas, getAssistantVersions, setLatestAssistantVersion, createAssistant } from './assistants';
export { createThread, searchThreads, getThread, deleteThread, patchThread, countThreads, getThreadState, updateThreadState, getThreadStateAtCheckpoint, getThreadHistory, getThreadHistoryPost, copyThread, joinThreadStream } from './threads';
export { streamRun, joinRunStream, listRuns, cancelRun } from './runs';
export { createRun, waitRun, getRun, deleteRun, joinRun } from './runs-extended';
export { createStatelessRun, streamStatelessRun, waitStatelessRun, createBatchRuns, cancelRuns } from './runs-stateless';
