import z from 'zod';

export const AssistantConfigurable = z
    .object({
        thread_id: z.string().optional(),
        thread_ts: z.string().optional(),
    })
    .catchall(z.unknown());

export const AssistantConfig = z
    .object({
        tags: z.array(z.string()).optional(),
        recursion_limit: z.number().int().optional(),
        configurable: AssistantConfigurable.optional(),
    })
    .catchall(z.unknown())
    .describe('The configuration of an assistant.');

export const Assistant = z.object({
    assistant_id: z.string(),
    graph_id: z.string(),
    config: AssistantConfig,
    created_at: z.string(),
    updated_at: z.string(),
    metadata: z.object({}).catchall(z.any()),
});

export const MetadataSchema = z
    .object({
        source: z.union([z.literal('input'), z.literal('loop'), z.literal('update'), z.string()]).optional(),
        step: z.number().optional(),
        writes: z.any().nullable().optional(),
        parents: z.any().optional(),
    })
    .catchall(z.unknown());

export const SendSchema = z.object({
    node: z.string(),
    input: z.unknown().optional(),
});

export const CommandSchema = z.object({
    update: z
        .union([z.any(), z.array(z.tuple([z.string(), z.any()]))])
        .nullable()
        .optional(),
    resume: z.unknown().optional(),
    goto: z.union([SendSchema, z.array(SendSchema), z.string(), z.array(z.string())]).optional(),
});

// 公共的查询参数验证 schema
export const PaginationQuerySchema = z.object({
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
});

export const ThreadIdParamSchema = z.object({
    thread_id: z.string(),
});

export const RunIdParamSchema = z.object({
    thread_id: z.string(),
    run_id: z.string(),
});

// Assistants 相关的 schema
export const AssistantsSearchSchema = z.object({
    graph_id: z.string().optional(),
    metadata: MetadataSchema.optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
    sort_by: z.enum(['assistant_id', 'graph_id', 'name', 'created_at', 'updated_at']).optional(),
    sort_order: z.enum(['asc', 'desc']).optional(),
});

export const AssistantCountSchema = z.object({
    graph_id: z.string().optional(),
    metadata: MetadataSchema.optional(),
});

export const AssistantGraphQuerySchema = z.object({
    xray: z.union([z.string(), z.boolean(), z.number()]).optional(),
});

export const AssistantPatchSchema = z
    .object({
        name: z.string().optional(),
        description: z.string().optional(),
        metadata: MetadataSchema.optional(),
        config: AssistantConfig.optional(),
    })
    .optional();

export const AssistantCreateSchema = z.object({
    assistant_id: z.string().optional(),
    graph_id: z.string().describe('The ID of graph to create an assistant from.'),
    name: z.string().optional(),
    description: z.string().optional(),
    metadata: MetadataSchema.optional(),
    config: AssistantConfig.optional(),
    if_exists: z.enum(['raise', 'do_nothing']).optional(),
});

// Runs 相关的 schema
export const RunStreamPayloadSchema = z
    .object({
        assistant_id: z.union([z.string(), z.string()]),
        checkpoint_id: z.string().optional(),
        input: z.any().optional(),
        command: CommandSchema.optional(),
        metadata: MetadataSchema.optional(),
        config: AssistantConfig.optional(),
        webhook: z.string().optional(),
        interrupt_before: z.union([z.literal('*'), z.array(z.string())]).optional(),
        interrupt_after: z.union([z.literal('*'), z.array(z.string())]).optional(),
        on_disconnect: z.enum(['cancel', 'continue']).optional().default('continue'),
        multitask_strategy: z.enum(['reject', 'rollback', 'interrupt', 'enqueue']).optional(),
        stream_mode: z
            .array(z.enum(['values', 'messages', 'messages-tuple', 'updates', 'events', 'debug', 'custom']))
            .optional(),
        stream_subgraphs: z.boolean().optional(),
        stream_resumable: z.boolean().optional(),
        after_seconds: z.number().optional(),
        if_not_exists: z.enum(['create', 'reject']).optional(),
        on_completion: z.enum(['complete', 'continue']).optional(),
        feedback_keys: z.array(z.string()).optional(),
        langsmith_tracer: z.unknown().optional(),
    })
    .describe('Payload for creating a stateful run.');

export const RunListQuerySchema = z.object({
    limit: z.coerce.number().int().optional().default(10),
    offset: z.coerce.number().int().optional().default(0),
    status: z.enum(['pending', 'running', 'error', 'success', 'timeout', 'interrupted']).optional(),
});

export const RunCancelQuerySchema = z.object({
    wait: z.coerce.boolean().optional().default(false),
    action: z.enum(['interrupt', 'rollback']).optional().default('interrupt'),
});

export const RunJoinStreamQuerySchema = z.object({
    cancel_on_disconnect: z.coerce.boolean().optional().default(false),
    last_event_id: z.string().optional(),
    stream_mode: z.enum(['values', 'messages', 'messages-tuple', 'updates', 'events', 'debug', 'custom']).optional(),
});

// Threads 相关的 schema
export const ThreadCreatePayloadSchema = z
    .object({
        thread_id: z.string().describe('The ID of thread. If not provided, an ID is generated.').optional(),
        metadata: MetadataSchema.optional(),
        if_exists: z.union([z.literal('raise'), z.literal('do_nothing')]).optional(),
    })
    .describe('Payload for creating a thread.');

