---
title: SolidJS Integration
---

# SolidJS Integration

The SDK provides a `ChatProvider` component and `useChat` hook for SolidJS applications.

## 1. Install Dependencies

First, ensure you have the necessary packages:

```bash
npm install @langgraph-js/sdk @nanostores/solid
```

## 2. Setup Provider

Wrap your application or chat component with `ChatProvider`:

```tsx
import { ChatProvider } from '@langgraph-js/sdk/solid';
import { MyChatComponent } from './MyChatComponent';

export const App = () => {
    return (
        <ChatProvider
            defaultAgent="agent"
            apiUrl="http://localhost:8123"
            defaultHeaders={
                {
                    // Add any auth headers here
                }
            }
            withCredentials={false}
            showHistory={true}
            showGraph={false}
            onInitError={(error, currentAgent) => {
                console.error(`Failed to initialize ${currentAgent}:`, error);
            }}
        >
            <MyChatComponent />
        </ChatProvider>
    );
};
```

## 3. Use Chat Hook

Use the `useChat` hook to access the store state and methods. Note that in SolidJS, the state is reactive.

```tsx
import { useChat } from '@langgraph-js/sdk/solid';
import { For } from 'solid-js';

export function MyChatComponent() {
    const chat = useChat();

    // Access state directly (it's a SolidJS store or reactive object)
    // chat.messages is reactive

    const handleSubmit = async (e) => {
        e.preventDefault();
        await chat.sendMessage('Hello!');
    };

    return (
        <div>
            <For each={chat.messages}>{(msg) => <div>{msg.content}</div>}</For>

            <button onClick={handleSubmit} disabled={chat.isLoading}>
                Send
            </button>
        </div>
    );
}
```
