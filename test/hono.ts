import { registerGraph } from '../src/createEndpoint';
import { graph as entrypoint } from './graph/entrypoint';
import { graph as entrypointGraph } from './graph/entrypoint-graph';
import { Hono } from 'hono';
import LangGraphApp, { type LangGraphServerContext } from '../src/adapter/hono/index';
import { cors } from 'hono/cors';

registerGraph('agent', entrypoint);
registerGraph('agent-graph', entrypointGraph);

const app = new Hono<{ Variables: LangGraphServerContext }>();

app.use(cors());

// Middleware to set langgraph context from request headers
app.use('*', async (c, next) => {
    c.set('langgraph_context', {
        userId: '3274923743297',
    });

    await next();
});

app.route('/', LangGraphApp);

export default {
    fetch: app.fetch,
    port: 8123,
};