export const ThreadSearchPayloadSchema = z
    .object({
        ids: z.array(z.string()).describe('List of thread IDs to include. Others are excluded.').optional(),
        metadata: MetadataSchema.describe('Metadata to search for.').optional(),
        status: z.enum(['idle', 'busy', 'interrupted', 'error']).describe('Filter by thread status.').optional(),
        values: z.any().describe('Filter by thread values.').optional(),
        limit: z.number().int().gte(1).lte(1000).describe('Maximum number to return.').optional(),
        offset: z.number().int().gte(0).describe('Offset to start from.').optional(),
        sort_by: z.enum(['thread_id', 'status', 'created_at', 'updated_at']).describe('Sort by field.').optional(),
        sort_order: z.enum(['asc', 'desc']).describe('Sort order.').optional(),
        select: z
            .array(
                z.enum([
                    'thread_id',
                    'created_at',
                    'updated_at',
                    'metadata',
                    'config',
                    'context',
                    'status',
                    'values',
                    'interrupts',
                    'title',
                ]),
            )
            .describe('Specify which fields to return. If not provided, all fields are returned.')
            .optional(),
        without_details: z.boolean().describe('Whether to return values.').optional(),
    })
    .describe('Payload for listing threads.');

export const ThreadStateUpdate = z
    .object({
        values: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]).nullish(),
        // as_node: z.string().optional(),
        // checkpoint_id: z.string().optional(),
        // checkpoint: CheckpointSchema.nullish(),
    })
    .describe('Payload for adding state to a thread.');

export const ThreadPatchSchema = z
    .object({
        metadata: MetadataSchema.optional(),
        status: z.enum(['idle', 'busy', 'interrupted', 'error']).optional(),
        values: z.any().optional(),
    })
    .describe('Payload for patching a thread.');

export const RunCreateSchema = z
    .object({
        assistant_id: z.string(),
        input: z.any().optional(),
        command: CommandSchema.optional(),
        metadata: MetadataSchema.optional(),
        config: AssistantConfig.optional(),
        webhook: z.string().optional(),
        interrupt_before: z.union([z.literal('*'), z.array(z.string())]).optional(),
        interrupt_after: z.union([z.literal('*'), z.array(z.string())]).optional(),
        on_disconnect: z.enum(['cancel', 'continue']).optional().default('continue'),
        multitask_strategy: z.enum(['reject', 'rollback', 'interrupt', 'enqueue']).optional(),
        stream_mode: z
            .array(z.enum(['values', 'messages', 'messages-tuple', 'updates', 'events', 'debug', 'custom']))
            .optional(),
        stream_subgraphs: z.boolean().optional(),
        stream_resumable: z.boolean().optional(),
        after_seconds: z.number().optional(),
        if_not_exists: z.enum(['create', 'reject']).optional(),
        on_completion: z.enum(['complete', 'continue']).optional(),
        feedback_keys: z.array(z.string()).optional(),
        langsmith_tracer: z.unknown().optional(),
    })
    .describe('Payload for creating a run (background/wait).');

export const RunWaitQuerySchema = z.object({
    cancel_on_disconnect: z.coerce.boolean().optional().default(false),
});

export const RunJoinQuerySchema = z.object({
    cancel_on_disconnect: z.coerce.boolean().optional().default(false),
});

// Stateless Runs 相关的 schema
export const RunCreateStatelessSchema = z
    .object({
        assistant_id: z.string().describe('The assistant ID or graph name to run.'),
        input: z.any().optional().describe('The input to the graph.'),
        command: CommandSchema.optional(),
        metadata: MetadataSchema.optional().describe('Metadata to assign to the run.'),
        config: AssistantConfig.optional(),
        context: z.object({}).catchall(z.any()).optional().describe('Static context added to the assistant.'),
        webhook: z.string().optional(),
        interrupt_before: z.union([z.literal('*'), z.array(z.string())]).optional(),
        interrupt_after: z.union([z.literal('*'), z.array(z.string())]).optional(),
        stream_mode: z
            .union([
                z.enum(['values', 'messages', 'messages-tuple', 'tasks', 'checkpoints', 'updates', 'events', 'debug', 'custom']),
                z.array(z.enum(['values', 'messages', 'messages-tuple', 'tasks', 'checkpoints', 'updates', 'events', 'debug', 'custom'])),
            ])
            .optional()
            .default(['values']),
        feedback_keys: z.array(z.string()).optional(),
        stream_subgraphs: z.boolean().optional().default(false),
        stream_resumable: z.boolean().optional().default(false),
    })
    .describe('Payload for creating a stateless run.');

export const RunBatchCreateSchema = z
    .array(RunCreateStatelessSchema)
    .min(1)
    .describe('Payload for creating a batch of stateless runs.');

export const RunsCancelQuerySchema = z.object({
    action: z.enum(['interrupt', 'rollback']).optional().default('interrupt').describe('Action to take when cancelling the run.'),
    wait: z.coerce.boolean().optional().default(false),
});

export const RunsCancelSchema = z.union([
    z.object({
        status: z.enum(['pending', 'running', 'all']).describe('Filter runs by status to cancel.'),
    }),
    z.object({
        thread_id: z.string().describe('The ID of the thread containing runs to cancel.'),
    }),
    z.object({
        run_ids: z.array(z.string()).min(1).describe('List of run IDs to cancel.'),
    }),
]);
