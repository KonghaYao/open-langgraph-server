/**
 * 标题生成辅助函数
 * 用于在流结束后为 thread 生成标题
 */

import type { BaseThreadsManager } from '../threads/index.js';
import { LangGraphGlobal } from '../global.js';

/**
 * 为 thread 生成并保存标题
 * 在流结束后调用，避免侵入流处理逻辑
 *
 * @param threads ThreadsManager 实例
 * @param threadId 线程 ID
 * @param graphId Graph ID
 * @param runId Run ID
 */
export async function generateThreadTitle(
    threads: BaseThreadsManager<{ messages: any[] }>,
    threadId: string,
    graphId: string,
    runId: string,
): Promise<void> {
    const logContext = { threadId, graphId, runId };

    try {
        // 1. 获取 thread 以检查是否有 messages
        const thread = await threads.get(threadId);
        const state = thread.values;

        // 没有消息则跳过
        if (!state?.messages || !Array.isArray(state.messages) || state.messages.length === 0) {
            return;
        }

        // 2. 调用全局标题生成器
        const titleGenerator = LangGraphGlobal.getTitleGenerator();
        const title = await titleGenerator(state, {
            thread_id: threadId,
            graph_id: graphId,
            run_id: runId,
        });

        // 3. 使用原子操作保存标题（仅当标题为空时）
        if (title) {
            const success = await threads.setTitleIfNull(threadId, title);
            if (!success) {
                // 已有标题，跳过（正常情况，非错误）
                return;
            }
        }
    } catch (error) {
        // 标题生成失败不应影响主流程
        console.warn('Failed to generate thread title:', {
            ...logContext,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
