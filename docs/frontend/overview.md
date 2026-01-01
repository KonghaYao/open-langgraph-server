---
title: Frontend Integration Overview
---

# Frontend Integration Overview

Pure Graph provides a compatible API for LangGraph Server. You can use the official `@langgraph-js/sdk` to build reactive frontend applications with built-in state management.

## Features

-   **Reactive Store**: Built on [Nano Stores](https://github.com/nanostores/nanostores), providing a framework-agnostic state management solution.
-   **Framework Integrations**: Ready-to-use hooks and components for React and Vue.
-   **Streaming Support**: Built-in handling of streaming events from your graphs.
-   **Authentication**: Easy integration with custom headers and credentials.

## Installation

Install the core SDK and your framework-specific adapter:

```bash
# Core SDK
npm install @langgraph-js/sdk

# For React
npm install @nanostores/react

# For Vue
npm install @nanostores/vue

# For Solid
npm install @nanostores/solid
```
