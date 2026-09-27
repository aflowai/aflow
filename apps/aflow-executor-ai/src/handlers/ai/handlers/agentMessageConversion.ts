import type { AiMessageV1, AiContentPart, AiToolCallV1 } from '@aflow/schemas';
import type { ChatMessage } from '@aflow/ai-client';

/**
 * Convert an AiMessageV1 to a ChatMessage, preserving tool metadata.
 */
export function aiMessageToChatMessage(msg: AiMessageV1): ChatMessage {
  const textContent = msg.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
  const jsonContent = msg.parts
    .filter((p): p is { kind: 'json'; json: unknown } => p.kind === 'json')
    .map((p) => JSON.stringify(p.json, null, 2))
    .join('\n');
  const content = [textContent, jsonContent].filter(Boolean).join('\n');

  if (msg.role === 'tool') {
    return {
      role: 'tool' as const,
      toolCallId: msg.toolCallId ?? '',
      name: msg.name,
      content: content || '[Tool result]',
    };
  }
  if (msg.role === 'system') {
    return { role: 'system' as const, content };
  }
  if (msg.role === 'assistant') {
    const toolCalls = msg.toolCalls?.map((tc) => ({
      id: tc.toolCallId,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments:
          typeof tc.argumentsJson === 'string'
            ? tc.argumentsJson
            : JSON.stringify(tc.argumentsJson ?? {}),
      },
      ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
    }));
    return {
      role: 'assistant' as const,
      content: content || null,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(msg.providerReasoning ? { providerReasoning: msg.providerReasoning } : {}),
    };
  }
  return { role: 'user' as const, content };
}

/**
 * Merge consecutive same-role messages, but never merge system or tool messages.
 * System messages need separate handling by providers; tool messages must stay
 * paired with their toolCallId.
 */
export function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (
      prev?.role === msg.role &&
      prev !== undefined &&
      msg.role !== 'system' &&
      msg.role !== 'tool' &&
      typeof prev.content === 'string' &&
      typeof msg.content === 'string'
    ) {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

/**
 * Convert a ChatMessage back to AiMessageV1 (lossless for inspection).
 * This is the reverse of aiMessageToChatMessage, preserving all fields
 * so the step output captures exactly what the model received.
 */
export function chatMessageToAiMessage(msg: ChatMessage): AiMessageV1 {
  if (msg.role === 'system') {
    return { role: 'system', parts: [{ kind: 'text', text: msg.content }] };
  }
  if (msg.role === 'user') {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return { role: 'user', parts: [{ kind: 'text', text }] };
  }
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      toolCallId: msg.toolCallId,
      name: msg.name,
      parts: [{ kind: 'text', text: msg.content }],
    };
  }
  // assistant
  const parts: AiContentPart[] = [];
  if (msg.content) {
    parts.push({ kind: 'text', text: msg.content });
  }
  const toolCalls: AiToolCallV1[] | undefined = msg.toolCalls?.map((tc) => ({
    toolCallId: tc.id,
    name: tc.function.name,
    argumentsJson: safeJsonParse(tc.function.arguments),
    ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
  }));
  return {
    role: 'assistant',
    parts,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(msg.providerReasoning ? { providerReasoning: msg.providerReasoning } : {}),
  };
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str) as unknown;
  } catch {
    return str;
  }
}
