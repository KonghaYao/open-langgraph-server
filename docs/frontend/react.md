---
title: React Integration
---

# React Integration

The SDK provides a `ChatProvider` component and `useChat` hook for React applications.

## Installation

First, ensure you have the necessary packages:

```bash
npm install @langgraph-js/sdk @nanostores/react
```

## Setup

Wrap your application with `ChatProvider` (see [Provider Configuration](provider) for details) and use the `useChat` hook in your components.

```tsx
import { useChat } from '@langgraph-js/sdk/react';

export function ChatComponent() {
    const { userInput, setUserInput, sendMessage, renderMessages, loading } = useChat();

    const handleSend = () => {
        sendMessage(userInput);
        setUserInput('');
    };

    return (
        <div>
            {renderMessages.map((msg, i) => (
                <div key={i}>{msg.content}</div>
            ))}
            <input value={userInput} onChange={(e) => setUserInput(e.target.value)} />
            <button onClick={handleSend} disabled={loading}>
                Send
            </button>
        </div>
    );
}
```

## API Reference

For a complete list of properties and methods available on the `useChat` hook, please refer to the **[useChat API Reference](use-chat)** documentation.
