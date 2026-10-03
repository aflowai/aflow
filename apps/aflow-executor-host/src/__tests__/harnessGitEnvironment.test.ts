/**
 * Contract: a commission reads the objects a push sends. Its checkout is the
 * stored commit, and the environment the sandbox is handed for the coding
 * agent turns replace refs off for any git the agent runs — whether or not a
 * sandbox can start where the test runs: the spawn alone is stood in for, and
 * the agent's command still runs, under exactly that environment.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';

const run = promisify(execFile);
const handed: SandboxedRunInput[] = [];

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      handed.push(input);
      const [program, ...args] = input.argv;
      const { stdout, stderr } = await run(program ?? '', args, {
        cwd: input.cwd,
        env: { PATH: process.env['PATH'] ?? '', ...input.env, ...input.trustedEnv },
      });
      return {
        processId: 'hr_test',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout,
        stderr,
        truncated: false,
      };
    },
  };
});

const { createHostHarnessHandler } = await import('../handlers/harnessHandlers.js');

let base: string;
let repo: string;
let stored: string;

async function git(...args: string[]): Promise<string> {
  return (await run('git', ['-C', repo, ...args])).stdout.trim();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'host-harness-git-env-'));
  repo = join(base, 'project');
  await mkdir(repo, { recursive: true });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), 'stored\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'stored');
  stored = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'stand-in\n');
  await git('commit', '-qam', 'stand-in');
  const standIn = await git('rev-parse', 'HEAD');
  await git('reset', '-q', '--hard', stored);
  await git('replace', stored, standIn);
  await writeFile(
    join(base, 'host-policy.json'),
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
          sandbox: 'confined',
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
      harnesses: [
        {
          id: 'reads',
          executable: '/bin/sh',
          args: [
            '-c',
            'printf "%s\\n" "$GIT_NO_REPLACE_OBJECTS" > replace-env.txt; ' +
              'git log -1 --format=%s > subject.txt; cp README.md readme.txt',
          ],
        },
      ],
    }),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("a commission's git", () => {
  it('runs with replace refs off, in a checkout of the stored commit', async () => {
    // The planted ref bites git as the operator runs it.
    expect(await git('log', '-1', '--format=%s', stored)).toBe('stand-in');

    const written: Record<string, unknown> = {};
    const outcome = await createHostHarnessHandler(join(base, 'host-policy.json')).execute({
      operationId: 'host.harness.run',
      spaceId: 'space-test',
      runId: 'run-git-env',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve({ bindingId: 'hb', harness: 'reads', task: 'Read.', timeoutMs: 60_000 }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (kind: string, data: unknown) => {
        written[kind] = data;
        return Promise.resolve(`inline:${kind}`);
      },
    } as never);

    expect(outcome.status).toBe('SUCCEEDED');
    expect(handed[0]?.trustedEnv?.['GIT_NO_REPLACE_OBJECTS']).toBe('1');
    const output = written['output'] as Record<string, unknown>;
    expect(output['baseSha']).toBe(stored);
    const patch = String(output['patch']);
    for (const [file, line] of [
      ['replace-env.txt', '1'],
      ['subject.txt', 'stored'],
      ['readme.txt', 'stored'],
    ] as const) {
      expect(patch, file).toMatch(new RegExp(`\\+\\+\\+ b/${file}\\n@@ [^\\n]+\\n\\+${line}\\n`));
    }
  }, 60_000);
});
