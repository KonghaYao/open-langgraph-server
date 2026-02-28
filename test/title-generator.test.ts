import { describe, it, expect } from 'vitest';
import { defaultTitleGenerator, TitleGenerator } from '../src/utils/titleGenerator';

describe('TitleGenerator', () => {
    const context = { thread_id: 'test-thread', graph_id: 'test-graph', run_id: 'test-run' };

    describe('defaultTitleGenerator', () => {
        it('should extract title from string content', () => {
            const state = {
                messages: [{ content: '这是一段很长的文本内容，用于测试标题提取功能是否正常工作' }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('这是一段很长的文本内容，用于测...');
        });

        it('should handle short content without ellipsis', () => {
            const state = {
                messages: [{ content: '短文本' }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('短文本');
        });

        it('should handle content with newlines', () => {
            const state = {
                messages: [{ content: '第一行\n第二行\n第三行' }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('第一行 第二行 第三行');
        });

        it('should handle content with leading/trailing whitespace', () => {
            const state = {
                messages: [{ content: '   带空格的文本   ' }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('带空格的文本');
        });

        it('should handle empty messages array', () => {
            const state = { messages: [] };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBeNull();
        });

        it('should handle missing messages', () => {
            const state = {};
            const result = defaultTitleGenerator(state, context);
            expect(result).toBeNull();
        });

        it('should handle null messages', () => {
            const state = { messages: null };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBeNull();
        });

        it('should handle multi-part content with text', () => {
            const state = {
                messages: [
                    {
                        content: [
                            { type: 'image', image: 'url' },
                            { type: 'text', text: '这是文本部分的内容' },
                        ],
                    },
                ],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('这是文本部分的内容');
        });

        it('should handle multi-part content without text', () => {
            const state = {
                messages: [
                    {
                        content: [{ type: 'image', image: 'url' }],
                    },
                ],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBeNull();
        });

        it('should handle content with text property', () => {
            const state = {
                messages: [{ content: { text: '这是一个对象形式的文本' } }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('这是一个对象形式的文本');
        });

        it('should handle empty string content', () => {
            const state = {
                messages: [{ content: '' }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBeNull();
        });

        it('should handle whitespace-only content', () => {
            const state = {
                messages: [{ content: '   \n\t   ' }],
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBeNull();
        });

        it('should handle exactly 15 characters', () => {
            const state = {
                messages: [{ content: '一二三四五六七八九十一二三四五' }], // 正好15个字符
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('一二三四五六七八九十一二三四五');
            expect(result?.endsWith('...')).toBe(false);
        });

        it('should handle 16 characters (add ellipsis)', () => {
            const state = {
                messages: [{ content: '一二三四五六七八九十一二三四五六' }], // 16个字符
            };
            const result = defaultTitleGenerator(state, context);
            expect(result).toBe('一二三四五六七八九十一二三四五...');
        });

        it('should support async title generators', async () => {
            const asyncGenerator: TitleGenerator = async (state) => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return 'Async Title';
            };

            const state = { messages: [{ content: 'test' }] };
            const result = await asyncGenerator(state, context);
            expect(result).toBe('Async Title');
        });
    });
});
