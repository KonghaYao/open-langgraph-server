---
title: Studio
---

# Studio

Studio provides an interactive UI for testing and debugging your LangGraph applications. It connects to your running LangGraph server and provides a visual interface for graph execution and debugging.

## Prerequisites

**Important**: Your LangGraph server must be running on port 8123 before starting Studio. Make sure you've completed the [Installation guide](./index.md) and have your server running:

```bash
src/app.ts  # Your langgraph server should be running on http://localhost:8123
```

## Installation

You can run Studio in two ways:

### Option 1: Direct execution (Recommended)

Use npx to run Studio without installation:

```bash
npx @langgraph-js/ui
```

### Option 2: Install as dev dependency

Add Studio to your dev dependencies:

```bash
pnpm add -D @langgraph-js/ui
```

Then run it with:

```bash
pnpm langgraph-ui
```

## Advanced Configuration

Studio can be configured with additional options for different environments:

### Custom Host and Port

```bash
# Run Studio on a different port
npx @langgraph-js/ui --port 8888

# Specify custom host
npx @langgraph-js/ui --host localhost.example.com --port 8888
```

### HTTPS Mode

```bash
# Enable HTTPS mode for secure connections
npx @langgraph-js/ui --mode https --port 8443
```

### Combined Options

```bash
# Full configuration example
npx @langgraph-js/ui --host localhost.example.com --port 8888 --mode https
```

**Note**: Your LangGraph server must always run on port 8123. Studio can run on any available port and will automatically connect to your LangGraph server.

## Access Studio

Once Studio is running, open your browser and navigate to the URL shown in your terminal.

Studio will automatically connect to your LangGraph server running on port 8123 and provide a visual interface for:

-   **Graph Visualization**: Interactive graph exploration and node inspection
-   **Real-time Execution**: Live execution monitoring with step-by-step updates
-   **Interactive Testing**: Input simulation and state debugging
-   **Execution History**: View past runs and performance metrics

**Important**: Studio can run on any port, but your LangGraph server must always be accessible on port 8123.
