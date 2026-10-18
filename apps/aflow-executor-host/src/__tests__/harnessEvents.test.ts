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

/**
 * Proof of life: what the agent says it is doing, the files it changes, and
 * which results are a command's exit status — read off the fields of each call,
 * so a renamed tool costs nothing.
 */
describe('what a watcher reads first', () => {
  function readCalls(
    calls: Array<{ id: string; name: string; input: unknown }>,
    results: Array<{ id: string; isError: boolean }> = [],
  ): HarnessActivityLine[] {
    const lines: HarnessActivityLine[] = [];
    const reader = createHarnessEventReader('claude-stream-json', (l) => lines.push(l), 0);
    for (const call of calls) {
      reader.push(
        `${JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', ...call }] },
        })}\n`,
      );
    }
    for (const result of results) {
      reader.push(
        `${JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: result.id,
                content: 'out',
                is_error: result.isError,
              },
            ],
          },
        })}\n`,
      );
    }
    return lines;
  }

  it('names the file a call changes, and not one it only reads', () => {
    const lines = readCalls([
      { id: 'a', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } },
      { id: 'b', name: 'Write', input: { file_path: 'src/b.ts', content: 'z' } },
      { id: 'c', name: 'Read', input: { file_path: 'src/c.ts' } },
      { id: 'd', name: 'Grep', input: { pattern: 'parse', path: 'src' } },
    ]);
    expect(lines.map((l) => (l.kind === 'tool' ? (l.changes ?? null) : 'other'))).toEqual([
      'src/a.ts',
      'src/b.ts',
      null,
      null,
    ]);
  });

  it('says what the agent marked in progress, once per change of plan', () => {
    const plan = (active: string) => ({
      todos: [
        { content: 'Read the parser', status: 'completed', activeForm: 'Reading the parser' },
        { content: active, status: 'in_progress', activeForm: `${active}…` },
      ],
    });
    const lines = readCalls([
      { id: 'a', name: 'TodoWrite', input: plan('Run the tests') },
      { id: 'b', name: 'TodoWrite', input: plan('Run the tests') },
      { id: 'c', name: 'TodoWrite', input: plan('Fix the guard') },
    ]);
    expect(lines.filter((l) => l.kind === 'intent').map((l) => l.text)).toEqual([
      'Run the tests…',
      'Fix the guard…',
    ]);
  });

  it("marks a command's result as one, so its exit status can be judged apart", () => {
    const lines = readCalls(
      [
        { id: 'a', name: 'Bash', input: { command: 'yarn test' } },
        { id: 'b', name: 'Read', input: { file_path: 'missing.ts' } },
      ],
      [
        { id: 'a', isError: true },
        { id: 'b', isError: true },
      ],
    );
    const results = lines.filter((l) => l.kind === 'tool_result');
    expect(results[0]).toMatchObject({ tool: 'Bash', ok: false, command: true });
    expect(results[1]).toMatchObject({ tool: 'Read', ok: false });
    expect(results[1]).not.toHaveProperty('command');
  });
});

/**
 * The lines a real `codex exec --json` run printed (Plan 326 §6 M1, M3), with
 * the file-change, to-do and failure shapes Codex documents for the same
 * stream.
 */
const CODEX_EVENTS: readonly Record<string, unknown>[] = [
  { type: 'thread.started', thread_id: '01a14f39-d98a-7431-b7e3-35566c85ea84' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'I’ll read a.txt, then create b.txt.' },
  },
  {
    type: 'item.started',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: "/bin/zsh -lc 'cat a.txt'",
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: "/bin/zsh -lc 'cat a.txt'",
      aggregated_output: 'hi\n',
      exit_code: 0,
      status: 'completed',
    },
  },
  {
    type: 'item.updated',
    item: {
      id: 'item_2',
      type: 'todo_list',
      items: [
        { text: 'Read a.txt', completed: true },
        { text: 'Write b.txt', completed: false },
      ],
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_3',
      type: 'file_change',
      changes: [{ path: 'b.txt', kind: 'add' }],
      status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: {
      id: 'item_4',
      type: 'mcp_tool_call',
      server: 'probe',
      tool: 'probe_echo',
      arguments: {},
      result: null,
      error: null,
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_4',
      type: 'mcp_tool_call',
      server: 'probe',
      tool: 'probe_echo',
      arguments: {},
      result: { content: [{ type: 'text', text: 'pineapple' }], structured_content: null },
      error: null,
      status: 'completed',
    },
  },
  { type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: 'done' } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 43790, cached_input_tokens: 41088, output_tokens: 89 },
  },
];

function readCodex(events: readonly Record<string, unknown>[]): {
  lines: HarnessActivityLine[];
  reader: ReturnType<typeof createHarnessEventReader>;
} {
  const lines: HarnessActivityLine[] = [];
  const reader = createHarnessEventReader('codex-jsonl', (line) => lines.push(line), Date.now());
  reader.push(events.map((event) => JSON.stringify(event)).join('\n'));
  reader.flush();
  return { lines, reader };
}

describe('reading a Codex event stream', () => {
  it('turns the stream into activity, narrating each call once', () => {
    const { lines } = readCodex(CODEX_EVENTS);
    expect(lines.map(({ at: _at, ...rest }) => rest)).toEqual([
      { kind: 'status', text: 'Harness started' },
      { kind: 'thought', text: 'I’ll read a.txt, then create b.txt.' },
      { kind: 'tool', tool: 'shell', text: 'shell cat a.txt' },
      { kind: 'tool_result', tool: 'shell', ok: true, text: 'hi', command: true },
      { kind: 'intent', text: 'Write b.txt' },
      { kind: 'tool', tool: 'edit', text: 'add b.txt', changes: 'b.txt' },
      { kind: 'tool', tool: 'probe.probe_echo', text: 'probe.probe_echo' },
      { kind: 'tool_result', tool: 'probe.probe_echo', ok: true, text: 'pineapple' },
      { kind: 'thought', text: 'done' },
      { kind: 'status', text: 'Finished · 43790 tokens in · 89 out' },
    ]);
  });

  it('answers with the last agent message and reports the conversation id Codex named', () => {
    const { reader } = readCodex(CODEX_EVENTS);
    expect(reader.answer()).toBe('done');
    expect(reader.conversationId()).toBe('01a14f39-d98a-7431-b7e3-35566c85ea84');
  });

  it('reports no conversation id for a run that ended before naming one', () => {
    const { reader } = readCodex([{ type: 'turn.started' }]);
    expect(reader.conversationId()).toBeUndefined();
  });

  it('marks a failed command and a failed tool call as not ok', () => {
    const { lines } = readCodex([
      {
        type: 'item.completed',
        item: {
          id: 'c',
          type: 'command_execution',
          command: 'false',
          aggregated_output: '',
          exit_code: 1,
          status: 'failed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'm',
          type: 'mcp_tool_call',
          server: 's',
          tool: 't',
          arguments: {},
          result: null,
          error: { message: 'tool exploded' },
          status: 'failed',
        },
      },
    ]);
    const results = lines.filter((line) => line.kind === 'tool_result');
    expect(results[0]).toMatchObject({ tool: 'shell', ok: false, command: true });
    expect(results[1]).toMatchObject({ tool: 's.t', ok: false, text: 'tool exploded' });
  });

  it('says why a turn failed', () => {
    const { lines } = readCodex([
      { type: 'turn.failed', error: { message: 'usage limit reached' } },
    ]);
    expect(lines.at(-1)).toMatchObject({ kind: 'status', text: 'Failed: usage limit reached' });
  });
});
