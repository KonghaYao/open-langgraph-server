---
title: Context Passing and Injection
---

## Context Passing and Injection

### Advanced Context Patterns

#### Dynamic Context with User Authentication

```typescript
// middleware/auth.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyJWT } from '@/lib/auth';

export async function authMiddleware(request: NextRequest) {
    const token = request.cookies.get('auth-token')?.value;

    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const user = await verifyJWT(token);

        // Inject comprehensive user context
        const langgraphContext = {
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                permissions: user.permissions,
            },
            session: {
                id: request.cookies.get('session-id')?.value,
                ip: request.ip || request.headers.get('x-forwarded-for'),
                userAgent: request.headers.get('user-agent'),
            },
            preferences: user.preferences || {},
            metadata: {
                source: 'web-app',
                timestamp: new Date().toISOString(),
                version: process.env.APP_VERSION,
            },
        };

        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('x-langgraph-context', JSON.stringify(langgraphContext));

        return NextResponse.next({
            request: { headers: requestHeaders },
        });
    } catch (error) {
        return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }
}
```

#### Context-Aware Graph with Personalized Responses

```typescript
// agent/personalized-assistant.ts
import { entrypoint, getConfig } from '@langchain/langgraph';
import { createReactAgent, createReactAgentAnnotation } from '@langchain/langgraph/prebuilt';
import { createState } from '@langgraph-js/pro';
import { createEntrypointGraph } from '@langgraph-js/pure-graph';
import { ChatOpenAI } from '@langchain/openai';

const State = createState(createReactAgentAnnotation()).build({});

const workflow = entrypoint('personalized-assistant', async (state) => {
    const config = getConfig();

    // Extract user context
    const user = config.configurable?.user;
    const preferences = config.configurable?.preferences;
    const session = config.configurable?.session;

    // Build personalized system prompt
    const systemPrompt = buildPersonalizedPrompt(user, preferences);

    // Log context for debugging
    console.log('Processing request for user:', {
        userId: user?.id,
        role: user?.role,
        sessionId: session?.id,
    });

    const agent = createReactAgent({
        llm: new ChatOpenAI({
            model: preferences?.model || 'gpt-4',
            temperature: preferences?.temperature || 0.7,
        }),
        prompt: systemPrompt,
        tools: getUserTools(user?.permissions),
    });

    return agent.invoke(state);
});

function buildPersonalizedPrompt(user: any, preferences: any) {
    const basePrompt = 'You are a helpful AI assistant.';

    const customizations = [];

    if (user?.role === 'premium') {
        customizations.push('Provide detailed, comprehensive responses.');
    }

    if (preferences?.communication_style === 'formal') {
        customizations.push('Use formal language and professional tone.');
    }

    if (preferences?.expertise_areas?.length > 0) {
        customizations.push(`You have expertise in: ${preferences.expertise_areas.join(', ')}.`);
    }

    return [basePrompt, ...customizations].join(' ');
}

function getUserTools(permissions: string[]) {
    const tools = [];

    if (permissions?.includes('search')) {
        tools.push(new TavilySearchResults({}));
    }

    if (permissions?.includes('calculator')) {
        tools.push(new CalculatorTool());
    }

    return tools;
}

export const graph = createEntrypointGraph({
    stateSchema: State,
    graph: workflow,
});
```

### Context Validation and Type Safety

```typescript
// types/context.ts
import { z } from 'zod';

export const UserContextSchema = z.object({
    id: z.string(),
    email: z.string().email(),
    role: z.enum(['free', 'premium', 'enterprise']),
    permissions: z.array(z.string()),
    preferences: z
        .object({
            model: z.string().optional(),
            temperature: z.number().min(0).max(2).optional(),
            communication_style: z.enum(['casual', 'formal']).optional(),
            expertise_areas: z.array(z.string()).optional(),
        })
        .optional(),
});

export const SessionContextSchema = z.object({
    id: z.string(),
    ip: z.string(),
    userAgent: z.string().optional(),
});

export const LangGraphContextSchema = z.object({
    user: UserContextSchema,
    session: SessionContextSchema,
    metadata: z.object({
        source: z.string(),
        timestamp: z.string(),
        version: z.string().optional(),
    }),
});

// types/index.ts
export type UserContext = z.infer<typeof UserContextSchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type LangGraphContext = z.infer<typeof LangGraphContextSchema>;
```

