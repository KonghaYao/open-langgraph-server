---
title: Advanced Usage (Store)
---

# Advanced Usage: Creating a Chat Store

For more control or for using the SDK without framework-specific bindings, you can create a reactive store directly using `createChatStore`.

## Creating a Store

You can define a global store instance that can be imported anywhere in your application.

```typescript
import { createChatStore } from '@langgraph-js/sdk';

export const globalChatStore = createChatStore(
    'agent', // The default agent ID
    {
        // Custom LangGraph backend URL
        apiUrl: 'http://localhost:8123',

        // Custom headers (e.g., for authentication)
        defaultHeaders: {
            Authorization: 'Bearer token...',
        },

        // Advanced caller options
        callerOptions: {
            // Example: including credentials (cookies) with requests
            // fetch(url: string, options: RequestInit) {
            //     options.credentials = "include";
            //     return fetch(url, options);
            // },
        },
    },
    {
        // Initialization callback
        onInit(client) {
            // Example: bind tools or perform initial setup
            // client.tools.bindTools([...]);
        },
    },
);
```

## Using the Store

The store is a [Nano Stores](https://github.com/nanostores/nanostores) instance. You can subscribe to changes or use it directly.

```typescript
// Subscribe to changes
globalChatStore.subscribe((state) => {
    console.log('New messages:', state.messages);
});

// Send a message
await globalChatStore.sendMessage('Hello world');
```
