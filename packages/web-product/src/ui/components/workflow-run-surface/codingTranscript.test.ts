import { describe, expect, it } from 'vitest';
import { parseCodingTranscript } from './codingTranscript.js';

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n');
}

describe('parseCodingTranscript', () => {
  it('drops thinking_tokens system deltas entirely', () => {
    const raw = jsonl(
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 186 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 188 },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    );
    const { entries } = parseCodingTranscript(raw);
    expect(entries).toEqual([{ kind: 'assistant', text: 'Done.' }]);
  });

  it('flattens assistant content blocks into ordered entries', () => {
    const raw = jsonl({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Let me check.' },
          { type: 'text', text: 'Running checks.' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'yarn typecheck' } },
        ],
      },
    });
    const { entries, thinkingCount } = parseCodingTranscript(raw);
    expect(thinkingCount).toBe(1);
    expect(entries.map((e) => e.kind)).toEqual(['thinking', 'assistant', 'tool']);
    const tool = entries[2];
    expect(tool).toMatchObject({ kind: 'tool', name: 'Bash', summary: 'yarn typecheck' });
  });

  it('pairs a tool_use with its tool_result by id', () => {
    const raw = jsonl(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'call_9', name: 'Bash', input: { command: 'head x' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              tool_use_id: 'call_9',
              type: 'tool_result',
              content: 'file contents',
              is_error: false,
            },
          ],
        },
      },
    );
    const { entries } = parseCodingTranscript(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      result: { isError: false, text: 'file contents' },
    });
  });

  it('marks an errored tool_result and joins array content', () => {
    const raw = jsonl(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }] },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              tool_use_id: 'c1',
              type: 'tool_result',
              is_error: true,
              content: [
                { type: 'text', text: 'line one' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      },
    );
    const { entries } = parseCodingTranscript(raw);
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      result: { isError: true, text: 'line one\nline two' },
    });
  });

  it('captures the human prompt as a user entry', () => {
    const raw = jsonl({ type: 'user', message: { role: 'user', content: 'Build the workbench.' } });
    const { entries } = parseCodingTranscript(raw);
    expect(entries).toEqual([{ kind: 'user', text: 'Build the workbench.' }]);
  });

  it('extracts the final result with usage metadata', () => {
    const raw = jsonl({
      type: 'result',
      result: 'Done — edited README.',
      num_turns: 7,
      total_cost_usd: 0.42,
      duration_ms: 12000,
      is_error: false,
    });
    const { entries } = parseCodingTranscript(raw);
    expect(entries[0]).toEqual({
      kind: 'result',
      text: 'Done — edited README.',
      isError: false,
      numTurns: 7,
      costUsd: 0.42,
      durationMs: 12000,
    });
  });

  it('handles top-level OpenCode tool/edit forms', () => {
    const raw = jsonl(
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'file_edit', path: 'b.ts' },
    );
    const { entries } = parseCodingTranscript(raw);
    expect(entries).toEqual([
      {
        kind: 'tool',
        name: 'Read',
        summary: 'a.ts',
        input: { file_path: 'a.ts' },
        result: undefined,
      },
      {
        kind: 'tool',
        name: 'edit',
        summary: 'b.ts',
        input: { type: 'file_edit', path: 'b.ts' },
        result: undefined,
      },
    ]);
  });

  it('counts unparseable lines (e.g. a leading partial line from tail-truncation)', () => {
    const raw = ['{"type":"assist', jsonl({ type: 'result', result: 'ok' })].join('\n');
    const { entries, skippedLines } = parseCodingTranscript(raw);
    expect(skippedLines).toBe(1);
    expect(entries).toHaveLength(1);
  });
});
