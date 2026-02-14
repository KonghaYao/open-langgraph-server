import { StateGraph } from '@langchain/langgraph';
import { START } from '@langchain/langgraph';
import { tool } from 'langchain';

const State = AgentState.extend({});

const sample_tool = tool(
    (state, config) => {
        return 'hello';
    },
    {
        name: 'sample_tool',
    },
);

export const graph = new StateGraph(State)
    .addSequence([
        [
            'a',
            (state, config) => {
                const data = sample_tool.invoke({});
                // new FakeChatModel({
                //     responses: [
                //         {
                //             role: 'assistant',
                //             content: 'hello',
                //         },
                //     ],
                // });
                return state;
            },
        ],
    ])
    .addEdge(START, 'a')
    .compile();
