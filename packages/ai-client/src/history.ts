/**
 * Step-scoped conversation history management.
 * Provides deterministic serialization and bounded windowing for chat history.
 */
import { z } from 'zod';
import type { PayloadStore } from '@aflow/payload-store';
import type { PayloadRef, TenantId, SessionId, StepExecutionId } from '@aflow/schemas';
import type { ChatMessage, ToolCall, TokenUsage } from './types.js';

// ============================================================================
// History Schemas
// ============================================================================

/**
 * Serialized message format for history storage.
 * Deterministic ordering and stable keys.
 */
export const HistoryMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('system'),
    content: z.string(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    role: z.literal('user'),
    content: z.string(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          arguments: z.string(),
        }),
      )
      .optional(),
    timestamp: z.string().datetime(),
    usage: z
      .object({
        promptTokens: z.number(),
        completionTokens: z.number(),
        totalTokens: z.number(),
      })
      .optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
    timestamp: z.string().datetime(),
  }),
]);
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/**
 * Full history record for a step execution.
 */
export const HistoryRecordSchema = z.object({
  /** Step execution ID */
  stepExecutionId: z.string(),
  /** Run ID */
  runId: z.string(),
  /** Tenant ID */
  tenantId: z.string(),
  /** Attempt number */
  attempt: z.number().int().positive(),
  /** Messages in order */
  messages: z.array(HistoryMessageSchema),
  /** Token budget used */
  tokenBudgetUsed: z.number().int().nonnegative(),
  /** Token budget limit */
  tokenBudgetLimit: z.number().int().positive().optional(),
  /** Whether history was truncated */
  truncated: z.boolean(),
  /** Creation timestamp */
  createdAt: z.string().datetime(),
  /** Last updated timestamp */
  updatedAt: z.string().datetime(),
});
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

// ============================================================================
// History Configuration
// ============================================================================

/**
 * Configuration for history management.
 */
export interface HistoryConfig {
  /** Maximum tokens to include in history */
  tokenBudget: number;
  /** Strategy for truncation when over budget */
  truncationStrategy: 'oldest_first' | 'summarize' | 'sliding_window';
  /** Number of recent messages to always keep */
  preserveRecentCount: number;
  /** Whether to include system message in budget */
  includeSystemInBudget: boolean;
}

/**
 * Default history configuration.
 */
export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  tokenBudget: 100000,
  truncationStrategy: 'oldest_first',
  preserveRecentCount: 10,
  includeSystemInBudget: false,
};

// ============================================================================
// History Manager
// ============================================================================

/**
 * Manager for step-scoped conversation history.
 */
export interface HistoryManager {
  /**
   * Add a message to history.
   */
  addMessage(message: ChatMessage, metadata?: { usage?: TokenUsage }): void;

  /**
   * Add a user message.
   */
  addUserMessage(content: string): void;

  /**
   * Add an assistant message.
   */
  addAssistantMessage(
    content: string | null,
    options?: { toolCalls?: ToolCall[]; usage?: TokenUsage },
  ): void;

  /**
   * Add a tool result.
   */
  addToolResult(toolCallId: string, name: string, content: string): void;

  /**
   * Get messages formatted for API call (applying truncation if needed).
   */
  getMessagesForApi(): ChatMessage[];

  /**
   * Get full history record.
   */
  getHistoryRecord(): HistoryRecord;

  /**
   * Persist history to GCS.
   */
  persist(): Promise<PayloadRef>;

  /**
   * Get estimated token count for current history.
   */
  getEstimatedTokens(): number;

  /**
   * Clear all history.
   */
  clear(): void;
}

/**
 * Create a history manager for a step execution.
 */
