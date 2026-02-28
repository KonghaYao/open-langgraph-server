import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { BaseStreamQueueInterface, StreamQueueManager } from './queue/stream_queue.js';
import { createCheckPointer, createMessageQueue, createThreadManager } from './storage/index.js';
import type { SqliteSaver } from './storage/sqlite/checkpoint.js';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { BaseThreadsManager } from './threads/index.js';
import { TitleGenerator, defaultTitleGenerator } from './utils/titleGenerator.js';

export class LangGraphGlobal {
    static globalMessageQueue: StreamQueueManager<BaseStreamQueueInterface> = null as any;
    static globalCheckPointer: BaseCheckpointSaver = null as any;
    static globalThreadsManager: BaseThreadsManager = null as any;
    static isInitialized: Promise<void> | null = null;

    /**
     * 全局标题生成器
     * 可通过 setTitleGenerator 替换
     */
    private static _titleGenerator: TitleGenerator = defaultTitleGenerator;

    /**
     * 设置自定义标题生成器
     * @param generator 标题生成函数，传入 null 可禁用标题生成
     */
    static setTitleGenerator(generator: TitleGenerator): void {
        LangGraphGlobal._titleGenerator = generator;
    }

    /**
     * 获取当前标题生成器
     */
    static getTitleGenerator(): TitleGenerator {
        return LangGraphGlobal._titleGenerator;
    }

    static async initGlobal() {
        if (LangGraphGlobal.isInitialized) {
            return LangGraphGlobal.isInitialized;
        }
        LangGraphGlobal.isInitialized = (async () => {
            const [globalMessageQueue, globalCheckPointer] = await Promise.all([
                createMessageQueue(),
                createCheckPointer(),
            ]);
            console.debug('LG | checkpointer created');
            const globalThreadsManager = await createThreadManager({
                checkpointer: globalCheckPointer as SqliteSaver | PostgresSaver,
            });
            console.debug('LG | threads manager created');
            console.debug('LG | global init done');
            LangGraphGlobal.globalMessageQueue = globalMessageQueue;
            LangGraphGlobal.globalCheckPointer = globalCheckPointer;
            LangGraphGlobal.globalThreadsManager = globalThreadsManager;
        })();
        return LangGraphGlobal.isInitialized;
    }
}
