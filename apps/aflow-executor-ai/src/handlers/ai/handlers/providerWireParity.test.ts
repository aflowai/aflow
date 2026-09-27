import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@aflow/ai-client';
import {
  toGeminiContents,
  toAnthropicMessages,
  checkGeminiContentsWireValidity,
  checkAnthropicMessagesWireValidity,
} from '@aflow/ai-client';
import { mergeConsecutiveMessages } from './agentMessageConversion.js';
import {
  convertOrphanToolMessages,
  enforceToolResultAdjacency,
  checkToolResultAdjacency,
} from './nativeFcMessagePatch.js';

function assistant(text: string | null, ...ids: Array<[id: string, name: string]>): ChatMessage {
  return {
    role: 'assistant',
    content: text,
    ...(ids.length > 0
      ? {
          toolCalls: ids.map(([id, name]) => ({
            id,
            type: 'function' as const,
            function: { name, arguments: '{"mode":"list"}' },
          })),
        }
      : {}),
  };
}

function tool(toolCallId: string, name: string): ChatMessage {
  return {
    role: 'tool',
    toolCallId,
    name,
    content: `{"kind":"tool_result","toolCallId":"${toolCallId}","status":"SUCCEEDED"}`,
  };
}

/** Production sanitization pipeline, in the load-bearing order (agentTurnRequest.ts). */
function sanitize(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutiveMessages(messages);
  return enforceToolResultAdjacency(convertOrphanToolMessages(merged));
}

const CLEAR_TO_REF_NOTE =
  '[Context note — earlier tool exchange (1 tool call) cleared to save space. Results remain readable — see below.]\n' +
  '• compute.sandbox.exec({"code":"train_model()"}) [zz_0] → succeeded (2.3s) — stdout: model trained\n' +
  "  read: memory.store.get { path: '/run/outputs/zz_0/data', view: 'outline' } (~48.0KB, object: {stdout, artifacts[3]})\n" +
  '  ⚠ not idempotent — do NOT re-run this call; re-read the stored result instead.';

/** Sanitize, map through both providers, and assert both wire rule sets hold. */
function expectWireParity(history: ChatMessage[]): {
  sanitized: ChatMessage[];
  geminiContents: ReturnType<typeof toGeminiContents>['contents'];
} {
  const sanitized = sanitize(history);
  expect(checkToolResultAdjacency(sanitized).violations).toEqual([]);

  const { contents } = toGeminiContents(sanitized, { nativeFunctionCalling: true });
  expect(checkGeminiContentsWireValidity(contents).issues).toEqual([]);

  const { messages: anthropicMessages } = toAnthropicMessages(sanitized);
  expect(checkAnthropicMessagesWireValidity(anthropicMessages).issues).toEqual([]);

  return { sanitized, geminiContents: contents };
}

