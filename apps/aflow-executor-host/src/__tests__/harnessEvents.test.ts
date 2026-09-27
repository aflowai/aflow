/**
 * Contract: a harness that prints an event stream is read as activity.
 *
 * The lines below are the shapes a real `claude --print --output-format
 * stream-json --verbose` run prints, trimmed of the fields nothing here reads.
 * They are a fixture rather than a recording so a reader can see what the
 * parser is answering to; the shapes themselves were measured, not invented.
 */
import type { HarnessActivityLine } from '@aflow/schemas';
import { describe, expect, it, vi } from 'vitest';

import {
  createHarnessEventReader,
  summarizeToolResult,
  summarizeToolUse,
} from '../harnessEvents.js';

const EVENTS: readonly Record<string, unknown>[] = [
  {
    type: 'system',
    subtype: 'init',
    cwd: '/work',
    session_id: 's1',
    tools: ['Bash', 'Read'],
    model: 'claude-fable-5-1',
    permissionMode: 'bypassPermissions',
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the provider and pull out its second line.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Read',
          input: { file_path: 'packages/ai-client/src/providers/xai.ts' },
        },
      ],
    },
    session_id: 's1',
  },
  // A harness prints events for its own lifecycle throughout. Nothing here
  // knows this one, and nothing should break on it.
  { type: 'rate_limit_event', session_id: 's1' },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_01',
          type: 'tool_result',
          content: '     1\talpha\n     2\tbeta\n     3\tgamma',
          is_error: false,
        },
      ],
    },
    session_id: 's1',
  },
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'The second line is beta.' }] },
    session_id: 's1',
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    duration_ms: 6000,
    total_cost_usd: 0.3484555,
    result: 'The second line is beta.',
    session_id: 's1',
  },
];

