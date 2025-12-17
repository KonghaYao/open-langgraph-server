---
title: Vite Build Configuration
---

# Building Open LangGraph Server Projects with Vite

This document explains how to use Vite to bundle an entire Open LangGraph Server project into production-ready build artifacts. This is particularly useful for scenarios where you need to deploy a LangGraph server independently.

## Overview

Key advantages of using Vite to build Open LangGraph Server projects:

-   ✅ **Single-file deployment**: Bundle the entire project into standalone JavaScript files
-   ✅ **Dependency optimization**: Automatically handle external dependencies to reduce bundle size
-   ✅ **Static asset handling**: Automatically copy necessary static resource files
-   ✅ **ESM support**: Generate standard ES module format
-   ✅ **Developer experience**: Fast builds and hot module replacement

## Installing Dependencies

First, install the necessary Vite plugins:

```bash
pnpm add -D vite rollup-plugin-node-externals vite-plugin-static-copy
```

## Configuration File

Create a `vite.config.ts` file:

```typescript
import { defineConfig } from 'vite';
import nodeExternals from 'rollup-plugin-node-externals';

export default defineConfig({
    plugins: [
        nodeExternals({
            builtins: true,
            deps: false,
            devDeps: false,
            peerDeps: false,
            optDeps: false,
            include: ['bun:sqlite', 'path', 'crypto', 'util', 'stream', 'fs'],
        }),
    ],
    // Global variable replacement
    define: {
        __filename: 'import.meta.filename',
        'window.FormData': 'globalThis.FormData',
    },
    build: {
        outDir: './build',
        target: 'es2022',
        lib: {
            entry: ['./agent/raw-server.ts'], // your hono server endpoint
            formats: ['es'],
        },
        minify: false,
        sourcemap: false,
    },
});
```