```typescript
// middleware/context-validation.ts
import { NextRequest, NextResponse } from 'next/server';
import { LangGraphContextSchema } from '@/types/context';

export function validateContextMiddleware(request: NextRequest) {
    const contextHeader = request.headers.get('x-langgraph-context');

    if (!contextHeader) {
        return NextResponse.json({ error: 'Missing context' }, { status: 400 });
    }

    try {
        const context = JSON.parse(contextHeader);
        const validatedContext = LangGraphContextSchema.parse(context);

        // Add validated context back to headers
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('x-langgraph-context', JSON.stringify(validatedContext));

        return NextResponse.next({
            request: { headers: requestHeaders },
        });
    } catch (error) {
        return NextResponse.json({ error: 'Invalid context format', details: error.errors }, { status: 400 });
    }
}
```

## Custom Graph Architectures

### Multi-Agent Orchestration

```typescript
// agent/multi-agent-orchestrator.ts
import { StateGraph, START, END } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

// Define the state
const OrchestratorState = z.object({
    messages: z.array(z.any()),
    current_agent: z.string().optional(),
    task_analysis: z
        .object({
            complexity: z.enum(['simple', 'medium', 'complex']),
            required_skills: z.array(z.string()),
            estimated_time: z.number(),
        })
        .optional(),
    results: z.record(z.string(), z.any()),
});

// Create specialized agents
const agents = {
    researcher: createReactAgent({
        llm: new ChatOpenAI({ model: 'gpt-4' }),
        prompt: 'You are a research specialist. Provide comprehensive, factual information.',
        tools: [
            /* research tools */
        ],
    }),

    analyst: createReactAgent({
        llm: new ChatOpenAI({ model: 'gpt-4' }),
        prompt: 'You are a data analyst. Analyze information and provide insights.',
        tools: [
            /* analysis tools */
        ],
    }),

    writer: createReactAgent({
        llm: new ChatOpenAI({ model: 'gpt-4' }),
        prompt: 'You are a content writer. Create engaging, well-structured content.',
        tools: [
            /* writing tools */
        ],
    }),
};

// Orchestrator workflow
const workflow = new StateGraph(OrchestratorState)
    .addNode('analyze_task', async (state) => {
        // Analyze the incoming task
        const analysis = await analyzeTaskComplexity(state.messages);
        return {
            ...state,
            task_analysis: analysis,
        };
    })

    .addNode('route_to_agent', async (state) => {
        const { complexity, required_skills } = state.task_analysis!;

        let selectedAgent = 'researcher'; // default

        if (complexity === 'complex' || required_skills.includes('analysis')) {
            selectedAgent = 'analyst';
        } else if (required_skills.includes('writing')) {
            selectedAgent = 'writer';
        }

        return {
            ...state,
            current_agent: selectedAgent,
        };
    })

    .addNode('execute_with_agent', async (state) => {
        const agent = agents[state.current_agent as keyof typeof agents];
        const result = await agent.invoke(state);

        return {
            ...state,
            results: {
                ...state.results,
                [state.current_agent!]: result,
            },
        };
    })

    .addNode('synthesize_results', async (state) => {
        if (Object.keys(state.results).length === 1) {
            // Single agent result
            return state.results[Object.keys(state.results)[0]];
        }

        // Synthesize multiple results
        const synthesis = await synthesizeMultipleResults(state.results);
        return synthesis;
    })

    .addEdge(START, 'analyze_task')
    .addEdge('analyze_task', 'route_to_agent')
    .addEdge('route_to_agent', 'execute_with_agent')
    .addEdge('execute_with_agent', 'synthesize_results')
    .addEdge('synthesize_results', END);

async function analyzeTaskComplexity(messages: any[]) {
    // Implement task analysis logic
    const lastMessage = messages[messages.length - 1];

    // Simple heuristic-based analysis
    const complexity = lastMessage.content.length > 500 ? 'complex' : 'simple';
    const required_skills = [];

    if (lastMessage.content.includes('analyze') || lastMessage.content.includes('data')) {
        required_skills.push('analysis');
    }

    if (lastMessage.content.includes('write') || lastMessage.content.includes('create')) {
        required_skills.push('writing');
    }

    return {
        complexity,
        required_skills,
        estimated_time: complexity === 'complex' ? 300 : 60, // seconds
    };
}

async function synthesizeMultipleResults(results: Record<string, any>) {
    // Combine results from multiple agents
    const combinedContent = Object.entries(results)
        .map(([agent, result]) => `${agent.toUpperCase()}: ${result.content}`)
        .join('\n\n');

    return {
        content: `Synthesis of multiple expert analyses:\n\n${combinedContent}`,
        role: 'assistant',
    };
}

export const multiAgentGraph = workflow.compile();
```

