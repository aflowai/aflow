import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

const sdk = vi.hoisted(() => ({
  captured: [] as Record<string, unknown>[],
  reply: {
    id: 'msg_1',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '…' },
      { type: 'tool_use', name: 'response', input: { answer: '42' } },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (params: Record<string, unknown>) => {
        sdk.captured.push(params);
        return Promise.resolve(sdk.reply);
      },
    };
  },
}));
import type { ChatMessage } from '../types.js';
import {
  createAnthropicAdapter,
  toAnthropicMessages,
  buildAnthropicReasoning,
  AnthropicReasoningCapture,
  applyCacheStrategy,
} from './anthropic.js';
import {
  checkAnthropicMessagesWireValidity,
  TRUNCATED_HISTORY_USER_BRIDGE_TEXT,
} from './wireIntegrity.js';

function toolResultBlocks(content: unknown): Array<{ type: string; tool_use_id: string }> {
  return (content as Array<{ type: string; tool_use_id: string }>) ?? [];
}

describe('toAnthropicMessages — tool_result coalescing', () => {
  it('coalesces two contiguous tool messages into one user message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } },
          { id: 'a_1', type: 'function', function: { name: 'q', arguments: '{}' } },
        ],
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
      { role: 'tool', toolCallId: 'a_1', name: 'q', content: 'r1' },
    ];
    const { messages: out } = toAnthropicMessages(messages);

    // user, assistant(tool_use ×2), user(tool_result ×2)
    expect(out).toHaveLength(3);
    const lastMsg = out[2]!;
    expect(lastMsg.role).toBe('user');
    const blocks = toolResultBlocks(lastMsg.content);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['a_0', 'a_1']);
    expect(blocks.every((b) => b.type === 'tool_result')).toBe(true);
  });

  it('keeps a single tool result as one user message', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    // Assistant-first history gets a neutral user bridge prepended (wire rule).
    expect(out).toHaveLength(3);
    expect(out[0]!.role).toBe('user');
    expect(toolResultBlocks(out[2]!.content)).toHaveLength(1);
  });

  it('does not append tool_result blocks onto a preceding text user message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'plain text' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    // text user message stays string-typed; tool result is a separate user message
    expect(out[0]!.content).toBe('plain text');
    expect(Array.isArray(out[2]!.content)).toBe(true);
    expect(toolResultBlocks(out[2]!.content)).toHaveLength(1);
  });

  it('does not merge results across an intervening assistant message', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'b_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'b_0', name: 'q', content: 'r1' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    // user(bridge), assistant, user[a_0], assistant, user[b_0]
    expect(out).toHaveLength(5);
    expect(toolResultBlocks(out[2]!.content).map((b) => b.tool_use_id)).toEqual(['a_0']);
    expect(toolResultBlocks(out[4]!.content).map((b) => b.tool_use_id)).toEqual(['b_0']);
  });
});

describe('toAnthropicMessages — assistant-first history bridging (Plan 189 follow-up)', () => {
  it('prepends a user bridge when the windowed history opens on an assistant turn', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    expect(out[0]).toEqual({ role: 'user', content: TRUNCATED_HISTORY_USER_BRIDGE_TEXT });
    expect(checkAnthropicMessagesWireValidity(out).issues).toEqual([]);
  });

  it('does not prepend a bridge when the history already opens with a user turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
    ];
    const { messages: out } = toAnthropicMessages(messages);
    expect(out[0]!.content).toBe('go');
    expect(checkAnthropicMessagesWireValidity(out).issues).toEqual([]);
  });
});

