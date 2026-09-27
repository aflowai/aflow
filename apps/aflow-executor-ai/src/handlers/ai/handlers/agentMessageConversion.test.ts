import { describe, it, expect } from 'vitest';
import type { AiMessageV1, AiToolResultEnvelopeV1 } from '@aflow/schemas';
import { toolResultMessage } from '@aflow/schemas';
import type { ChatMessage } from '@aflow/ai-client';
import { aiMessageToChatMessage, mergeConsecutiveMessages } from './agentMessageConversion.js';

function assertToolMessage(
  msg: ChatMessage,
): asserts msg is Extract<ChatMessage, { role: 'tool' }> {
  expect(msg.role).toBe('tool');
}
function assertAssistantMessage(
  msg: ChatMessage,
): asserts msg is Extract<ChatMessage, { role: 'assistant' }> {
  expect(msg.role).toBe('assistant');
}

describe('aiMessageToChatMessage', () => {
  it('converts system messages', () => {
    const msg: AiMessageV1 = {
      role: 'system',
      parts: [{ kind: 'text', text: 'You are an agent.' }],
    };
    const result = aiMessageToChatMessage(msg);
    expect(result).toEqual({ role: 'system', content: 'You are an agent.' });
  });

  it('converts user messages', () => {
    const msg: AiMessageV1 = {
      role: 'user',
      parts: [{ kind: 'text', text: 'Search for X' }],
    };
    const result = aiMessageToChatMessage(msg);
    expect(result).toEqual({ role: 'user', content: 'Search for X' });
  });

  it('converts tool messages preserving toolCallId and name', () => {
    const msg: AiMessageV1 = {
      role: 'tool',
      toolCallId: 'call_abc',
      name: 'search',
      parts: [{ kind: 'json', json: { results: ['found'] } }],
    };
    const result = aiMessageToChatMessage(msg);
    expect(result.role).toBe('tool');
    expect(result).toHaveProperty('toolCallId', 'call_abc');
    expect(result).toHaveProperty('name', 'search');
    expect(result).toHaveProperty('content');
    assertToolMessage(result);
    expect(result.content).toContain('results');
  });

  it('uses empty string for toolCallId when missing on tool message', () => {
    const msg: AiMessageV1 = {
      role: 'tool',
      parts: [{ kind: 'text', text: 'result' }],
    };
    const result = aiMessageToChatMessage(msg);
    assertToolMessage(result);
    expect(result.toolCallId).toBe('');
  });

  // Guard: the rendering serializes the envelope whole, so structured
  // error.details (availableActions, currentVersion, …) reach the model text.
  it('renders a failed tool envelope with error.details into the message content', () => {
    const envelope: AiToolResultEnvelopeV1 = {
      kind: 'tool_result',
      toolCallId: 'act001_0',
      toolName: 'chess.move',
      operationId: 'ui.applet.act',
      status: 'FAILED',
      completedAtMs: 1,
      error: {
        error: 'validation',
        message: "Action 'move' rejected: input does not match the action schema",
        retry: true,
        details: {
          reason: 'input_invalid',
          availableActions: ['move', 'resign', 'raw_patch'],
          validation: [{ path: ['from'], message: 'Required' }],
        },
      },
    };
    const result = aiMessageToChatMessage(toolResultMessage(envelope));
    assertToolMessage(result);
    expect(result.content).toContain('input_invalid');
    expect(result.content).toContain('availableActions');
    expect(result.content).toContain('resign');
    expect(result.content).toContain('Required');
  });

  it('uses [Tool result] fallback when tool message has no content', () => {
    const msg: AiMessageV1 = {
      role: 'tool',
      toolCallId: 'call_1',
      name: 'tool1',
      parts: [],
    };
    const result = aiMessageToChatMessage(msg);
    assertToolMessage(result);
    expect(result.content).toBe('[Tool result]');
  });

  it('converts assistant messages preserving toolCalls', () => {
    const msg: AiMessageV1 = {
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Let me search' }],
      toolCalls: [
        {
          toolCallId: 'call_1',
          name: 'search',
          argumentsJson: { query: 'test' },
        },
      ],
    };
    const result = aiMessageToChatMessage(msg);
    assertAssistantMessage(result);
    expect(result.content).toBe('Let me search');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: {
        name: 'search',
        arguments: '{"query":"test"}',
      },
    });
  });

  it('handles assistant toolCalls with string argumentsJson', () => {
    const msg: AiMessageV1 = {
      role: 'assistant',
      parts: [],
      toolCalls: [
        {
          toolCallId: 'call_1',
          name: 'search',
          argumentsJson: '{"query":"test"}',
        },
      ],
    };
    const result = aiMessageToChatMessage(msg);
    assertAssistantMessage(result);
    expect(result.toolCalls?.[0]?.function.arguments).toBe('{"query":"test"}');
  });

  it('omits toolCalls when assistant has none', () => {
    const msg: AiMessageV1 = {
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Hello' }],
    };
    const result = aiMessageToChatMessage(msg);
    assertAssistantMessage(result);
    expect(result.toolCalls).toBeUndefined();
  });

  it('returns null content for assistant with no text parts', () => {
    const msg: AiMessageV1 = {
      role: 'assistant',
      parts: [],
    };
    const result = aiMessageToChatMessage(msg);
    assertAssistantMessage(result);
    expect(result.content).toBeNull();
  });

  it('combines text and json parts into content', () => {
    const msg: AiMessageV1 = {
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Here is my decision' },
        { kind: 'json', json: { action: 'invoke_step' } },
      ],
      toolCalls: [
        {
          toolCallId: 'call_1',
          name: 'search',
          argumentsJson: {},
        },
      ],
    };
    const result = aiMessageToChatMessage(msg);
    assertAssistantMessage(result);
    const content = result.content;
    expect(content).toContain('Here is my decision');
    expect(content).toContain('invoke_step');
  });
});

