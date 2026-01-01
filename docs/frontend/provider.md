---
title: ChatProvider Configuration
---

# ChatProvider Configuration

The `ChatProvider` is the context provider that initializes the SDK and makes the chat store available to your application.

## Basic Setup

Wrap your application or the chat section of your app with `ChatProvider`:

```tsx
import { ChatProvider } from '@langgraph-js/sdk/react';

export const App = () => {
    return (
        <ChatProvider apiUrl="http://localhost:8123" defaultAgent="agent">
            <YourChatComponent />
        </ChatProvider>
    );
};
```

## Props Reference

### Required Props

-   **`apiUrl`**: `string` - The base URL of your LangGraph server (e.g., `http://localhost:3000/api`).
-   **`defaultAgent`**: `string` - The ID of the default agent graph to use.

### Optional Props

-   **`defaultHeaders`**: `Record<string, string>` - Custom headers to include with every request (e.g., for authentication tokens).
-   **`withCredentials`**: `boolean` - Whether to include cookies in cross-origin requests. Default: `false`.
-   **`showHistory`**: `boolean` - Whether to enable the history feature. Default: `false`.
-   **`showGraph`**: `boolean` - Whether to enable graph visualization features. Default: `false`.
-   **`fetch`**: `typeof fetch` - Custom fetch implementation (useful for Node.js environments or testing).
-   **`onInitError`**: `(error: unknown, agentId: string) => void` - Callback for when initialization fails.

## Configuration Examples

### With Authentication

```tsx
<ChatProvider
    apiUrl="https://api.example.com"
    defaultAgent="support-bot"
    defaultHeaders={{
        Authorization: 'Bearer YOUR_TOKEN',
    }}
>
    <App />
</ChatProvider>
```

### With Custom Fetch (e.g., for Ink/Node.js)

```tsx
import { LangGraphFetch } from './utils/fetch';

<ChatProvider
    apiUrl="http://localhost:8123"
    defaultAgent="cli-agent"
    fetch={LangGraphFetch}
    onInitError={(err) => console.error('Init failed:', err)}
>
    <TerminalApp />
</ChatProvider>;
```

### Dynamic Configuration

You can wrap the provider in a wrapper component to load configuration dynamically:

```tsx
const ChatWrapper = () => {
    const { config } = useSettings();

    if (!config) return <Loading />;

    return (
        <ChatProvider apiUrl={config.apiUrl} defaultAgent={config.agentName}>
            <Chat />
        </ChatProvider>
    );
};
```
