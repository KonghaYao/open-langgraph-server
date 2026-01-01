---
title: Vue Integration
---

# Vue Integration

The SDK provides a `ChatProvider` component and composables for Vue applications.

## 1. Install Dependencies

First, ensure you have the necessary packages:

```bash
npm install @langgraph-js/sdk @nanostores/vue
```

## 2. Setup Provider

Use the `ChatProvider` component in your template:

```vue
<template>
    <ChatProvider
        :default-agent="'agent'"
        :api-url="'http://localhost:8123'"
        :default-headers="{}"
        :with-credentials="false"
        :show-history="true"
        :show-graph="false"
        :on-init-error="onInitError"
    >
        <ChatComp />
    </ChatProvider>
</template>

<script setup lang="ts">
import { ChatProvider } from "@langgraph-js/sdk/vue";
import ChatComp from "./ChatComp.vue";

const onInitError = (error: any, currentAgent: string) => {
    console.error(`Failed to initialize ${currentAgent}:`, error);
};
</script>
```

## 3. Use Chat Composable

Use `useChat` within your components to interact with the store:

```vue
<!-- ChatComp.vue -->
<script setup lang="ts">
import { useChat } from "@langgraph-js/sdk/vue";

const chat = useChat();

// The store state is reactive
// Access messages via chat.messages
</script>

<template>
    <div>
        <div v-for="(msg, i) in chat.messages" :key="i">
            {{ msg.content }}
        </div>
        
        <button 
            @click="chat.sendMessage('Hello!')"
            :disabled="chat.isLoading"
        >
            Send
        </button>
    </div>
</template>
```

