/**
 * Contract: a harness task that declares an output schema comes back as a
 * typed result, or it fails. Free text is diagnostics, and a run that answered
 * only in its console output answered nowhere.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { HostHarnessRunInputSchema, HostHarnessRunOutputSchema } from '@aflow/schemas';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  compileResultValidator,
  composeHarnessTask,
  createHostHarnessHandler,
  hasRepositoryRules,
  readHarnessResult,
  resultInstruction,
  retryInstruction,
  taskWithInputs,
  validateResultText,
} from '../handlers/harnessHandlers.js';
import { runSandboxed, sandboxAvailable, sandboxReadiness } from '../sandboxedRun.js';
import { HostBindingSchema } from '../bindings.js';

const schema = {
  type: 'object',
  properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
  required: ['verdict'],
  additionalProperties: false,
} as const;

const validator = (): ReturnType<typeof compileResultValidator> =>
  compileResultValidator(schema as unknown as Record<string, unknown>);

describe('the task carries where the answer goes', () => {
  it('names the file and the schema', () => {
    const instruction = resultInstruction(schema as unknown as Record<string, unknown>);
    expect(instruction).toContain('.aflow/result.json');
    expect(instruction).toContain('"verdict"');
  });

  it('tells a resumable harness only what was wrong', () => {
    const again = retryInstruction(
      'Assess the repository.',
      schema as unknown as Record<string, unknown>,
      'no result file was written at `.aflow/result.json`',
      true,
    );
    expect(again).toContain('no result file was written');
    expect(again).not.toContain('Assess the repository.');
  });

  it('gives a harness that cannot be resumed the whole task back', () => {
    // A fresh conversation remembers nothing, so a correction alone would be a
    // task with no subject.
    const again = retryInstruction(
      'Assess the repository.',
      schema as unknown as Record<string, unknown>,
      'the JSON does not match the schema',
      false,
    );
    expect(again).toContain('Assess the repository.');
    expect(again).toContain('.aflow/result.json');
  });
});

describe('what counts as a result', () => {
  it('accepts JSON that matches', () => {
    const check = validateResultText('{"verdict":"sound","confidence":0.8}', validator());
    expect(check.ok).toBe(true);
    expect(check.ok === true ? check.value : undefined).toEqual({
      verdict: 'sound',
      confidence: 0.8,
    });
  });

  it('refuses text that is not JSON, and says so by path', () => {
    const check = validateResultText('The repository looks fine.', validator());
    expect(check.ok).toBe(false);
    expect(check.ok === false ? check.problem : '').toContain('.aflow/result.json');
  });

  it('refuses JSON that misses the schema, naming what was wrong', () => {
    const check = validateResultText('{"confidence":0.8}', validator());
    expect(check.ok).toBe(false);
    // The harness gets this back verbatim on its next turn, so it has to say
    // what to change rather than that something is wrong.
    expect(check.ok === false ? check.problem : '').toContain('verdict');
  });
});

describe('the task carries its inputs', () => {
  it('appends them as JSON after the prose, and nothing when there are none', () => {
    const text = taskWithInputs('Review the range.', { range: 'main..HEAD', depth: 'deep' });
    expect(text.startsWith('Review the range.')).toBe(true);
    expect(text).toContain('"range":"main..HEAD"');
    expect(taskWithInputs('Review the range.', undefined)).toBe('Review the range.');
    expect(taskWithInputs('Review the range.', {})).toBe('Review the range.');
  });
});

describe("the task carries the repository's own rules", () => {
  let checkout: string;
  beforeEach(async () => {
    checkout = await mkdtemp(join(tmpdir(), 'aflow-rules-'));
  });
  afterEach(async () => {
    await rm(checkout, { recursive: true, force: true });
  });

  it('names CLAUDE.md before the task when the checkout holds one', async () => {
    await writeFile(join(checkout, 'CLAUDE.md'), '# Rules\n', 'utf8');
    expect(await hasRepositoryRules(checkout)).toBe(true);
    const text = composeHarnessTask('Review the range.', { range: 'main..HEAD' }, true);
    expect(text.startsWith("The repository's own instructions are in `CLAUDE.md`")).toBe(true);
    expect(text).toContain('treat them as binding');
    expect(text).toContain('Review the range.');
    expect(text).toContain('"range":"main..HEAD"');
  });

  it('says nothing about it when the checkout has none', async () => {
    expect(await hasRepositoryRules(checkout)).toBe(false);
    expect(composeHarnessTask('Review the range.', undefined, false)).toBe('Review the range.');
  });

  it('asks the checkout rather than a directory of the same name', async () => {
    // A directory called CLAUDE.md is not a file the harness can read, and a
    // task telling it to read one would send it after nothing.
    await mkdir(join(checkout, 'CLAUDE.md'), { recursive: true });
    expect(await hasRepositoryRules(checkout)).toBe(false);
  });
});

describe('a schema is compiled for one run', () => {
  it('accepts the same `$id` from the next run', () => {
    const schema = { $id: 'https://example.test/result', type: 'object' };
    expect(() => compileResultValidator(schema)).not.toThrow();
    expect(() => compileResultValidator(schema)).not.toThrow();
  });
});

describe('reading the result out of the checkout', () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'aflow-result-'));
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it('reports a run that wrote nothing as a missing file, by path', async () => {
    const check = await readHarnessResult(join(worktree, '.aflow/result.json'), validator());
    expect(check.ok).toBe(false);
    expect(check.ok === false ? check.problem : '').toBe(
      'no result file was written at `.aflow/result.json`',
    );
  });

  it('reads and validates what the harness left', async () => {
    await mkdir(join(worktree, '.aflow'), { recursive: true });
    await writeFile(join(worktree, '.aflow/result.json'), '{"verdict":"sound"}', 'utf8');
    const check = await readHarnessResult(join(worktree, '.aflow/result.json'), validator());
    expect(check.ok === true ? check.value : undefined).toEqual({ verdict: 'sound' });
  });
});

describe('the wire contract', () => {
  it('defaults to one further turn when a schema is given', () => {
    const input = HostHarnessRunInputSchema.parse({
      bindingId: 'hb_project',
      harness: 'claude',
      task: 'Assess the repository.',
      outputSchema: schema,
    });
    expect(input.resultRetries).toBe(1);
    expect(input.outputSchema).toEqual(schema);
  });

  it('leaves a task with no schema unchanged', () => {
    const input = HostHarnessRunInputSchema.parse({
      bindingId: 'hb_project',
      harness: 'claude',
      task: 'Add a test.',
    });
    expect(input.outputSchema).toBeUndefined();
  });

  it('carries the validated result beside the diff, and says which harness ran', () => {
    const output = HostHarnessRunOutputSchema.parse({
      runId: 'hr_1',
      harness: { id: 'claude', label: 'Claude Code' },
      continued: false,
      baseSha: 'abc',
      result: { verdict: 'sound' },
      filesChanged: 0,
      patchTruncated: false,
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      truncated: false,
      applies: 'empty',
      headMoved: false,
      refChanges: [],
      blockedDomains: [],
    });
    expect(output.result).toEqual({ verdict: 'sound' });
    // The name a card shows comes from the result, not from reading the step's
    // input back — a call that named no harness has no id there at all.
    expect(output.harness).toEqual({ id: 'claude', label: 'Claude Code' });
  });

  it('refuses a result that does not say which harness ran', () => {
    expect(() =>
      HostHarnessRunOutputSchema.parse({
        runId: 'hr_1',
        continued: false,
        baseSha: 'abc',
        filesChanged: 0,
        patchTruncated: false,
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        truncated: false,
        applies: 'empty',
        headMoved: false,
        refChanges: [],
        blockedDomains: [],
      }),
    ).toThrow();
  });

  it('reports what changed among the local branches and tags, and requires the field', () => {
    const output = {
      runId: 'hr_1',
      harness: { id: 'claude' },
      continued: false,
      baseSha: 'abc',
      filesChanged: 0,
      patchTruncated: false,
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      truncated: false,
      applies: 'empty',
      headMoved: false,
      blockedDomains: [],
    };
    const refChanges = [
      { ref: 'refs/heads/mine', change: 'created', to: 'def' },
      { ref: 'refs/heads/old', change: 'deleted', from: 'abc' },
      { ref: 'refs/tags/v1', change: 'moved', from: 'abc', to: 'def' },
    ];
    expect(HostHarnessRunOutputSchema.parse({ ...output, refChanges }).refChanges).toEqual(
      refChanges,
    );
    expect(HostHarnessRunOutputSchema.safeParse(output).success).toBe(false);
    expect(
      HostHarnessRunOutputSchema.safeParse({
        ...output,
        refChanges: [{ ref: 'refs/heads/x', change: 'renamed' }],
      }).success,
    ).toBe(false);
  });
});

describe('a harness is never waiting on input nobody is sending', () => {
  it.runIf(sandboxAvailable())(
    'ends the standard input of a run that asked for it closed',
    async () => {
      // `cat` with no argument reads stdin until it ends. Left open it would
      // sit there until the timeout below, which is what a harness CLI does
      // for the first seconds of every run.
      const root = await mkdtemp(join(tmpdir(), 'aflow-stdin-'));
      const scratch = await mkdtemp(join(tmpdir(), 'aflow-stdin-scr-'));
      try {
        const result = await runSandboxed({
          binding: HostBindingSchema.parse({
            id: 'hb',
            root,
            mode: 'readwrite',
            allowsExecution: true,
          }),
          argv: ['/bin/cat'],
          cwd: root,
          env: {},
          timeoutMs: 20_000,
          scratchDir: scratch,
          idPrefix: 't',
          ownerRunId: 'probe',
          closeStdin: true,
          signal: new AbortController().signal,
          onDelta: () => undefined,
        });
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe.runIf(sandboxReadiness().ready)('a check that rejects an answer keeps the work', () => {
  let policyPath: string;
  let repo: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'host-harness-'));
    repo = join(base, 'project');
    await mkdir(repo, { recursive: true });
    const vcs = async (...args: string[]): Promise<void> => {
      await promisify(execFile)('git', args, { cwd: repo });
    };
    await vcs('init', '-b', 'main');
    await vcs('config', 'user.email', 'test@example.com');
    await vcs('config', 'user.name', 'Test');
    await writeFile(join(repo, 'README.md'), '# project\n', 'utf8');
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
        // Edits a file and writes no result — the run this contract is about.
        harnesses: [
          {
            id: 'fake',
            label: 'Fake harness',
            executable: '/bin/sh',
            args: ['-c', 'printf changed > touched.txt'],
          },
        ],
      }),
    );
  });

  it('returns the diff on the failure when no valid result was written', async () => {
    const written: Record<string, unknown> = {};
    const ctx = {
      operationId: 'host.harness.run',
      spaceId: 'space-test',
      runId: 'run-test',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve({
          bindingId: 'hb',
          harness: 'fake',
          task: 'Assess the repository.',
          outputSchema: schema,
          resultRetries: 0,
          timeoutMs: 60_000,
        }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (kind: string, data: unknown) => {
        written[kind] = data;
        return Promise.resolve(`inline:${kind}`);
      },
    } as never;

    const outcome = await createHostHarnessHandler(policyPath).execute(ctx);
    expect(outcome.status).toBe('FAILED');
    const error = written['error'] as { message: string; details: Record<string, unknown> };
    expect(error.message).toContain('.aflow/result.json');
    // The run edited a file and answered nothing. Both facts come back.
    expect(error.details['filesChanged']).toBe(1);
    expect(String(error.details['patch'])).toContain('touched.txt');
    expect(String(error.details['patch'])).toContain('changed');
    expect(error.details['baseSha']).toEqual(expect.any(String));
    expect(error.details).not.toHaveProperty('result');
    // Which harness ran travels on a failure too: the card that reports it has
    // the same name to show whether the run answered or not.
    expect(error.details['harness']).toEqual({ id: 'fake', label: 'Fake harness' });
  }, 120_000);
});

describe.runIf(sandboxReadiness().ready)('a commission starts from a named ref', () => {
  let policyPath: string;
  let repo: string;
  let feature: string;
  let other: string;
  let operatorDone: string;
  const vcs = async (...args: string[]): Promise<string> =>
    (await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'host-harness-base-'));
    repo = join(base, 'project');
    await mkdir(repo, { recursive: true });
    await vcs('init', '-b', 'main');
    await vcs('config', 'user.email', 'test@example.com');
    await vcs('config', 'user.name', 'Test');
    await writeFile(join(repo, 'README.md'), '# project\n', 'utf8');
    await vcs('add', '-A');
    await vcs('commit', '-m', 'initial');
    await vcs('branch', 'feat/reviewed');
    await vcs('branch', 'other');
    feature = await vcs('rev-parse', 'feat/reviewed');
    other = feature;
    await writeFile(join(repo, 'README.md'), '# project, moved on\n', 'utf8');
    await vcs('commit', '-am', 'main moves on');

    // Inside the connected folder, which a harness may read: the harness waits
    // on it, so the operator's branch is made while the run is in flight.
    operatorDone = join(repo, '.operator-done');
    const harness = (id: string, script: string): Record<string, unknown> => ({
      id,
      executable: '/bin/sh',
      args: ['-c', script],
      // The shared refs live under the repository's `.git`, which a harness
      // cannot write unless its profile opens it. Opened here so only the hook
      // stands between the harness and the operator's branches.
      writePaths: [join(repo, '.git')],
    });
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
          harness('edits', 'printf changed > touched.txt'),
          harness('rewrites', "printf '# project, reviewed\\n' > README.md"),
          {
            ...harness('converses', "printf '# project, reviewed\\n' > README.md"),
            sessionArgs: ['{session}'],
            resumeArgs: ['{session}'],
          },
          harness('deletes', 'printf changed > touched.txt; git branch -D other'),
          harness(
            'waits',
            'printf changed > touched.txt; i=0; ' +
              `while [ ! -e '${operatorDone}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`,
          ),
        ],
      }),
    );
  });

  async function runWith(input: Record<string, unknown>) {
    const written: Record<string, unknown> = {};
    const ctx = {
      operationId: 'host.harness.run',
      spaceId: 'space-test',
      runId: 'run-base',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () =>
        Promise.resolve({ bindingId: 'hb', task: 'Fix it.', timeoutMs: 60_000, ...input }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (kind: string, data: unknown) => {
        written[kind] = data;
        return Promise.resolve(`inline:${kind}`);
      },
    } as never;
    const outcome = await createHostHarnessHandler(policyPath).execute(ctx);
    return { outcome, written };
  }

  it('checks out the named ref and reports it as the base, judged against itself', async () => {
    const { outcome, written } = await runWith({ harness: 'edits', base: 'feat/reviewed' });
    expect(outcome.status).toBe('SUCCEEDED');
    const output = written['output'] as Record<string, unknown>;
    expect(output['baseSha']).toBe(feature);
    expect(output['headMoved']).toBe(false);
    expect(String(output['patch'])).toContain('touched.txt');
  }, 120_000);

  it('judges whether the diff applies against the base, not the folder it moved away from', async () => {
    // The folder's README has moved on from the base's, so the same edit reads
    // as a conflict against it and applies cleanly where it would be published.
    const { outcome, written } = await runWith({ harness: 'rewrites', base: 'feat/reviewed' });
    expect(outcome.status).toBe('SUCCEEDED');
    const output = written['output'] as Record<string, unknown>;
    expect(String(output['patch'])).toContain('README.md');
    expect(output['applies']).toBe('clean');
    expect(output['applyConflict']).toBeUndefined();
  }, 120_000);

  it('judges a continued turn that names no base against the base its session started from', async () => {
    const first = await runWith({ harness: 'converses', base: 'feat/reviewed' });
    expect(first.outcome.status).toBe('SUCCEEDED');
    const sessionRef = (first.written['output'] as Record<string, unknown>)['sessionRef'];
    expect(sessionRef).toEqual(expect.any(String));

    const { outcome, written } = await runWith({ harness: 'converses', continueFrom: sessionRef });
    expect(outcome.status).toBe('SUCCEEDED');
    const output = written['output'] as Record<string, unknown>;
    expect(output['continued']).toBe(true);
    expect(output['baseSha']).toBe(feature);
    expect(String(output['patch'])).toContain('README.md');
    expect(output['applies']).toBe('clean');
    expect(output['headMoved']).toBe(false);
  }, 120_000);

  it('refuses a ref the folder does not have, naming it', async () => {
    const { outcome, written } = await runWith({ harness: 'edits', base: 'no-such-branch' });
    expect(outcome.status).toBe('FAILED');
    const error = written['error'] as { message: string; classification: string };
    expect(error.message).toContain('`no-such-branch`');
    expect(error.classification).toBe('validation');
  }, 120_000);

  it("stops the agent's own git from deleting a branch, and the run still succeeds", async () => {
    await vcs('branch', '-f', 'other', other);
    const { outcome, written } = await runWith({ harness: 'deletes' });
    expect(outcome.status).toBe('SUCCEEDED');
    const output = written['output'] as Record<string, unknown>;
    expect(await vcs('rev-parse', 'other')).toBe(other);
    expect(output['refChanges']).toEqual([]);
    expect(String(output['stderr'])).toContain(
      'Refused `refs/heads/other`: a commission may not move branches or tags',
    );
    expect(String(output['patch'])).toContain('touched.txt');
  }, 120_000);

  it('reports a branch the operator made while the run was in flight, and refuses nothing', async () => {
    await rm(operatorDone, { force: true });
    const running = runWith({ harness: 'waits' });
    // The harness has started once its edit is in its checkout, which is after
    // the refs were first read.
    let started = false;
    for (let i = 0; i < 600 && !started; i += 1) {
      const listing = await vcs('worktree', 'list', '--porcelain');
      const checkouts = listing
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
      for (const path of checkouts) {
        if (
          await stat(join(path, 'touched.txt')).then(
            () => true,
            () => false,
          )
        )
          started = true;
      }
      if (!started) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(started).toBe(true);
    await vcs('branch', 'operator-work');
    const made = await vcs('rev-parse', 'operator-work');
    await writeFile(operatorDone, '', 'utf8');

    const { outcome, written } = await running;
    expect(outcome.status).toBe('SUCCEEDED');
    const output = written['output'] as Record<string, unknown>;
    expect(output['refChanges']).toEqual([
      { ref: 'refs/heads/operator-work', change: 'created', to: made },
    ]);
    expect(String(output['patch'])).toContain('touched.txt');
  }, 120_000);

  it("starts from the remote's branch as it is now when the base names a remote", async () => {
    const upstream = await mkdtemp(join(tmpdir(), 'host-harness-upstream-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'host-harness-elsewhere-'));
    const at = async (cwd: string, ...args: string[]): Promise<string> =>
      (await promisify(execFile)('git', args, { cwd })).stdout.trim();
    try {
      await at(upstream, 'init', '--bare', '-b', 'main');
      await vcs('remote', 'add', 'origin', upstream);
      await vcs('push', '-q', 'origin', 'main');
      await vcs('fetch', '-q', 'origin');
      await at(elsewhere, 'clone', '-q', upstream, '.');
      await at(elsewhere, 'config', 'user.email', 'other@example.com');
      await at(elsewhere, 'config', 'user.name', 'Other');
      await writeFile(join(elsewhere, 'README.md'), '# project, upstream\n', 'utf8');
      await at(elsewhere, 'commit', '-qam', 'upstream moves on');
      await at(elsewhere, 'push', '-q', 'origin', 'main');
      const moved = await at(elsewhere, 'rev-parse', 'HEAD');

      const { outcome, written } = await runWith({ harness: 'edits', base: 'origin/main' });
      expect(outcome.status).toBe('SUCCEEDED');
      expect((written['output'] as Record<string, unknown>)['baseSha']).toBe(moved);

      await vcs('remote', 'set-url', 'origin', join(upstream, 'gone'));
      const refused = await runWith({ harness: 'edits', base: 'origin/main' });
      expect(refused.outcome.status).toBe('FAILED');
      const error = refused.written['error'] as { message: string; classification: string };
      expect(error.message).toContain('the remote `origin`');
      expect(error.classification).toBe('validation');
    } finally {
      await vcs('remote', 'remove', 'origin').catch(() => undefined);
      await rm(upstream, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);
});