### Event-Driven Graphs

```typescript
// agent/event-driven-graph.ts
import { StateGraph, START, END } from '@langchain/langgraph';
import { RunnableLambda } from '@langchain/core/runnables';
import { z } from 'zod';

// Event types
const EventSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('user_message'),
        content: z.string(),
        userId: z.string(),
    }),
    z.object({
        type: z.literal('system_alert'),
        severity: z.enum(['low', 'medium', 'high']),
        message: z.string(),
    }),
    z.object({
        type: z.literal('data_update'),
        table: z.string(),
        recordId: z.string(),
        changes: z.record(z.any()),
    }),
]);

// State with event queue
const EventDrivenState = z.object({
    events: z.array(EventSchema),
    processed_events: z.array(z.string()), // event IDs
    current_event: EventSchema.optional(),
    responses: z.array(z.any()),
    context: z.record(z.any()),
});

const eventDrivenWorkflow = new StateGraph(EventDrivenState)
    .addNode('event_router', async (state) => {
        if (state.events.length === 0) {
            return state; // No events to process
        }

        const event = state.events[0];
        const remainingEvents = state.events.slice(1);

        return {
            ...state,
            events: remainingEvents,
            current_event: event,
        };
    })

    .addNode('process_user_message', async (state) => {
        const event = state.current_event;
        if (event?.type !== 'user_message') return state;

        // Process user message
        const response = await handleUserMessage(event, state.context);

        return {
            ...state,
            responses: [...state.responses, response],
            processed_events: [...state.processed_events, generateEventId(event)],
        };
    })

    .addNode('process_system_alert', async (state) => {
        const event = state.current_event;
        if (event?.type !== 'system_alert') return state;

        // Process system alert
        const response = await handleSystemAlert(event, state.context);

        return {
            ...state,
            responses: [...state.responses, response],
            processed_events: [...state.processed_events, generateEventId(event)],
        };
    })

    .addNode('process_data_update', async (state) => {
        const event = state.current_event;
        if (event?.type !== 'data_update') return state;

        // Process data update
        const updatedContext = await handleDataUpdate(event, state.context);

        return {
            ...state,
            context: { ...state.context, ...updatedContext },
            processed_events: [...state.processed_events, generateEventId(event)],
        };
    })

    .addConditionalEdges('event_router', (state) => {
        const event = state.current_event;
        if (!event) return END;

        switch (event.type) {
            case 'user_message':
                return 'process_user_message';
            case 'system_alert':
                return 'process_system_alert';
            case 'data_update':
                return 'process_data_update';
            default:
                return 'event_router'; // Skip unknown events
        }
    })

    .addEdge('process_user_message', 'event_router')
    .addEdge('process_system_alert', 'event_router')
    .addEdge('process_data_update', 'event_router')
    .addEdge(START, 'event_router');

async function handleUserMessage(event: any, context: any) {
    // Implement user message handling
    return {
        type: 'response',
        content: `Processed message: ${event.content}`,
        userId: event.userId,
    };
}

async function handleSystemAlert(event: any, context: any) {
    // Implement alert handling based on severity
    const priority = event.severity === 'high' ? 'urgent' : 'normal';

    return {
        type: 'alert_acknowledgment',
        message: `Alert processed with ${priority} priority: ${event.message}`,
        severity: event.severity,
    };
}

async function handleDataUpdate(event: any, context: any) {
    // Update context based on data changes
    return {
        [event.table]: {
            ...context[event.table],
            [event.recordId]: {
                ...context[event.table]?.[event.recordId],
                ...event.changes,
                last_updated: new Date().toISOString(),
            },
        },
    };
}

function generateEventId(event: any): string {
    return `${event.type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export const eventDrivenGraph = eventDrivenWorkflow.compile();
```

## Middleware Patterns

### Request Interception and Modification

```typescript
// middleware/request-interceptor.ts
import { NextRequest, NextResponse } from 'next/server';

export class RequestInterceptor {
    private rules: InterceptRule[] = [];

    addRule(rule: InterceptRule) {
        this.rules.push(rule);
    }

    async intercept(request: NextRequest): Promise<NextResponse | null> {
        for (const rule of this.rules) {
            if (await rule.condition(request)) {
                return rule.handler(request);
            }
        }
        return null;
    }
}

interface InterceptRule {
    condition: (request: NextRequest) => Promise<boolean> | boolean;
    handler: (request: NextRequest) => Promise<NextResponse> | NextResponse;
}

// Usage
const interceptor = new RequestInterceptor();

// Rate limiting rule
interceptor.addRule({
    condition: (req) => req.nextUrl.pathname.startsWith('/api/langgraph'),
    handler: async (req) => {
        const clientId = getClientId(req);
        const isAllowed = await checkRateLimit(clientId);

        if (!isAllowed) {
            return NextResponse.json(
                { error: 'Rate limit exceeded' },
                {
                    status: 429,
                    headers: {
                        'Retry-After': '60',
                        'X-RateLimit-Reset': getResetTime(clientId),
                    },
                },
            );
        }

        return NextResponse.next();
    },
});

// Content filtering rule
interceptor.addRule({
    condition: (req) => req.method === 'POST' && req.nextUrl.pathname.includes('/runs'),
    handler: async (req) => {
        const body = await req.json();

        if (containsInappropriateContent(body.input)) {
            return NextResponse.json({ error: 'Content policy violation' }, { status: 400 });
        }

        // Reconstruct request with filtered body
        const newRequest = new NextRequest(req.url, {
            method: req.method,
            headers: req.headers,
            body: JSON.stringify(body),
        });

        return NextResponse.next({
            request: newRequest,
        });
    },
});
```

### Response Transformation Middleware

```typescript
// middleware/response-transformer.ts
import { NextResponse } from 'next/server';

export class ResponseTransformer {
    private transformers: ResponseTransformerRule[] = [];

    addTransformer(transformer: ResponseTransformerRule) {
        this.transformers.push(transformer);
    }

    async transform(response: NextResponse, request: NextRequest): Promise<NextResponse> {
        let transformedResponse = response;

        for (const transformer of this.transformers) {
            if (await transformer.condition(request, transformedResponse)) {
                transformedResponse = await transformer.handler(transformedResponse, request);
            }
        }

        return transformedResponse;
    }
}

interface ResponseTransformerRule {
    condition: (request: NextRequest, response: NextResponse) => Promise<boolean> | boolean;
    handler: (response: NextResponse, request: NextRequest) => Promise<NextResponse> | NextResponse;
}

// Usage
const transformer = new ResponseTransformer();

// Add response metadata
transformer.addTransformer({
    condition: (req) => req.nextUrl.pathname.includes('/threads'),
    handler: async (res, req) => {
        const data = await res.json();

        const enhancedData = Array.isArray(data) ? data.map((item) => addMetadata(item, req)) : addMetadata(data, req);

        return NextResponse.json(enhancedData, {
            headers: res.headers,
        });
    },
});

// Compress responses for slow connections
transformer.addTransformer({
    condition: (req, res) => {
        const acceptEncoding = req.headers.get('accept-encoding') || '';
        return acceptEncoding.includes('gzip') && res.headers.get('content-length') > 1024;
    },
    handler: async (res) => {
        // Apply gzip compression
        const compressedBody = await gzip(await res.arrayBuffer());

        return new NextResponse(compressedBody, {
            status: res.status,
            statusText: res.statusText,
            headers: {
                ...res.headers,
                'content-encoding': 'gzip',
                'content-length': compressedBody.length.toString(),
            },
        });
    },
});

function addMetadata(item: any, request: NextRequest) {
    return {
        ...item,
        _metadata: {
            requested_at: new Date().toISOString(),
            requested_by: getClientId(request),
            api_version: 'v1',
        },
    };
}
```
