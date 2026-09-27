import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@aflow/ai-client';
import {
  checkToolResultAdjacency,
  enforceToolResultAdjacency,
  convertOrphanToolMessages,
  emptySanitizationStats,
} from './nativeFcMessagePatch.js';

function assistant(...ids: Array<[id: string, name: string]>): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    toolCalls: ids.map(([id, name]) => ({
      id,
      type: 'function' as const,
      function: { name, arguments: '{}' },
    })),
  };
}

function tool(toolCallId: string, name: string, content: string): ChatMessage {
  return { role: 'tool', toolCallId, name, content };
}

// ============================================================================
// checkToolResultAdjacency (§7.4)
// ============================================================================

describe('checkToolResultAdjacency', () => {
  it('is ok when each assistant tool_use is immediately followed by its results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      assistant(['a_0', 'q'], ['a_1', 'q']),
      tool('a_0', 'q', 'r0'),
      tool('a_1', 'q', 'r1'),
    ];
    expect(checkToolResultAdjacency(messages).ok).toBe(true);
  });

  it('flags a result that is not immediately after the assistant', () => {
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q'], ['a_1', 'q']),
      tool('a_1', 'q', 'r1'),
      { role: 'user', content: 'stray' },
      tool('a_0', 'q', 'r0'), // too late
    ];
    const { ok, violations } = checkToolResultAdjacency(messages);
    expect(ok).toBe(false);
    expect(violations).toEqual([
      { assistantIndex: 0, missingOrLateIds: ['a_0'], unexpectedIds: [] },
    ]);
  });

  it('flags a missing result', () => {
    const messages: ChatMessage[] = [assistant(['a_0', 'q']), { role: 'user', content: 'x' }];
    expect(checkToolResultAdjacency(messages).ok).toBe(false);
  });

  it('flags an unowned tool result in the contiguous run (extra id)', () => {
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q']),
      tool('a_0', 'q', 'r0'),
      tool('unowned', 'q', 'stray'), // not called by the assistant
    ];
    const { ok, violations } = checkToolResultAdjacency(messages);
    expect(ok).toBe(false);
    expect(violations).toEqual([
      { assistantIndex: 0, missingOrLateIds: [], unexpectedIds: ['unowned'] },
    ]);
  });

  it('flags a duplicate tool result for an owned id', () => {
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q']),
      tool('a_0', 'q', 'r0'),
      tool('a_0', 'q', 'r0-dup'),
    ];
    const { ok, violations } = checkToolResultAdjacency(messages);
    expect(ok).toBe(false);
    expect(violations).toEqual([
      { assistantIndex: 0, missingOrLateIds: [], unexpectedIds: ['a_0'] },
    ]);
  });

  it('ignores text-only assistant messages', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'hi' },
    ];
    expect(checkToolResultAdjacency(messages).ok).toBe(true);
  });
});

// ============================================================================
// enforceToolResultAdjacency (§7.1)
// ============================================================================