export function createHistoryManager(params: {
  payloadStore: PayloadStore;
  tenantId: TenantId;
  runId: SessionId;
  stepExecutionId: StepExecutionId;
  attempt: number;
  config?: Partial<HistoryConfig>;
  initialMessages?: ChatMessage[];
}): HistoryManager {
  const config = { ...DEFAULT_HISTORY_CONFIG, ...params.config };
  const messages: HistoryMessage[] = [];
  const createdAt = new Date().toISOString();

  // Add initial messages if provided
  if (params.initialMessages) {
    for (const msg of params.initialMessages) {
      addChatMessageToHistory(msg, messages);
    }
  }

  /**
   * Estimate tokens for a message (rough approximation: 1 token ≈ 4 chars).
   */
  function estimateTokens(msg: HistoryMessage): number {
    let chars = 0;
    if (msg.role === 'system' || msg.role === 'user') {
      chars = msg.content.length;
    } else if (msg.role === 'assistant') {
      chars = (msg.content ?? '').length;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          chars += tc.name.length + tc.arguments.length;
        }
      }
    } else {
      // Tool message
      chars = msg.content.length + msg.name.length;
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Convert HistoryMessage to ChatMessage.
   */
  function toChatMessage(msg: HistoryMessage): ChatMessage {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };
      case 'user':
        return { role: 'user', content: msg.content };
      case 'assistant': {
        const result: ChatMessage = {
          role: 'assistant',
          content: msg.content,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          (result as { toolCalls?: ToolCall[] }).toolCalls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        return result;
      }
      case 'tool':
        return {
          role: 'tool',
          toolCallId: msg.toolCallId,
          name: msg.name,
          content: msg.content,
        };
    }
  }

  /**
   * Add a ChatMessage to history.
   */
  function addChatMessageToHistory(
    msg: ChatMessage,
    target: HistoryMessage[],
    usage?: TokenUsage,
  ): void {
    const timestamp = new Date().toISOString();
    switch (msg.role) {
      case 'system':
        target.push({ role: 'system', content: msg.content, timestamp });
        break;
      case 'user':
        target.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          timestamp,
        });
        break;
      case 'assistant': {
        const historyMsg: HistoryMessage = {
          role: 'assistant',
          content: msg.content,
          timestamp,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          (
            historyMsg as { toolCalls?: Array<{ id: string; name: string; arguments: string }> }
          ).toolCalls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
        }
        if (usage) {
          (historyMsg as { usage?: TokenUsage }).usage = usage;
        }
        target.push(historyMsg);
        break;
      }
      case 'tool':
        target.push({
          role: 'tool',
          toolCallId: msg.toolCallId,
          name: msg.name ?? 'unknown',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          timestamp,
        });
        break;
    }
  }

  /**
   * Apply truncation based on config.
   */
  function applyTruncation(msgs: HistoryMessage[]): HistoryMessage[] {
    let totalTokens = 0;
    const result: HistoryMessage[] = [];

    // First, collect system message (if not included in budget)
    const systemMessages = msgs.filter((m) => m.role === 'system');
    const nonSystemMessages = msgs.filter((m) => m.role !== 'system');

    // Always include system messages
    for (const sys of systemMessages) {
      result.push(sys);
      if (config.includeSystemInBudget) {
        totalTokens += estimateTokens(sys);
      }
    }

    // Apply truncation strategy
    if (config.truncationStrategy === 'oldest_first') {
      // Keep recent messages up to budget
      const reversed = [...nonSystemMessages].reverse();
      const kept: HistoryMessage[] = [];

      for (const msg of reversed) {
        const msgTokens = estimateTokens(msg);
        if (totalTokens + msgTokens <= config.tokenBudget) {
          kept.unshift(msg);
          totalTokens += msgTokens;
        } else if (kept.length < config.preserveRecentCount) {
          // Always keep minimum recent messages
          kept.unshift(msg);
          totalTokens += msgTokens;
        } else {
          break;
        }
      }

      result.push(...kept);
    } else if (config.truncationStrategy === 'sliding_window') {
      // Simple sliding window: take last N that fit
      const reversed = [...nonSystemMessages].reverse();
      const kept: HistoryMessage[] = [];

      for (const msg of reversed) {
        const msgTokens = estimateTokens(msg);
        if (totalTokens + msgTokens <= config.tokenBudget) {
          kept.unshift(msg);
          totalTokens += msgTokens;
        }
      }

      result.push(...kept);
    } else {
      // For now, fall back to oldest_first for summarize
      result.push(...nonSystemMessages);
    }

    return result;
  }

  return {
    addMessage(message: ChatMessage, metadata?: { usage?: TokenUsage }) {
      addChatMessageToHistory(message, messages, metadata?.usage);
    },

    addUserMessage(content: string) {
      messages.push({
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      });
    },

    addAssistantMessage(
      content: string | null,
      options?: { toolCalls?: ToolCall[]; usage?: TokenUsage },
    ) {
      const msg: HistoryMessage = {
        role: 'assistant',
        content,
        timestamp: new Date().toISOString(),
      };
      if (options?.toolCalls && options.toolCalls.length > 0) {
        (msg as { toolCalls?: Array<{ id: string; name: string; arguments: string }> }).toolCalls =
          options.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
      }
      if (options?.usage) {
        (msg as { usage?: TokenUsage }).usage = options.usage;
      }
      messages.push(msg);
    },

    addToolResult(toolCallId: string, name: string, content: string) {
      messages.push({
        role: 'tool',
        toolCallId,
        name,
        content,
        timestamp: new Date().toISOString(),
      });
    },

    getMessagesForApi(): ChatMessage[] {
      const truncated = applyTruncation(messages);
      return truncated.map(toChatMessage);
    },

    getHistoryRecord(): HistoryRecord {
      const truncated = applyTruncation(messages);
      const tokenBudgetUsed = truncated.reduce((sum, msg) => sum + estimateTokens(msg), 0);

      return {
        stepExecutionId: params.stepExecutionId,
        runId: params.runId,
        tenantId: params.tenantId,
        attempt: params.attempt,
        messages: truncated,
        tokenBudgetUsed,
        tokenBudgetLimit: config.tokenBudget,
        truncated: truncated.length < messages.length,
        createdAt,
        updatedAt: new Date().toISOString(),
      };
    },

    async persist(): Promise<PayloadRef> {
      const record = this.getHistoryRecord();
      return await params.payloadStore.store({
        tenantId: params.tenantId,
        runId: params.runId,
        stepExecutionId: params.stepExecutionId,
        attempt: params.attempt,
        kind: 'history',
        data: record,
        persist: true,
      });
    },

    getEstimatedTokens(): number {
      return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
    },

    clear() {
      messages.length = 0;
    },
  };
}

// ============================================================================
// History Loader
// ============================================================================

/**
 * Load history from a payload reference.
 */
export async function loadHistory(
  payloadStore: PayloadStore,
  historyRef: PayloadRef,
): Promise<HistoryRecord> {
  const data = await payloadStore.retrieve(historyRef);
  return HistoryRecordSchema.parse(data);
}

/**
 * Convert a HistoryRecord back to ChatMessages.
 */
export function historyToChatMessages(record: HistoryRecord): ChatMessage[] {
  return record.messages.map((msg): ChatMessage => {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };
      case 'user':
        return { role: 'user', content: msg.content };
      case 'assistant': {
        const result: ChatMessage = {
          role: 'assistant',
          content: msg.content,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          (result as { toolCalls?: ToolCall[] }).toolCalls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        return result;
      }
      case 'tool':
        return {
          role: 'tool',
          toolCallId: msg.toolCallId,
          name: msg.name,
          content: msg.content,
        };
    }
  });
}
