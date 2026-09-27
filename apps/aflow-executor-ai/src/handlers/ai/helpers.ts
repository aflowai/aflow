/**
 * Helper functions for AI handlers.
 */
import type { ChatMessage } from '@aflow/ai-client';
import type {
  AiConversationRecord,
  AiConversationMessage,
  AiToolCall,
  StepUsageBreakdown,
} from '@aflow/schemas';
import type { AiGenerateInput } from './schema.js';

export function buildMessages(params: AiGenerateInput): ChatMessage[] {
  if (params.messages !== undefined && params.messages.length > 0) {
    return params.messages as ChatMessage[];
  }

  const messages: ChatMessage[] = [];
  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }
  if (params.prompt) {
    messages.push({ role: 'user', content: params.prompt });
  }
  return messages;
}

export function historyMessageToChatMessage(msg: AiConversationMessage): ChatMessage | null {
  if (msg.role === 'tool' && msg.toolResult) {
    const content =
      msg.toolResult.summary?.text ??
      (msg.toolResult.summary?.json !== undefined
        ? JSON.stringify(msg.toolResult.summary.json)
        : msg.toolResult.status);
    return {
      role: 'tool',
      content,
      toolCallId: msg.toolResult.toolCallId,
      name: msg.toolResult.name,
    };
  }
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: msg.content ?? '',
      toolCalls: msg.toolCalls.map((tc: AiToolCall) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments:
            typeof tc.argumentsJson === 'string'
              ? tc.argumentsJson
              : JSON.stringify(tc.argumentsJson),
        },
      })),
    };
  }
  if (msg.role === 'system') {
    return { role: 'system', content: msg.content ?? '' };
  }
  if (msg.role === 'user') {
    return { role: 'user', content: msg.content ?? '' };
  }
  if (msg.role === 'assistant') {
    return { role: 'assistant', content: msg.content ?? '' };
  }
  return null;
}

export function buildMessagesFromHistory(
  history: AiConversationRecord,
  newUserPrompt?: string,
  systemPrompt?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const hasSystem = history.messages.some((m: AiConversationMessage) => m.role === 'system');
  if (!hasSystem && systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of history.messages) {
    const chatMsg = historyMessageToChatMessage(msg);
    if (chatMsg) {
      messages.push(chatMsg);
    }
  }

  if (newUserPrompt) {
    messages.push({ role: 'user', content: newUserPrompt });
  }

  return messages;
}

/**
 * Build a typed StepUsageBreakdown from an AI provider response.
 * Returns undefined if no usage data (totalTokens is 0 or missing).
 */
export function buildUsageBreakdown(response: {
  provider?: string;
  model: string;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    uncachedPromptTokens?: number | undefined;
  };
  cost?:
    { promptCost: number; completionCost: number; totalCost: number; currency: string } | undefined;
}): StepUsageBreakdown | undefined {
  if (!response.usage.totalTokens) return undefined;
  return {
    provider: response.provider ?? 'unknown',
    model: response.model,
    promptTokens: response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completionTokens ?? 0,
    totalTokens: response.usage.totalTokens ?? 0,
    ...(response.usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: response.usage.cacheReadTokens }
      : {}),
    ...(response.usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: response.usage.cacheWriteTokens }
      : {}),
    ...(response.usage.uncachedPromptTokens !== undefined
      ? { uncachedPromptTokens: response.usage.uncachedPromptTokens }
      : {}),
    promptCostUsd: response.cost?.promptCost ?? 0,
    completionCostUsd: response.cost?.completionCost ?? 0,
    totalCostUsd: response.cost?.totalCost ?? 0,
  };
}

export function buildCostJson(
  response: Parameters<typeof buildUsageBreakdown>[0],
): Record<string, unknown> | undefined {
  return buildUsageBreakdown(response);
}
