/**
 * Contract: what a harness step streams is what the harness is doing, and what
 * the result carries is what it said.
 *
 * A harness that prints an event stream must never reach a viewer on the
 * channel that carries an agent's message — a run's tool calls rendered as the
 * agent speaking is the failure this channel exists to prevent — and the raw
 * stream must never reach the result, where it is neither the answer nor
 * diagnostics.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { HarnessActivityLineSchema, type HarnessActivityLine } from '@aflow/schemas';
import { beforeAll, describe, expect, it } from 'vitest';

import { createHostHarnessHandler } from '../handlers/harnessHandlers.js';
import { sandboxReadiness } from '../sandboxedRun.js';

const ANSWER = 'The provider replays encrypted reasoning without a test to prove it.';

const EVENTS: readonly Record<string, unknown>[] = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5-1' },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the provider first.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'Read',
          input: { file_path: 'packages/ai-client/src/providers/xai.ts' },
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: 'toolu_01', type: 'tool_result', content: 'one\ntwo', is_error: false },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    duration_ms: 6000,
    total_cost_usd: 0.25,
    result: ANSWER,
  },
];

interface Captured {
  readonly deltas: Array<{ channel: string; delta: string }>;
  readonly output: Record<string, unknown>;
  readonly stored: Array<{ kind: string; data: unknown }>;
  readonly status: string;
}

describe.runIf(sandboxReadiness().ready)('a harness step that prints an event stream', () => {
  let policyPath: string;
  let repo: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'host-activity-'));
    repo = join(base, 'project');
    await mkdir(repo, { recursive: true });
    const vcs = async (...args: string[]): Promise<void> => {
      await promisify(execFile)('git', args, { cwd: repo });
    };
    await vcs('init', '-b', 'main');
    await vcs('config', 'user.email', 'test@example.com');
    await vcs('config', 'user.name', 'Test');
    await writeFile(join(repo, 'README.md'), '# project\n', 'utf8');
    // Committed, so replaying it is not a change the run made.
    await writeFile(
      join(repo, 'stream.ndjson'),
      `${EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
    await writeFile(join(repo, 'plain.txt'), 'the harness speaking\n', 'utf8');
    await vcs('add', '-A');
    await vcs('commit', '-m', 'initial');
    policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'hb',
            root: repo,
            mode: 'readwrite',
            allowsExecution: true,
            singleFile: false,
            spaceId: 'space-test',
          },
        ],
        harnesses: [
          {
            id: 'streaming',
            executable: '/bin/sh',
            args: ['-c', 'cat stream.ndjson'],
            output: 'claude-stream-json',
          },
          { id: 'talking', executable: '/bin/sh', args: ['-c', 'cat plain.txt'] },
        ],
      }),
    );
  });

  const run = async (harness: string): Promise<Captured> => {
    const deltas: Array<{ channel: string; delta: string }> = [];
    const stored: Array<{ kind: string; data: unknown }> = [];
    let output: Record<string, unknown> = {};
    const ctx = {
      operationId: 'host.harness.run',
      spaceId: 'space-test',
      runId: `run-${harness}`,
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve({
          bindingId: 'hb',
          harness,
          task: 'Review the provider.',
          resultRetries: 0,
          timeoutMs: 60_000,
        }),
      emitLiveDelta: (channel: string, delta: string) => {
        deltas.push({ channel, delta });
        return Promise.resolve();
      },
      writePayload: (kind: string, data: unknown) => {
        stored.push({ kind, data });
        if (kind === 'output') output = data as Record<string, unknown>;
        return Promise.resolve(`inline:${kind}`);
      },
    } as never;

    const outcome = await createHostHarnessHandler(policyPath).execute(ctx);
    return { deltas, output, stored, status: outcome.status };
  };

  it('emits the feed as activity, and nothing as the agent speaking', async () => {
    const { deltas, output, status } = await run('streaming');
    expect(status).toBe('SUCCEEDED');

    expect(deltas.map((d) => d.channel)).not.toContain('text');
    expect(new Set(deltas.map((d) => d.channel))).toEqual(new Set(['activity']));

    const lines: HarnessActivityLine[] = deltas.flatMap((d) =>
      d.delta
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => HarnessActivityLineSchema.parse(JSON.parse(line))),
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'status',
      'thought',
      'tool',
      'tool_result',
      'status',
    ]);
    expect(lines[2]).toMatchObject({
      kind: 'tool',
      tool: 'Read',
      text: 'Read packages/ai-client/src/providers/xai.ts',
    });

    // The answer, not the stream that carried it.
    expect(output['stdout']).toBe(ANSWER);
    expect(String(output['stdout'])).not.toContain('tool_use');
    expect(String(output['stdout'])).not.toContain('"type"');
  }, 120_000);

  it('keeps the whole feed once, under its own kind, and names it on the result', async () => {
    const { output, stored } = await run('streaming');

    const feeds = stored.filter((s) => s.kind === 'activity');
    // Once. A kind is one path per step and attempt, so a second write would
    // replace the first rather than add to it.
    expect(feeds).toHaveLength(1);
    expect(output['activityRef']).toBe('inline:activity');
    // Its own kind, never the step's output path.
    expect(stored.filter((s) => s.kind === 'output')).toHaveLength(1);

    const lines = (feeds[0]?.data as HarnessActivityLine[]).map((l) =>
      HarnessActivityLineSchema.parse(l),
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'status',
      'thought',
      'tool',
      'tool_result',
      'status',
    ]);
    expect(JSON.stringify(lines)).not.toContain('tool_use');
  }, 120_000);

  it('reads a harness that only talks as narration, never as the agent message', async () => {
    const { deltas, output, stored, status } = await run('talking');
    expect(status).toBe('SUCCEEDED');
    expect(new Set(deltas.map((d) => d.channel))).toEqual(new Set(['activity']));
    const lines = deltas.flatMap((d) =>
      d.delta
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as { kind: string; text?: string }),
    );
    expect(
      lines.some((l) => l.kind === 'thought' && l.text?.includes('the harness speaking')),
    ).toBe(true);
    expect(String(output['stdout'])).toContain('the harness speaking');
    // What it said is the feed, kept once and pointed at like any other.
    expect(stored.some((s) => s.kind === 'activity')).toBe(true);
    expect(typeof output['activityRef']).toBe('string');
  }, 120_000);
});