describe('mergeConsecutiveMessages', () => {
  it('merges consecutive user messages', () => {
    const messages = [
      { role: 'user' as const, content: 'Part 1' },
      { role: 'user' as const, content: 'Part 2' },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('Part 1\n\nPart 2');
  });

  it('does NOT merge consecutive system messages', () => {
    const messages = [
      { role: 'system' as const, content: 'System 1' },
      { role: 'system' as const, content: 'System 2' },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
  });

  it('does NOT merge consecutive tool messages', () => {
    const messages = [
      { role: 'tool' as const, toolCallId: 'call_1', name: 'search', content: 'result 1' },
      { role: 'tool' as const, toolCallId: 'call_2', name: 'analyze', content: 'result 2' },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
    assertToolMessage(result[0]!);
    assertToolMessage(result[1]!);
    expect(result[0]!.toolCallId).toBe('call_1');
    expect(result[1]!.toolCallId).toBe('call_2');
  });

  it('does NOT merge tool messages with following user messages', () => {
    const messages = [
      { role: 'tool' as const, toolCallId: 'call_1', content: 'result' },
      { role: 'user' as const, content: 'Now do something else' },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe('tool');
    expect(result[1]!.role).toBe('user');
  });

  it('merges consecutive assistant messages (text only)', () => {
    const messages = [
      { role: 'assistant' as const, content: 'Part 1' },
      { role: 'assistant' as const, content: 'Part 2' },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('Part 1\n\nPart 2');
  });

  it('does not merge when content is not a string (multimodal user)', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Hello' }],
      },
      { role: 'user' as const, content: 'World' },
    ];
    const result = mergeConsecutiveMessages(messages);
    // Cannot merge array content with string content
    expect(result).toHaveLength(2);
  });

  it('handles empty array', () => {
    const result = mergeConsecutiveMessages([]);
    expect(result).toHaveLength(0);
  });

  it('preserves message order with mixed roles', () => {
    const messages = [
      { role: 'system' as const, content: 'Instructions' },
      { role: 'system' as const, content: 'Context' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi', toolCalls: undefined },
      { role: 'tool' as const, toolCallId: 'c1', content: 'result' },
      { role: 'tool' as const, toolCallId: 'c2', content: 'result2' },
      { role: 'user' as const, content: 'Thanks' },
    ];
    const result = mergeConsecutiveMessages(messages);
    // system, system (not merged), user, assistant, tool, tool (not merged), user
    expect(result).toHaveLength(7);
    expect(result.map((m) => m.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
  });
});