describe('enforceToolResultAdjacency', () => {
  it('leaves a well-formed single-call turn byte-identical (same reference)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      assistant(['a_0', 'search']),
      tool('a_0', 'search', 'results'),
    ];
    const out = enforceToolResultAdjacency(messages);
    expect(out).toBe(messages); // unchanged → original reference
    expect(checkToolResultAdjacency(out).ok).toBe(true);
  });

  it('regroups a parallel call whose results are split by a user message', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q'], ['a_1', 'q']),
      tool('a_1', 'q', 'result-one'),
      { role: 'user', content: 'stray note' },
      tool('a_0', 'q', 'result-zero'),
    ];
    const out = enforceToolResultAdjacency(messages, stats);
    expect(checkToolResultAdjacency(out).ok).toBe(true);

    // Each id keeps its own content — no misattribution from reordering.
    const a0 = out.find((m) => m.role === 'tool' && m.toolCallId === 'a_0');
    const a1 = out.find((m) => m.role === 'tool' && m.toolCallId === 'a_1');
    expect((a0 as { content: string }).content).toBe('result-zero');
    expect((a1 as { content: string }).content).toBe('result-one');
    // The stray user note survives and is not rewritten.
    expect(out.some((m) => m.role === 'user' && m.content === 'stray note')).toBe(true);
    expect(stats.resultsRelocatedAcrossNonTool).toBeGreaterThan(0);
    expect(stats.syntheticPlaceholders).toBe(0);
  });

  it('regroups a parallel call whose results are split by a system message', () => {
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q'], ['a_1', 'q']),
      tool('a_0', 'q', 'result-zero'),
      { role: 'system', content: '[Turn 2 — cleared]' },
      tool('a_1', 'q', 'result-one'),
    ];
    const out = enforceToolResultAdjacency(messages);
    expect(checkToolResultAdjacency(out).ok).toBe(true);
    // Assistant followed immediately by both results, then the system message.
    expect(out[0]!.role).toBe('assistant');
    expect(out[1]!.role).toBe('tool');
    expect(out[2]!.role).toBe('tool');
    expect(out[3]!.role).toBe('system');
  });

  it('synthesizes a labelled placeholder for a missing result and counts it', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q'], ['a_1', 'q']),
      tool('a_0', 'q', 'only-zero'),
      { role: 'user', content: 'next' },
    ];
    const out = enforceToolResultAdjacency(messages, stats);
    expect(checkToolResultAdjacency(out).ok).toBe(true);
    const a1 = out.find((m) => m.role === 'tool' && m.toolCallId === 'a_1');
    expect((a1 as { content: string }).content).toContain('Tool result not available');
    expect(stats.syntheticPlaceholders).toBe(1);
  });

  it('preserves a duplicate tool result as a user note instead of dropping it', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      assistant(['a_0', 'q']),
      tool('a_0', 'q', 'first'),
      tool('a_0', 'q', 'second'), // duplicate id — must not be silently dropped
    ];
    const out = enforceToolResultAdjacency(messages, stats);
    expect(checkToolResultAdjacency(out).ok).toBe(true);

    // The first-wins result is the representative in the block.
    const block = out.filter((m) => m.role === 'tool' && m.toolCallId === 'a_0');
    expect(block).toHaveLength(1);
    expect((block[0] as { content: string }).content).toBe('first');

    // The duplicate's content survives as a labelled user note.
    const note = out.find(
      (m) => m.role === 'user' && (m.content as string).includes('Duplicate tool result'),
    );
    expect(note).toBeDefined();
    expect((note as { content: string }).content).toContain('second');
    expect(stats.orphanToUserConversions).toBe(1);
  });

  it('moves a result that precedes its assistant down into the block', () => {
    const messages: ChatMessage[] = [
      tool('a_0', 'q', 'early'),
      { role: 'user', content: 'now run' },
      assistant(['a_0', 'q']),
    ];
    const out = enforceToolResultAdjacency(messages);
    expect(checkToolResultAdjacency(out).ok).toBe(true);
    const lastTwo = out.slice(-2);
    expect(lastTwo[0]!.role).toBe('assistant');
    expect(lastTwo[1]!.role).toBe('tool');
  });
});

// ============================================================================
// §3 evidence — wire validity after the full sanitization pipeline
// ============================================================================

describe('§3 reconstruction — wire validity', () => {
  it('produces an adjacency-valid list for a parallel call buried behind cleared summaries', () => {
    // Turn-1 assistant fired two parallel calls; turns 2–3 are cleared summaries;
    // the two results sit after them, out of order. The boundary fix must pull
    // both results into the assistant block so the request is wire-valid.
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Look things up' },
      assistant(['parallel_0', 'memory.store.query'], ['parallel_1', 'memory.store.query']),
      { role: 'system', content: '[Turn 2 — 2 tool calls] cleared' },
      { role: 'system', content: '[Turn 3 — 2 tool calls] cleared' },
      tool('parallel_1', 'memory.store.query', '{"hits":["one"]}'),
      tool('parallel_0', 'memory.store.query', '{"hits":["zero"]}'),
    ];
    const sanitized = convertOrphanToolMessages(messages, stats);
    const out = enforceToolResultAdjacency(sanitized, stats);

    expect(checkToolResultAdjacency(out).ok).toBe(true);
    // The right output stays with the right call id (no swap from reordering).
    const p0 = out.find((m) => m.role === 'tool' && m.toolCallId === 'parallel_0');
    const p1 = out.find((m) => m.role === 'tool' && m.toolCallId === 'parallel_1');
    expect((p0 as { content: string }).content).toContain('zero');
    expect((p1 as { content: string }).content).toContain('one');
  });
});

// ============================================================================
// convertOrphanToolMessages — §6 soundness (no cross-call misattribution)
// ============================================================================

const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);
const HEX_C = 'c'.repeat(32);

