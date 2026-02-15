import { MessagesAnnotation, MessagesZodMeta, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createStateEntrypoint } from '../../src';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, createAgent, humanInTheLoopMiddleware, tool } from 'langchain';
import { withLangGraph } from '@langchain/langgraph/zod';

const State = MessagesAnnotation;
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

export const graph = new StateGraph(State)
    .addNode('test-entrypoint', async (state, config) => {
        const agent = createAgent({
            model: new ChatOpenAI({
                model: 'mimo-v2-flash',
                useResponsesApi: false,
                tags: ['test'],
                metadata: {
                    subagent: true,
                },
            }),
            systemPrompt: '你是一个智能助手',
            stateSchema: State,
            tools: [show_form, interrupt_test],
            middleware: [
                humanInTheLoopMiddleware({
                    interruptOn: {
                        interrupt_test: true,
                    },
                }),
            ],
        });
        const newState = await agent.invoke(state);
        return newState;
    })
    .addEdge('__start__', 'test-entrypoint')
    .compile();
