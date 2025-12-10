import {
    CompiledGraph,
    entrypoint,
    EntrypointOptions,
    getConfig,
    getPreviousState,
    LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { schemaMetaRegistry } from '@langchain/langgraph/zod';
import z from 'zod';
import { getDefaultsForSchema } from 'zod-defaults';
const composeWithState = <T>(oldState: T, newState: T, stateSchema: any) => {
    const channels = schemaMetaRegistry.getChannelsForSchema(stateSchema);

    const previewState = stateSchema.parse(oldState || getDefaultsForSchema(stateSchema));
    // 使用 channels 的 reducer 来合并 state
    const mergedState = { ...previewState };
    for (const [channelName, _] of Object.entries(channels)) {
        const currentValue = (previewState as any)[channelName];
        const newValue = (newState as any)[channelName];

        // 只有当 update 中包含该 channel 的值时才处理
        if (newValue !== undefined) {
            let reducer;
            // 尝试从 schema 中查找 reducer
            // 需要解包 ZodDefault, ZodOptional 等包装器
            let currentSchema = stateSchema.shape[channelName];
            while (currentSchema) {
                const meta = schemaMetaRegistry.get(currentSchema);
                if (meta?.reducer?.fn) {
                    reducer = meta.reducer.fn;
                    break;
                }
                if (currentSchema._def?.innerType) {
                    currentSchema = currentSchema._def.innerType;
                } else if (currentSchema._def?.schema) {
                    currentSchema = currentSchema._def.schema;
                } else {
                    break;
                }
            }

            if (reducer && typeof reducer === 'function') {
                // 使用 reducer 函数合并值
                (mergedState as any)[channelName] = reducer(currentValue, newValue);
            } else {
                // 如果没有 reducer，直接使用新值覆盖
                (mergedState as any)[channelName] = newValue;
            }
        }
    }

    return mergedState;
};
export const createStateEntrypoint = <ZType extends z.ZodType>(
    options: EntrypointOptions & { stateSchema: ZType },
    mainLogic: (state: z.infer<ZType>, config: LangGraphRunnableConfig) => Promise<any>,
): CompiledGraph<any, any, any, any, any, any, any, any, any> => {
    const res = entrypoint(options, async (state, ...args) => {
        state = composeWithState(getPreviousState<ZType>(), state, options.stateSchema);
        // 更新 state 并保证 state 被推送
        getConfig()?.configurable?.__pregel_stream?.push([[], 'values', state]);
        const newState = await mainLogic(state as z.infer<ZType>, ...args);
        return entrypoint.final({
            value: newState,
            save: newState,
        });
    });
    // entrypoint 的 state 更新逻辑不一样
    const updateState = res.updateState;
    res.updateState = async function (config: any, state: any, ...args) {
        state = composeWithState((await res.getState(config)).values, state, options.stateSchema);
        return updateState.bind(this)(config, state, ...args);
    };
    return res as any;
};
