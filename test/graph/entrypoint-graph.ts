import { entrypoint, MessagesZodMeta, getConfig, interrupt, MemorySaver } from '@langchain/langgraph';
import { z } from 'zod/v3';
import { createStateEntrypoint, LangGraphGlobal } from '../../src/';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, createAgent, humanInTheLoopMiddleware, tool } from 'langchain';
import { AgentState } from '@langgraph-js/pro';

const State = AgentState;
const show_form = tool(
    (props) => {
        console.log(props);
        return 'good';
    },
    {
        name: 'show_form',
        description: '显示一个 rjsf schema 定义的表单',
        schema: z.object({
            schema: z.any().describe('@rjsf/core 所需要的 form schema， 对象格式，而非 json 字符串'),
        }),
    },
);
const interrupt_test = tool(
    (props) => {
        console.log(props);
        return 'good';
    },
    {
        name: 'interrupt_test',
        description: '测试中断',
        schema: z.object({
            message: z.string().describe('中断消息'),
        }),
    },
);

const workflow = async (state: z.infer<typeof State>, config) => {
    console.log('Context:', config);
    const agent = createAgent({
        model: new ChatOpenAI({
            model: 'gpt-4o-mini',
            useResponsesApi: false,
            tags: ['test'],
            metadata: {
                subagent: true,
            },
        }),
        systemPrompt: '你是一个智能助手',
        tools: [show_form, interrupt_test],
        middleware: [
            humanInTheLoopMiddleware({
                interruptOn: {
                    interrupt_test: true,
                },
            }),
        ],
    });
    return agent.invoke(state);
};

export const graph = createStateEntrypoint(
    {
        name: 'graph',
        stateSchema: State,
    },
    workflow,
);
