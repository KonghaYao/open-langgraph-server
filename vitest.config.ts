/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'dist/',
                'test/',
                '*.test.ts',
                '*.spec.ts',
            ],
        },
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        exclude: ['node_modules', 'dist'],
    },
});
