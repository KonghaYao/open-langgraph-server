import { Command } from '@langchain/langgraph';
import { HumanMessage, tool } from 'langchain';
import { z } from 'zod';
import { Message } from '@langchain/core/messages';
import { type ToolRuntime } from '@langchain/core/tools';

export const SubAgentStateSchema = z.object({
    task_store: z.record(z.string(), z.any()).default({}),
});

const schema = z.object({
    task_id: z
        .string()
        .optional()
        .describe('The task id to ask the subagent, if not provided, will use the tool call id'),
    subagent_id: z.string(),
    task_description: z.string().describe('Describe the user state and what you want the subagent to do.'),
    data_transfer: z.any().optional().describe('Data to transfer to the subagent.'),
});

export const ask_subagents = (
    agentCreator: (task_id: string, args: z.infer<typeof schema>, parent_state: any) => Promise<any>,
    options?: {
        name?: string;
        description?: string;
        pass_through_keys?: string[];
    },
) =>
    tool(
        async (args, config: ToolRuntime<typeof SubAgentStateSchema, any>) => {
            const state = config.state;
            const taskId: string = args.task_id || config.toolCall!.id!;
            let sub_state = {
                messages: [] as Message[],
            };
            if (taskId && (state as any)?.['task_store']?.[taskId]) {
                sub_state = (state as any)?.['task_store'][taskId];
            } else {
                // 全复制状态
                sub_state = JSON.parse(JSON.stringify(state));
                sub_state.messages = [];
                /** @ts-ignore 不继承 task_store 中的信息 */
                sub_state.task_store = {};
            }

            const agent = await agentCreator(taskId, args, state);
            sub_state.messages.push(new HumanMessage({ content: args.task_description }));
            if (args.data_transfer) {
                sub_state.messages.push(
                    new HumanMessage({
                        content: `Here is the data to help you complete the task: ${JSON.stringify(
                            args.data_transfer,
                            null,
                            2,
                        )}`,
                    }),
                );
            }
            const new_state = await agent.invoke(sub_state);
            const last_message = new_state['messages'].at(-1);

            const update: any = {
                task_store: {
                    ...(state?.['task_store'] || {}),
                    [taskId]: new_state,
                },
                messages: [
                    {
                        role: 'tool',
                        content: `task_id: ${taskId}\n---\n` + (last_message?.text || ''),
                        tool_call_id: config.toolCall!.id!,
                    },
                ],
            };

            options?.pass_through_keys?.forEach((key) => {
                if (key in new_state) {
                    update[key] = new_state[key];
                }
            });

            return new Command({
                update,
            });
        },
        {
            name: options?.name || 'ask_subagents',
            description: options?.description || 'ask subagents to help you',
            schema,
        },
    );
