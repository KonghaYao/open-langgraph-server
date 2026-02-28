/**
 * 标题生成器类型定义和默认实现
 * 用于在 thread 首次更新时自动生成会话标题
 */

/**
 * 标题生成函数类型
 * @param state Graph 的 state 对象
 * @param context 上下文信息（thread_id, graph_id, run_id 等）
 * @returns 生成的标题，返回 null 表示不生成标题
 */
export type TitleGenerator = (
    state: Record<string, any>,
    context: {
        thread_id: string;
        graph_id: string;
        run_id: string;
    },
) => Promise<string | null> | string | null;

/**
 * 从消息内容中提取纯文本
 * 支持多种 content 格式
 */
function extractTextContent(content: any): string {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        // 处理多部分内容（如图片+文本）
        const textPart = content.find((part) => part.type === 'text');
        return textPart?.text || '';
    }

    if (content?.text) {
        return content.text;
    }

    return '';
}

/**
 * 默认标题生成器
 * 从 messages[0].content 提取前 15 个字符
 */
export const defaultTitleGenerator: TitleGenerator = (state, context) => {
    const messages = state?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return null;
    }

    const firstMessage = messages[0];
    if (!firstMessage) {
        return null;
    }

    // 提取文本内容
    const content = extractTextContent(firstMessage.content);
    if (!content) {
        return null;
    }

    // 清理并截取前 15 个字符
    const cleanedContent = content.trim().replace(/\n/g, ' ');
    if (!cleanedContent) {
        return null;
    }

    // 截取前 15 个字符（支持多字节字符）
    const maxLength = 15;
    const title = cleanedContent.slice(0, maxLength);

    // 如果被截断，添加省略号
    return title.length < cleanedContent.length ? `${title}...` : title;
};