describe('provider wire parity (sanitizer + mapping)', () => {
  it('parallel tool calls: one assistant, two results', () => {
    expectWireParity([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'go' },
      assistant(null, ['a_0', 'search'], ['a_1', 'analyze']),
      tool('a_0', 'search'),
      tool('a_1', 'analyze'),
    ]);
  });

  it('text + tool call mixed in the same assistant turn', () => {
    expectWireParity([
      { role: 'user', content: 'go' },
      assistant('Let me look that up.', ['a_0', 'search']),
      tool('a_0', 'search'),
      assistant('Found it.'),
      { role: 'user', content: 'thanks, now the other one' },
      assistant('On it.', ['b_0', 'analyze']),
      tool('b_0', 'analyze'),
    ]);
  });

  it('legacy persisted system-role summaries between exchanges stay wire-valid (pre-196 atoms)', () => {
    expectWireParity([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'go' },
      assistant(null, ['a_0', 'search']),
      tool('a_0', 'search'),
      { role: 'system', content: '[Cleared exchange — 1 tool call] • search(...)' },
      { role: 'system', content: '[Cleared exchange — 1 tool call] • analyze(...)' },
      assistant(null, ['b_0', 'analyze']),
      tool('b_0', 'analyze'),
    ]);
  });

  it('tool result missing: placeholder synthesis keeps both wires valid', () => {
    const { sanitized } = expectWireParity([
      { role: 'user', content: 'go' },
      assistant(null, ['a_0', 'search']),
      // a_0's result lost
      { role: 'user', content: 'continue' },
      assistant(null, ['b_0', 'analyze']),
      tool('b_0', 'analyze'),
    ]);
    expect(
      sanitized.some((m) => m.role === 'tool' && m.content.includes('Tool result not available')),
    ).toBe(true);
  });

  it('tool result late: relocated across an injected message, both wires valid', () => {
    expectWireParity([
      { role: 'user', content: 'go' },
      assistant(null, ['a_0', 'search']),
      { role: 'user', content: '[injected note]' },
      tool('a_0', 'search'),
    ]);
  });

  it('consecutive assistant turns (text-only then tool call)', () => {
    expectWireParity([
      { role: 'user', content: 'go' },
      assistant('Thinking about it.'),
      assistant(null, ['a_0', 'search']),
      tool('a_0', 'search'),
    ]);
  });

  it('orphan tool result at the window start converts to a user note', () => {
    const { geminiContents } = expectWireParity([
      { role: 'system', content: 'instructions' },
      // The producer assistant was evicted by the window — orphan results lead.
      tool('zz_0', 'search'),
      tool('zz_1', 'analyze'),
      assistant(null, ['a_0', 'search']),
      tool('a_0', 'search'),
    ]);
    expect(geminiContents[0]!.role).toBe('user');
  });

  it('clear-to-ref notes (Plan 196 §4.5): in-position user-role notes between exchanges', () => {
    expectWireParity([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'go' },
      assistant(null, ['a_0', 'search']),
      tool('a_0', 'search'),
      { role: 'user', content: CLEAR_TO_REF_NOTE },
      { role: 'user', content: CLEAR_TO_REF_NOTE },
      assistant(null, ['b_0', 'analyze']),
      tool('b_0', 'analyze'),
    ]);
  });

  it('windowed history opening on a user-role note: both wires valid, no bridge needed', () => {
    const { geminiContents } = expectWireParity([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: CLEAR_TO_REF_NOTE },
      assistant(null, ['a_0', 'search']),
      tool('a_0', 'search'),
    ]);
    expect(geminiContents[0]!.role).toBe('user');
    expect(
      geminiContents[0]!.parts?.some(
        (p) => 'text' in p && typeof p.text === 'string' && p.text.includes('[Context note'),
      ),
    ).toBe(true);
  });

  it('systemInstruction is byte-stable across two consecutive post-clearing turns (§4.5)', () => {
    const systemMessages: ChatMessage[] = [
      { role: 'system', content: 'agent instructions' },
      { role: 'system', content: '## Context\n### SpaceContext\nstable block' },
    ];
    const turnN: ChatMessage[] = [
      ...systemMessages,
      { role: 'user', content: 'go' },
      assistant(null, ['a_0', 'search']),
      tool('a_0', 'search'),
      { role: 'user', content: CLEAR_TO_REF_NOTE },
      assistant('First pass complete.'),
    ];
    // The next turn appends history only — clearing emits another user-role
    // note; nothing new lands in the system channel.
    const turnN1: ChatMessage[] = [
      ...turnN,
      { role: 'user', content: 'continue' },
      assistant(null, ['b_0', 'analyze']),
      tool('b_0', 'analyze'),
      { role: 'user', content: CLEAR_TO_REF_NOTE },
      assistant('Wrapped up.'),
    ];

    const first = toGeminiContents(sanitize(turnN), { nativeFunctionCalling: true });
    const second = toGeminiContents(sanitize(turnN1), { nativeFunctionCalling: true });
    expect(first.systemInstruction).toBe(
      'agent instructions\n\n## Context\n### SpaceContext\nstable block',
    );
    expect(second.systemInstruction).toBe(first.systemInstruction);
  });

  it('REGRESSION run e4c5061e: window-evicted user turn — history opens on a functionCall turn', () => {
    // Replayed shape of the persisted state feeding the failing turn (session
    // 7ca3fb1e, feeder step 7c34df93, state turn 42): first atom is an
    // assistant_turn with a functionCall, exchanges interleaved with
    // cleared_summary system atoms, trailing assistant call answered by the
    // newly arrived tool result.
    const history: ChatMessage[] = [
      { role: 'system', content: 'agent instructions' },
      assistant('{"action":"invoke_step","toolId":"memory.store.query"}', [
        'e3a31370bf114f7e8a742b1256fe19b2_0',
        'memory.store.query',
      ]),
      tool('e3a31370bf114f7e8a742b1256fe19b2_0', 'memory.store.query'),
      assistant(null, ['b89ea4c448c84200924963b9e5857301_0', 'memory.store.query']),
      tool('b89ea4c448c84200924963b9e5857301_0', 'memory.store.query'),
      { role: 'system', content: '[Cleared exchange — 1 tool call] • compute.sandbox.exec(...)' },
      { role: 'system', content: '[Cleared exchange — 1 tool call] • memory.store.query(...)' },
      { role: 'system', content: '[Cleared exchange — 1 tool call] • memory.store.get(...)' },
      assistant(null, ['8a39e96f11d54874be7b503d6428b0d4_0', 'memory.store.get']),
      tool('8a39e96f11d54874be7b503d6428b0d4_0', 'memory.store.get'),
      assistant(null, ['d5160c84448b47d380a86ac0c8719e25_0', 'compute.sandbox.exec']),
      tool('d5160c84448b47d380a86ac0c8719e25_0', 'compute.sandbox.exec'),
    ];

    const { geminiContents } = expectWireParity(history);

    // The fix: a neutral user bridge opens the conversation; the first
    // functionCall turn now immediately follows a user turn.
    expect(geminiContents[0]!.role).toBe('user');
    expect(geminiContents[1]!.role).toBe('model');
    expect(geminiContents[1]!.parts?.some((p) => 'functionCall' in p && p.functionCall)).toBe(true);
  });
});