describe('buildAnthropicReasoning — effort → thinking/output_config mapping (Plan 259)', () => {
  it('returns nothing when no reasoning config is supplied (provider default)', () => {
    expect(buildAnthropicReasoning(undefined)).toEqual({ enabled: false });
  });

  it('disables thinking for effort "off" (adaptive is the on-by-omission default on some models)', () => {
    expect(buildAnthropicReasoning({ effort: 'off' })).toEqual({
      thinking: { type: 'disabled' },
      enabled: false,
    });
  });

  it.each(['low', 'medium', 'high'] as const)(
    'maps effort "%s" to adaptive thinking + output_config.effort',
    (effort) => {
      expect(buildAnthropicReasoning({ effort })).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        outputConfig: { effort },
        enabled: true,
      });
    },
  );

  it('marks enabled=true only when thinking is on (so callers drop temperature)', () => {
    expect(buildAnthropicReasoning({ effort: 'medium' }).enabled).toBe(true);
    expect(buildAnthropicReasoning({ effort: 'off' }).enabled).toBe(false);
    expect(buildAnthropicReasoning(undefined).enabled).toBe(false);
  });
});

describe('toAnthropicMessages — reasoning-continuity replay (Plan 259)', () => {
  const withReasoning: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'acting',
      toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
      providerReasoning: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        blocks: [{ type: 'thinking', thinking: 'let me think', signature: 'sig123' }],
      },
    },
    { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
  ];

  it('prepends thinking blocks before text and tool_use when replay is enabled', () => {
    const { messages: out } = toAnthropicMessages(withReasoning, { replayReasoning: true });
    const assistant = out.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as Array<{ type: string; signature?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(blocks[0]).toMatchObject({ type: 'thinking', signature: 'sig123' });
  });

  it('omits thinking blocks when replay is disabled (thinking not enabled this request)', () => {
    const { messages: out } = toAnthropicMessages(withReasoning, { replayReasoning: false });
    const assistant = out.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('defaults to not replaying reasoning', () => {
    const { messages: out } = toAnthropicMessages(withReasoning);
    const assistant = out.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
  });

  it('never replays another provider’s reasoning even when replay is enabled', () => {
    const foreign: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'acting',
        toolCalls: [{ id: 'a_0', type: 'function', function: { name: 'q', arguments: '{}' } }],
        providerReasoning: {
          provider: 'google',
          model: 'gemini-3.1-pro-preview',
          blocks: [{ type: 'thinking', thinking: 'x', signature: 's' }],
        },
      },
      { role: 'tool', toolCallId: 'a_0', name: 'q', content: 'r0' },
    ];
    const { messages: out } = toAnthropicMessages(foreign, { replayReasoning: true });
    const assistant = out.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
  });
});

describe('AnthropicReasoningCapture — streaming block accumulation (Plan 259)', () => {
  it('accumulates a thinking block from multiple thinking_delta + signature_delta chunks', () => {
    const cap = new AnthropicReasoningCapture();
    cap.startBlock({ type: 'thinking' });
    cap.delta({ type: 'thinking_delta', thinking: 'let me ' });
    cap.delta({ type: 'thinking_delta', thinking: 'think' });
    cap.delta({ type: 'signature_delta', signature: 'sig-part-1;' });
    cap.delta({ type: 'signature_delta', signature: 'sig-part-2' });
    cap.stopBlock();
    expect(cap.finish()).toEqual([
      { type: 'thinking', thinking: 'let me think', signature: 'sig-part-1;sig-part-2' },
    ]);
  });

  it('captures a redacted_thinking block whole at start', () => {
    const cap = new AnthropicReasoningCapture();
    cap.startBlock({ type: 'redacted_thinking', data: 'ENCRYPTED' });
    expect(cap.finish()).toEqual([{ type: 'redacted_thinking', data: 'ENCRYPTED' }]);
  });

  it('preserves order and resets between multiple thinking blocks', () => {
    const cap = new AnthropicReasoningCapture();
    cap.startBlock({ type: 'thinking' });
    cap.delta({ type: 'thinking_delta', thinking: 'A' });
    cap.delta({ type: 'signature_delta', signature: 'sA' });
    cap.stopBlock();
    cap.startBlock({ type: 'redacted_thinking', data: 'R' });
    cap.startBlock({ type: 'thinking' });
    cap.delta({ type: 'thinking_delta', thinking: 'B' });
    cap.delta({ type: 'signature_delta', signature: 'sB' });
    cap.stopBlock();
    expect(cap.finish()).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sA' },
      { type: 'redacted_thinking', data: 'R' },
      { type: 'thinking', thinking: 'B', signature: 'sB' },
    ]);
  });

  it('ignores deltas that arrive with no open thinking block', () => {
    const cap = new AnthropicReasoningCapture();
    cap.delta({ type: 'thinking_delta', thinking: 'stray' });
    cap.delta({ type: 'signature_delta', signature: 'stray' });
    cap.stopBlock();
    expect(cap.finish()).toEqual([]);
  });
});

