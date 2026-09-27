import { z } from 'zod';

// ============================================================================
// Message Roles
// ============================================================================

export const AiMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type AiMessageRole = z.infer<typeof AiMessageRoleSchema>;

// ============================================================================
// Tool Call (provider-agnostic)
// ============================================================================

/**
 * Structured tool call as produced by the model.
 * Provider-agnostic representation.
 */
export const AiToolCallSchema = z.object({
  /** Unique ID for this tool call (from the model) */
  id: z.string(),
  /** Tool/function name (operationId or step-scoped tool name) */
  name: z.string(),
  /** Parsed arguments object (not a raw JSON string) */
  argumentsJson: z.unknown(),
});
export type AiToolCall = z.infer<typeof AiToolCallSchema>;

// ============================================================================
// Tool Result
// ============================================================================

/**
 * Structured tool result returned after a tool step executes.
 */
export const AiToolResultSchema = z.object({
  /** References the tool call this is a result for */
  toolCallId: z.string(),
  /** Tool/function name */
  name: z.string(),
  /** Execution status */
  status: z.enum(['SUCCEEDED', 'FAILED', 'PAUSED']),
  /** Ref to the full output payload (if succeeded) */
  outputRef: z.string().optional(),
  /** Ref to the error payload (if failed) */
  errorRef: z.string().optional(),
  /** Bounded summary for model context (avoid sending full payloads) */
  summary: z
    .object({
      /** Plain text summary */
      text: z.string().max(16000).optional(),
      /** Structured summary (bounded JSON) */
      json: z.unknown().optional(),
    })
    .optional(),
  /** Rich metadata for structured tool result display and agent guidance */
  resultMeta: z
    .object({
      /** The operation that was executed (e.g., 'ai.image.generate') */
      operationId: z.string().optional(),
      /** State variable key(s) where output was stored */
      outputStoredIn: z.array(z.string()).optional(),
      /** Whether output was displayed to the user */
      displayedToUser: z.boolean().optional(),
      /** Execution duration in milliseconds */
      durationMs: z.number().optional(),
    })
    .optional(),
});
export type AiToolResult = z.infer<typeof AiToolResultSchema>;

// ============================================================================
// Conversation Message
// ============================================================================

/**
 * A single message in an AI conversation.
 * Supports all roles: system, user, assistant (with optional tool calls), tool (with result).
 */
export const AiConversationMessageSchema = z.object({
  /** Unique message ID */
  messageId: z.string(),
  /** Timestamp (epoch ms) */
  tsMs: z.number(),
  /** Message role */
  role: AiMessageRoleSchema,
  /** Text content (system/user/assistant) */
  content: z.string().optional(),
  /** Tool calls made by the assistant */
  toolCalls: z.array(AiToolCallSchema).optional(),
  /** Tool result (tool role only) */
  toolResult: AiToolResultSchema.optional(),
  /** Bounded metadata */
  metadata: z.record(z.unknown()).optional(),
});
export type AiConversationMessage = z.infer<typeof AiConversationMessageSchema>;

// ============================================================================
// History Scope
// ============================================================================

export const HistoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('step'),
  }),
  z.object({
    kind: z.literal('custom'),
    key: z.string().min(1).max(128),
  }),
]);
export type HistoryScope = z.infer<typeof HistoryScopeSchema>;

// ============================================================================
// History Policy
// ============================================================================

/**
 * Configuration for how conversation history is managed.
 */
export const HistoryPolicySchema = z.object({
  /** Whether history tracking is enabled */
  enabled: z.boolean().default(false),
  /** Scope for the conversation key */
  scope: HistoryScopeSchema.default({ kind: 'step' }),
  /** Max tokens to budget for the history window */
  maxTokens: z.number().int().positive().optional(),
  /** Max messages to keep (simpler cap than token counting) */
  maxMessages: z.number().int().positive().optional(),
  /** Truncation strategy */
  truncationPolicy: z
    .enum(['sliding_window', 'oldest_first', 'summarize_then_window'])
    .default('sliding_window'),
  /** Whether to include tool call/result messages in history */
  includeToolMessages: z.boolean().default(false),
});
export type HistoryPolicy = z.infer<typeof HistoryPolicySchema>;

// ============================================================================
// Context Policy
// ============================================================================

/**
 * Configuration for which runtime variables are included in AI context.
 */
export const ContextPolicySchema = z.object({
  /** Whether context injection is enabled */
  enabled: z.boolean().default(false),
  /** Allowlist of variable keys to include */
  contextVariables: z.array(z.string()).default([]),
  /** How to include variable values */
  mode: z.enum(['inline_small', 'ref_only']).default('ref_only'),
  /** Max bytes for inlined values */
  maxInlineBytes: z.number().int().positive().default(4096),
});
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;

