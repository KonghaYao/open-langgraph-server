---
title: useChat API Reference
---

# useChat API Reference

The `useChat` hook is the core interface for interacting with the chat session. It exposes a comprehensive set of reactive state properties and action methods.

## API Reference

### State Properties

These properties reflect the current state of the chat session.

-   **`renderMessages`**: `Message[]`

    -   The primary list of messages to display in the UI.
    -   Includes optimistic updates for immediate user feedback.
    -   Handles streaming token updates automatically.

-   **`loading`**: `boolean`

    -   Indicates whether the agent is currently processing a request or generating a response.
    -   Useful for disabling input fields or showing loading spinners.

-   **`userInput`**: `string`

    -   The current value of the chat input field.
    -   Controlled by `setUserInput`.

-   **`inChatError`**: `unknown | null`

    -   Contains any error that occurred during the last operation (e.g., network failure, validation error).
    -   Null if no error is present.

-   **`collapsedTools`**: `Record<string, boolean>`
    -   A map of tool call IDs to their collapsed state.
    -   Used for toggling the visibility of verbose tool outputs in the UI.

### Actions

These methods allow you to modify the state or trigger side effects.

-   **`sendMessage(content: string | Message[], options?: { extraParams?: Record<string, any> })`**

    -   Sends a new message to the agent.
    -   `content`: Can be a simple string or an array of Message objects (for complex structures).
    -   `options.extraParams`: Additional parameters to pass to the backend graph execution (e.g., model selection, temperature).

-   **`setUserInput(input: string)`**

    -   Updates the `userInput` state.
    -   Should be bound to your input component's `onChange` event.

-   **`createNewChat()`**

    -   Resets the current thread ID and state, effectively starting a fresh conversation.
    -   Clears existing messages.

-   **`toggleToolCollapse(toolId: string)`**

    -   Toggles the visibility state of a specific tool output.
    -   Updates `collapsedTools`.

-   **`toggleHistoryVisible()`**
    -   Toggles the visibility boolean for the history list sidebar (if your UI implements one).

## Advanced Example: CLI Interface

The following example demonstrates how to combine these APIs to build a complex interface, similar to a terminal-based chat.

> Note: This example uses React syntax, but the logic and API usage are identical for Vue and SolidJS.

```tsx
import { useChat } from '@langgraph-js/sdk/react';
// Assuming you have UI components like Box, Spinner, etc.

const ChatMessages = () => {
    // Destructure the state we need
    const { renderMessages, loading, inChatError } = useChat();

    return (
        <Box flexDirection="column">
            {/* Render the message list */}
            <MessagesBox messages={renderMessages} />

            {/* Show spinner when agent is thinking */}
            {loading && <Spinner />}

            {/* Display errors if any occur */}
            {inChatError && <ErrorDisplay error={inChatError} />}
        </Box>
    );
};

const ChatInput = () => {
    // Destructure actions and input state
    const { userInput, setUserInput, sendMessage } = useChat();

    const handleSubmit = () => {
        if (!userInput) return;

        // Send message as a structured object
        sendMessage([
            {
                type: 'human',
                content: userInput,
            },
        ]);

        // Clear input after sending
        setUserInput('');
    };

    return <TextInput value={userInput} onChange={setUserInput} onSubmit={handleSubmit} />;
};
```