function stream(): string {
  return `${EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

function read(chunks: readonly string[]): { lines: HarnessActivityLine[]; answer: string } {
  const lines: HarnessActivityLine[] = [];
  const reader = createHarnessEventReader('claude-stream-json', (line) => lines.push(line), 0);
  for (const chunk of chunks) reader.push(chunk);
  reader.flush();
  return { lines, answer: reader.answer() };
}

describe('reading a Claude Code event stream', () => {
  it('turns the stream into activity lines in the order they happened', () => {
    const { lines } = read([stream()]);

    expect(lines.map((l) => l.kind)).toEqual([
      'status',
      'thought',
      'tool',
      'tool_result',
      'thought',
      'status',
    ]);
    expect(lines[0]).toMatchObject({ kind: 'status', text: 'Model claude-fable-5-1' });
    expect(lines[2]).toMatchObject({
      kind: 'tool',
      tool: 'Read',
      text: 'Read packages/ai-client/src/providers/xai.ts',
    });
    // The result names the call it answers, not the tool. A feed that could not
    // say which of several in-flight calls came back would be telling a reader
    // that something finished, never what.
    expect(lines[3]).toMatchObject({ kind: 'tool_result', tool: 'Read', ok: true });
    expect(lines[3]?.text).toBe('1 alpha (+2 more lines)');
    expect(lines[5]).toMatchObject({
      kind: 'status',
      text: 'Finished in 6.0s · 2 turns · $0.3485',
    });
  });

  it('reads the final answer out of the result event, never out of the stream', () => {
    const { answer } = read([stream()]);
    expect(answer).toBe('The second line is beta.');
    expect(answer).not.toContain('tool_use');
  });

  it('holds a line split across two chunks until the chunk that completes it', () => {
    // Two separate reads, compared whole — and every line carries `at`, which the
    // reader stamps from the clock. A millisecond falling between the two reads
    // makes every `at` differ by one and the comparison fail on nothing: the
    // property under test is where the chunk boundary lands, not when. Frozen
    // rather than excluded from the comparison, so the field stays covered.
    vi.useFakeTimers();
    try {
      const whole = stream();
      const cut = Math.floor(whole.length / 2);
      const split = read([whole.slice(0, cut), whole.slice(cut)]);
      expect(split.lines).toEqual(read([whole]).lines);
      expect(split.answer).toBe('The second line is beta.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a line that is not JSON through as narration rather than dropping it', () => {
    const { lines } = read([
      'Loading plugins from the marketplace…\n',
      `${JSON.stringify(EVENTS[0])}\n`,
    ]);
    expect(lines[0]).toMatchObject({
      kind: 'thought',
      text: 'Loading plugins from the marketplace…',
    });
    expect(lines[1]).toMatchObject({ kind: 'status' });
  });

  it('reports a run cut short by what it last said, never by its raw stream', () => {
    const upToTool = `${EVENTS.slice(0, 2)
      .map((e) => JSON.stringify(e))
      .join('\n')}\n`;
    const { answer } = read([upToTool]);
    expect(answer).toBe('I will read the provider and pull out its second line.');
  });

  it('carries the last unterminated line on flush', () => {
    const lines: HarnessActivityLine[] = [];
    const reader = createHarnessEventReader('claude-stream-json', (l) => lines.push(l), 0);
    // No trailing newline: what a harness killed mid-write leaves behind.
    reader.push(JSON.stringify(EVENTS[0]));
    expect(lines).toHaveLength(0);
    reader.flush();
    expect(lines).toHaveLength(1);
  });
});

describe('a harness whose output is plain text', () => {
  it('shows every line as narration and answers with all of it', () => {
    const lines: HarnessActivityLine[] = [];
    const reader = createHarnessEventReader('text', (l) => lines.push(l), 0);
    reader.push('Looking at the diff.\nTwo files changed.\n');
    reader.flush();
    expect(lines.map((l) => l.text)).toEqual(['Looking at the diff.', 'Two files changed.']);
    expect(reader.answer()).toBe('Looking at the diff.\nTwo files changed.');
  });
});

describe('what a tool call reads as', () => {
  it('names the tool and the most telling thing it was given', () => {
    expect(
      summarizeToolUse('Bash', { command: 'yarn test:file x.test.ts', description: 'run' }),
    ).toBe('Bash yarn test:file x.test.ts');
    expect(summarizeToolUse('Grep', { pattern: 'emitLiveDelta', path: 'packages' })).toBe(
      'Grep emitLiveDelta',
    );
    // No field this knows: the first string rather than nothing, because a
    // tool name on its own says a call happened and not what it was.
    expect(summarizeToolUse('Weird', { subject: 'the second commit' })).toBe(
      'Weird the second commit',
    );
    expect(summarizeToolUse('Weird', { count: 3 })).toBe('Weird');
  });

  it('keeps a long value to one readable line', () => {
    const summary = summarizeToolUse('Bash', { command: 'echo '.repeat(400) });
    expect(summary.length).toBeLessThan(400);
    expect(summary).not.toContain('\n');
  });

  it('summarises a result by its first line and how many more there were', () => {
    expect(summarizeToolResult('only one line')).toBe('only one line');
    expect(summarizeToolResult('first\nsecond\nthird')).toBe('first (+2 more lines)');
    expect(summarizeToolResult([{ type: 'text', text: 'from a content block' }])).toBe(
      'from a content block',
    );
    expect(summarizeToolResult('')).toBe('No output');
  });

  it('marks a tool that reported an error without failing the step', () => {
    const lines: HarnessActivityLine[] = [];
    const reader = createHarnessEventReader('claude-stream-json', (l) => lines.push(l), 0);
    reader.push(
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'toolu_unknown',
              type: 'tool_result',
              content: 'No such file or directory',
              is_error: true,
            },
          ],
        },
      })}\n`,
    );
    expect(lines[0]).toMatchObject({
      kind: 'tool_result',
      tool: 'tool',
      ok: false,
      text: 'No such file or directory',
    });
  });
});