describe('applyCacheStrategy — breakpoint budget (Plan 292 §4.2a)', () => {
  const blocks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: 'text' as const, text: `block-${String(i)}` }));
  const marked = (arr: Array<Record<string, unknown>>) =>
    arr.filter((b) => b['cache_control'] !== undefined).length;

  it('marks the prompt and both long-lived context tiers, leaving the volatile tail uncached', () => {
    const systemBlocks = blocks(4);
    applyCacheStrategy(
      {
        toolBreakpoint: { type: 'ephemeral' },
        systemBreakpoint: { type: 'ephemeral' },
        systemBreakpointCount: 3,
      },
      [{ name: 't', input_schema: { type: 'object' } } as never],
      systemBlocks,
    );
    expect(marked(systemBlocks as unknown as Array<Record<string, unknown>>)).toBe(3);
    expect(
      (systemBlocks[3] as unknown as Record<string, unknown>)['cache_control'],
    ).toBeUndefined();
  });

  it('never exceeds the provider breakpoint budget, even when more are requested', () => {
    const systemBlocks = blocks(8);
    const tools = [{ name: 't', input_schema: { type: 'object' } } as never];
    applyCacheStrategy(
      {
        toolBreakpoint: { type: 'ephemeral' },
        systemBreakpoint: { type: 'ephemeral' },
        systemBreakpointCount: 8,
      },
      tools,
      systemBlocks,
    );
    // One is spent on tools; a request over the cap is rejected outright by the
    // provider, so the shortest-lived tiers are dropped instead.
    const total =
      marked(systemBlocks as unknown as Array<Record<string, unknown>>) +
      marked(tools as unknown as Array<Record<string, unknown>>);
    expect(total).toBeLessThanOrEqual(4);
    expect(marked(systemBlocks as unknown as Array<Record<string, unknown>>)).toBe(3);
  });

  it('spends the whole budget on system blocks when no tools are sent', () => {
    const systemBlocks = blocks(6);
    applyCacheStrategy(
      {
        toolBreakpoint: { type: 'ephemeral' },
        systemBreakpoint: { type: 'ephemeral' },
        systemBreakpointCount: 6,
      },
      undefined,
      systemBlocks,
    );
    expect(marked(systemBlocks as unknown as Array<Record<string, unknown>>)).toBe(4);
  });
});

describe('generateJson — structured output must not ride a forced tool call', () => {
  it('leaves tool_choice on auto so thinking survives', async () => {
    sdk.captured.length = 0;
    const adapter = createAnthropicAdapter({ apiKey: 'k' });

    const result = await adapter.generateJson({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'q' }],
      schema: z.object({ answer: z.string() }),
      rawJsonSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      reasoning: { effort: 'high' },
      maxTokens: 1024,
    } as never);

    const params = sdk.captured[0] ?? {};
    // Both forcing modes suppress extended thinking outright — measured at zero
    // thinking tokens even with `thinking: adaptive` set explicitly — so an
    // agent turn taken through a forced tool answers with no reasoning at all.
    expect(params['tool_choice']).toEqual({ type: 'auto' });
    expect(params['thinking']).toMatchObject({ type: 'adaptive' });
    expect(params['output_config']).toMatchObject({ effort: 'high' });
    // The schema rides the tool, not output_config.format: native structured
    // outputs reject the free-form `args` object the agent decision needs.
    expect(params['output_config']).not.toHaveProperty('format');
    expect((result as { data: { answer: string } }).data.answer).toBe('42');
    // The decision carries the reasoning summary, as the other JSON adapters do.
    expect((result as { thinking?: string }).thinking).toBe('…');
  });
});