// ============================================================================
// System Prompt Policy
// ============================================================================

/**
 * Configuration for system prompts.
 */
export const SystemPolicySchema = z.object({
  /** Platform-level system prompt ID (non-overridable, always prepended) */
  platformSystemPromptId: z.string().optional(),
  /** Step-level system prompt (appended after platform prompt) */
  stepSystemPrompt: z.string().max(100_000).optional(),
});
export type SystemPolicy = z.infer<typeof SystemPolicySchema>;

// ============================================================================
// Conversation Record (stored in payload store)
// ============================================================================

/**
 * A full conversation record for an AI step.
 * Stored as a payload and referenced via runtime variable.
 */
export const AiConversationRecordSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  tenantId: z.string(),
  runId: z.string(),
  stepId: z.string(),
  /** Conversation key (e.g., "${runId}:${stepId}" or custom) */
  conversationKey: z.string(),
  /** Ordered message list */
  messages: z.array(AiConversationMessageSchema),
  /** Record creation time */
  createdAtMs: z.number(),
  /** Last update time */
  updatedAtMs: z.number(),
  /** Snapshot of the policy used */
  policy: HistoryPolicySchema.optional(),
  /** Optional conversation summary (for future summarize_then_window) */
  summary: z
    .object({
      text: z.string(),
      updatedAtMs: z.number(),
    })
    .optional(),
});
export type AiConversationRecord = z.infer<typeof AiConversationRecordSchema>;

// ============================================================================
// Context Snapshot (stored in payload store)
// ============================================================================

/**
 * Snapshot of runtime variables included in AI context.
 */
export const AiContextSnapshotSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  tenantId: z.string(),
  runId: z.string(),
  stepId: z.string(),
  /** Variable snapshots */
  variables: z.array(
    z.object({
      key: z.string(),
      value: z.unknown(),
    }),
  ),
  createdAtMs: z.number(),
});
export type AiContextSnapshot = z.infer<typeof AiContextSnapshotSchema>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a conversation key from scope policy.
 */
export function buildConversationKey(runId: string, stepId: string, scope?: HistoryScope): string {
  if (scope?.kind === 'custom') {
    return `${runId}:${scope.key}`;
  }
  return `${runId}:${stepId}`;
}

/**
 * Create a new empty conversation record.
 */
export function createConversationRecord(params: {
  tenantId: string;
  runId: string;
  stepId: string;
  conversationKey: string;
  policy?: HistoryPolicy;
}): AiConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    tenantId: params.tenantId,
    runId: params.runId,
    stepId: params.stepId,
    conversationKey: params.conversationKey,
    messages: [],
    createdAtMs: now,
    updatedAtMs: now,
    policy: params.policy,
  };
}

/**
 * Create a conversation message.
 */
export function createMessage(
  role: AiMessageRole,
  content?: string,
  opts?: {
    toolCalls?: AiToolCall[];
    toolResult?: AiToolResult;
    metadata?: Record<string, unknown>;
  },
): AiConversationMessage {
  return {
    messageId: crypto.randomUUID(),
    tsMs: Date.now(),
    role,
    content,
    toolCalls: opts?.toolCalls,
    toolResult: opts?.toolResult,
    metadata: opts?.metadata,
  };
}

/**
 * Apply truncation policy to a conversation record.
 * Returns a new record with truncated messages.
 */
export function truncateHistory(
  record: AiConversationRecord,
  policy: HistoryPolicy,
): AiConversationRecord {
  let messages = [...record.messages];

  // Always keep the first system message
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  // Filter out tool messages if not included
  const filtered = policy.includeToolMessages
    ? nonSystemMessages
    : nonSystemMessages.filter((m) => m.role !== 'tool' && !m.toolCalls?.length);

  // Apply message count limit
  const maxMessages = policy.maxMessages ?? 100;
  if (filtered.length > maxMessages) {
    switch (policy.truncationPolicy) {
      case 'sliding_window':
        // Keep most recent messages
        messages = [...systemMessages, ...filtered.slice(filtered.length - maxMessages)];
        break;
      case 'oldest_first':
        // Remove oldest non-system messages
        messages = [...systemMessages, ...filtered.slice(filtered.length - maxMessages)];
        break;
      case 'summarize_then_window':
        // v1: fall back to sliding window
        messages = [...systemMessages, ...filtered.slice(filtered.length - maxMessages)];
        break;
    }
  } else {
    messages = [...systemMessages, ...filtered];
  }

  return {
    ...record,
    messages,
    updatedAtMs: Date.now(),
  };
}
