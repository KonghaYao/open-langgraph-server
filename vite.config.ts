import type { UserConfig } from 'vite';
import { nodeExternals } from 'rollup-plugin-node-externals';

export default {
    plugins: [nodeExternals({ include: ['bun:sqlite', 'next/server'] })],
    build: {
        lib: {
            entry: {
                index: 'src/index.ts',
                'adapter/hono/index': 'src/adapter/hono/index.ts',
                'adapter/nextjs/index': 'src/adapter/nextjs/index.ts',
                'adapter/fetch/index': 'src/adapter/fetch/index.ts',
            },
            formats: ['es'],
        },
        sourcemap: true,
        target: 'esnext',
        minify: false,
    },
} as UserConfig;