describe('convertOrphanToolMessages — §6 soundness', () => {
  it('§6.1: a raw-UUID result after a system reset is NOT claimed by the prior assistant', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      assistant([`${HEX_A}_0`, 'memory.store.query'], [`${HEX_A}_1`, 'memory.store.query']),
      { role: 'system', content: '[Turn 2 — cleared]' },
      // raw-UUID result of a different step-exec, same tool name
      tool('11112222-3333-4444-5555-666677778888', 'memory.store.query', 'other output'),
    ];
    const out = convertOrphanToolMessages(messages, stats);
    expect(out[3]!.role).toBe('user');
    expect((out[3] as { content: string }).content).toContain(
      '[Context result from memory.store.query]',
    );
    expect(stats.rawUuidNameRemaps).toBe(0);
    expect(stats.orphanToUserConversions).toBe(1);
  });

  it('§6.1: a raw-UUID result after a user reset is NOT claimed by the prior assistant', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      assistant([`${HEX_A}_0`, 'search']),
      { role: 'user', content: '[Context result from earlier]: ...' },
      tool('99998888-7777-6666-5555-444433332222', 'search', 'stray output'),
    ];
    const out = convertOrphanToolMessages(messages, stats);
    expect(out[2]!.role).toBe('user');
    expect(stats.rawUuidNameRemaps).toBe(0);
  });

  it('§6.2: a compact-id result immediately after a different same-named assistant is NOT remapped', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      assistant([`${HEX_A}_0`, 'search']),
      // compact id, different base — a real defect, not a rename → user note, not a guess
      tool(`${HEX_B}_0`, 'search', 'wrong-call output'),
    ];
    const out = convertOrphanToolMessages(messages, stats);
    expect(out[1]!.role).toBe('user');
    expect(stats.rawUuidNameRemaps).toBe(0);
  });

  it('§6.2: a raw-UUID result immediately after its same-named assistant still remaps (legit)', () => {
    const stats = emptySanitizationStats();
    const messages: ChatMessage[] = [
      assistant([`${HEX_C}_0`, 'eval.list']),
      tool('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'eval.list', '{"suites":[]}'),
    ];
    const out = convertOrphanToolMessages(messages, stats);
    expect(out[1]!.role).toBe('tool');
    expect((out[1] as { toolCallId: string }).toolCallId).toBe(`${HEX_C}_0`);
    expect(stats.rawUuidNameRemaps).toBe(1);
  });
});

// ============================================================================
// §3 misattribution — folded into the same regression suite (commit 2)
// ============================================================================

describe('§3 reconstruction — no misattribution', () => {
  // Stranded assistant (its own results were destroyed by clearing) vs the
  // surviving orphan results of a DIFFERENT step-exec sharing a tool name.
  const STRANDED = '4cb66ca735874ced85b702d30729862f';
  const ORPHAN = '3e929805aaaa4ced85b702d30729862f';

  function build(intervening: 'system' | 'user'): ChatMessage[] {
    const bridge: ChatMessage =
      intervening === 'system'
        ? { role: 'system', content: '[Turn 2 — 2 tool calls] cleared' }
        : { role: 'user', content: '[Context result from earlier]: ...' };
    return [
      { role: 'user', content: 'Look things up' },
      assistant([`${STRANDED}_0`, 'memory.store.query'], [`${STRANDED}_1`, 'memory.store.query']),
      bridge,
      { role: 'system', content: '[Turn 3 — 2 tool calls] cleared' },
      tool(`${ORPHAN}_0`, 'memory.store.get', 'GET output'),
      tool(`${ORPHAN}_1`, 'memory.store.query', 'QUERY output'),
    ];
  }

  for (const intervening of ['system', 'user'] as const) {
    it(`does not attribute one call's result to another (intervening ${intervening})`, () => {
      const stats = emptySanitizationStats();
      const sanitized = convertOrphanToolMessages(build(intervening), stats);
      const out = enforceToolResultAdjacency(sanitized, stats);

      // Wire valid.
      expect(checkToolResultAdjacency(out).ok).toBe(true);

      // The stranded calls get labelled placeholders — never the orphan's output.
      const strandedResults = out.filter(
        (m) =>
          m.role === 'tool' &&
          (m.toolCallId === `${STRANDED}_0` || m.toolCallId === `${STRANDED}_1`),
      );
      expect(strandedResults).toHaveLength(2);
      for (const r of strandedResults) {
        expect((r as { content: string }).content).toContain('Tool result not available');
      }

      // The orphan outputs survive as labelled user notes — not lost, not misattributed.
      const userText = out
        .filter((m) => m.role === 'user')
        .map((m) => (m as { content: string }).content)
        .join('\n');
      expect(userText).toContain('QUERY output');
      expect(userText).toContain('GET output');
      expect(stats.rawUuidNameRemaps).toBe(0);
    });
  }
});
