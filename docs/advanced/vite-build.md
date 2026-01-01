---
title: Vite Build Configuration
---

# Building Open LangGraph Server Projects with Vite

This document explains how to use Vite to bundle an entire Open LangGraph Server project into production-ready build artifacts. This is particularly useful for scenarios where you need to deploy a LangGraph server independently (e.g., Docker, AWS Lambda, VPS).

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

Create a `vite.config.ts` file in your project root. This configuration handles Node.js built-ins, excludes dependencies that shouldn't be bundled, and sets up static asset copying.

```typescript
import { defineConfig } from 'vite';
import nodeExternals from 'rollup-plugin-node-externals';

export default defineConfig({
    plugins: [
        // Automatically mark node_modules as external
        nodeExternals({
            builtins: true,
            // Bundle all dependencies by default for a standalone file
            // Change to true if you want to keep node_modules separate
            deps: false,
            devDeps: false,
            peerDeps: false,
            optDeps: false,
            // Force include specific packages if needed
            include: ['bun:sqlite', 'path', 'crypto', 'util', 'stream', 'fs'],
        }),
    ],
    // Global variable replacement
    define: {
        __filename: 'import.meta.filename',
        'window.FormData': 'globalThis.FormData',
    },
    build: {
        outDir: './dist', // Output directory
        target: 'es2022', // Modern Node.js target
        lib: {
            // Your server entry point (e.g., Hono or Node.js server)
            entry: ['./src/server.ts'],
            formats: ['es'],
        },
        minify: false, // Set to true for smaller builds, false for debugging
        sourcemap: true, // Helpful for debugging production issues
    },
});
```

## Adding Build Scripts

Add the following scripts to your `package.json`:

```json
{
    "scripts": {
        "build": "vite build",
        "start": "node dist/server.js"
    }
}
```

## Running the Build

Execute the build command:

```bash
npm run build
```

This will generate a `dist` folder containing your bundled server and any static assets.

## Deployment

### Running with Node.js

```bash
node dist/server.js
```

### Running with Bun

```bash
bun dist/server.js
```
