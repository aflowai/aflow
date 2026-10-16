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
import { createHostPatchHandler } from '../handlers/patchHandlers.js';
import { runSandboxed, sandboxAvailable, sandboxReadiness } from '../sandboxedRun.js';
import { INLINE_DIFF_CAP_BYTES } from '../worktree.js';
import { HostBindingSchema } from '../bindings.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const confined = requires(...CONFINEMENT_LISTENERS);

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
        blockedDomains: [],
      }),
    ).toThrow();
  });
});

describe('a harness is never waiting on input nobody is sending', () => {
  it.skipIf(!sandboxAvailable() || confined.skip)(
    confined.title('ends the standard input of a run that asked for it closed'),
    { tags: ['listener'], timeout: 60_000 },
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

  it.skipIf(confined.skip)(
    confined.title('returns the diff on the failure when no valid result was written'),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
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
      expect(error.details['patchRef']).toBe('inline:patch');
      expect(error.details['baseSha']).toEqual(expect.any(String));
      expect(error.details).not.toHaveProperty('result');
      // Which harness ran travels on a failure too: the card that reports it has
      // the same name to show whether the run answered or not.
      expect(error.details['harness']).toEqual({ id: 'fake', label: 'Fake harness' });
    },
  );
});

describe.runIf(sandboxReadiness().ready)('a commission starts from a named ref', () => {
  let policyPath: string;
  let repo: string;
  let feature: string;
  let other: string;
  const vcs = async (...args: string[]): Promise<string> =>
    (await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();
  const folderRefs = async (): Promise<string> =>
    await vcs('for-each-ref', '--format=%(refname) %(objectname)');

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

    const harness = (id: string, script: string): Record<string, unknown> => ({
      id,
      executable: '/bin/sh',
      args: ['-c', script],
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
          // Every way around a hook the run's git used to be given, and none is
          // given now: a hooks path of its own, a branch deleted and moved, and
          // pushes into the folder's path, then a record of where it all landed.
          harness(
            'goes-around',
            [
              'printf changed > touched.txt',
              'git branch -D other',
              'git -c core.hooksPath=/dev/null update-ref refs/heads/main HEAD',
              'git -c core.hooksPath=/dev/null tag planted',
              'git push -q . HEAD:refs/heads/pushed',
              `git push -q '${repo}' HEAD:refs/heads/pushed-into-folder`,
              `git push -q -f '${repo}' HEAD:refs/heads/main`,
              `git -c core.hooksPath=/dev/null push -q '${repo}' :refs/heads/feat/reviewed`,
              '{ git rev-parse --absolute-git-dir; ' +
                'echo "config-env=${GIT_CONFIG_COUNT:-none}"; ' +
                'git config --local --get core.hooksPath || echo no-hooks-path; ' +
                'git remote | wc -l | tr -d " "; ' +
                "git for-each-ref --format='%(refname)' refs/heads/ refs/tags/; } > clone.txt",
            ].join('; '),
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

  it.skipIf(confined.skip)(
    confined.title('checks out the named ref and reports it as the base, judged against itself'),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const { outcome, written } = await runWith({ harness: 'edits', base: 'feat/reviewed' });
      expect(outcome.status).toBe('SUCCEEDED');
      const output = written['output'] as Record<string, unknown>;
      expect(output['baseSha']).toBe(feature);
      expect(output['headMoved']).toBe(false);
      expect(String(output['patch'])).toContain('touched.txt');
      // Stored whole under its own kind, whatever its size; a small one is also
      // inline in full.
      expect(output['patchRef']).toBe('inline:patch');
      expect(written['patch']).toBe(output['patch']);
      expect(output['patchTruncated']).toBe(false);
    },
  );

  it.skipIf(confined.skip)(
    confined.title(
      'judges whether the diff applies against the base, not the folder it moved away from',
    ),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      // The folder's README has moved on from the base's, so the same edit reads
      // as a conflict against it and applies cleanly where it would be published.
      const { outcome, written } = await runWith({ harness: 'rewrites', base: 'feat/reviewed' });
      expect(outcome.status).toBe('SUCCEEDED');
      const output = written['output'] as Record<string, unknown>;
      expect(String(output['patch'])).toContain('README.md');
      expect(output['applies']).toBe('clean');
      expect(output['applyConflict']).toBeUndefined();
    },
  );

  it.skipIf(confined.skip)(
    confined.title(
      'judges a continued turn that names no base against the base its session started from',
    ),
    { tags: ['listener'], timeout: 120_000 },
    async () => {
      const first = await runWith({ harness: 'converses', base: 'feat/reviewed' });
      expect(first.outcome.status).toBe('SUCCEEDED');
      const sessionRef = (first.written['output'] as Record<string, unknown>)['sessionRef'];
      expect(sessionRef).toEqual(expect.any(String));

      const { outcome, written } = await runWith({
        harness: 'converses',
        continueFrom: sessionRef,
      });
      expect(outcome.status).toBe('SUCCEEDED');
      const output = written['output'] as Record<string, unknown>;
      expect(output['continued']).toBe(true);
      expect(output['baseSha']).toBe(feature);
      expect(String(output['patch'])).toContain('README.md');
      expect(output['applies']).toBe('clean');
      expect(output['headMoved']).toBe(false);
    },
  );

  it('refuses a ref the folder does not have, naming it', async () => {
    const { outcome, written } = await runWith({ harness: 'edits', base: 'no-such-branch' });
    expect(outcome.status).toBe('FAILED');
    const error = written['error'] as { message: string; classification: string };
    expect(error.message).toContain('`no-such-branch`');
    expect(error.classification).toBe('validation');
  }, 120_000);

  it.skipIf(confined.skip)(
    confined.title(
      "leaves every ref of the folder as it was whatever git the run uses, and its publication lands exactly the run's commit",
    ),
    { tags: ['listener'], timeout: 180_000 },
    async () => {
      const before = await folderRefs();
      const { outcome, written } = await runWith({
        harness: 'goes-around',
        base: 'feat/reviewed',
      });
      expect(outcome.status).toBe('SUCCEEDED');
      const output = written['output'] as Record<string, unknown>;
      expect(await folderRefs()).toBe(before);
      expect(await vcs('rev-parse', 'other')).toBe(other);
      expect(await vcs('rev-parse', 'feat/reviewed')).toBe(feature);
      expect(output).not.toHaveProperty('refChanges');

      // Where the run's git landed: the clone's git directory beside the
      // checkout in the run's scratch, given no hooks path and no config through
      // the environment, naming no remote — and written by none of it, so its
      // refs are the folder's as the clone copied them.
      const patch = String(output['patch']);
      expect(patch).toContain('+changed');
      const gitDir = /^\+(\/.*)$/m.exec(patch.slice(patch.indexOf('+++ b/clone.txt')))?.[1];
      expect(gitDir).toMatch(/\/git-work$/);
      expect(gitDir).not.toBe(join(repo, '.git'));
      expect(patch).toContain('+config-env=none\n');
      expect(patch).toContain('+no-hooks-path\n');
      expect(patch).toContain('+0\n');
      expect(patch).toContain('+refs/heads/other\n');
      expect(patch).not.toContain('+refs/heads/pushed\n');
      expect(patch).not.toContain('+refs/tags/planted\n');

      const published: Record<string, unknown> = {};
      const publication = await createHostPatchHandler(policyPath).execute({
        operationId: 'host.file.patch',
        spaceId: 'space-test',
        runId: 'run-base',
        job: { inputRef: 'inline:publication' },
        signal: new AbortController().signal,
        log: { error: () => undefined, warn: () => undefined, info: () => undefined },
        readPayload: () =>
          Promise.resolve({
            bindingId: 'hb',
            patch,
            commit: {
              branch: 'aflow/around',
              message: 'What the run changed',
              baseSha: output['baseSha'],
            },
          }),
        emitLiveDelta: () => Promise.resolve(),
        writePayload: (kind: string, data: unknown) => {
          published[kind] = data;
          return Promise.resolve(`inline:${kind}`);
        },
      } as never);
      try {
        expect(publication.status).toBe('SUCCEEDED');
        const commit = (published['output'] as { commit: { sha: string } }).commit;
        expect(await vcs('rev-parse', 'refs/heads/aflow/around')).toBe(commit.sha);
        expect(await vcs('rev-parse', `${commit.sha}^`)).toBe(feature);
        expect(await vcs('show', `${commit.sha}:touched.txt`)).toBe('changed');
        // The one write to the folder's refs is the branch the publication names.
        expect(await folderRefs()).toBe(
          [...before.split('\n'), `refs/heads/aflow/around ${commit.sha}`]
            .sort((a, b) => (a < b ? -1 : 1))
            .join('\n'),
        );
      } finally {
        await vcs('branch', '-D', 'aflow/around').catch(() => undefined);
      }
    },
  );

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

describe.runIf(sandboxReadiness().ready)(
  'a diff past the inline cap reaches a publication whole',
  () => {
    let policyPath: string;
    let repo: string;
    const LINES = 60_000;
    const vcs = async (...args: string[]): Promise<string> =>
      (await promisify(execFile)('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })).stdout;

    beforeAll(async () => {
      const base = await mkdtemp(join(tmpdir(), 'host-harness-large-'));
      repo = join(base, 'project');
      await mkdir(repo, { recursive: true });
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
          harnesses: [
            {
              id: 'large',
              executable: '/bin/sh',
              args: [
                '-c',
                `i=0; while [ $i -lt ${String(LINES)} ]; do ` +
                  'echo "line $i of a change larger than any inline copy of it"; i=$((i+1)); ' +
                  'done > large.txt',
              ],
            },
          ],
        }),
      );
    });

    it.skipIf(confined.skip)(
      confined.title('is stored by the run, read back by the patch, and committed byte for byte'),
      { tags: ['listener'], timeout: 180_000 },
      async () => {
        const store = new Map<string, unknown>();
        const contextFor = (
          operationId: string,
          input: unknown,
          outputs: Record<string, unknown>,
        ) =>
          ({
            operationId,
            spaceId: 'space-test',
            runId: 'run-large',
            job: { inputRef: `gs://test/${operationId}/input.json` },
            signal: new AbortController().signal,
            log: { error: () => undefined, warn: () => undefined, info: () => undefined },
            emitLiveDelta: () => Promise.resolve(),
            readPayload: (ref: string) => {
              if (ref === `gs://test/${operationId}/input.json`) return Promise.resolve(input);
              if (!store.has(ref)) return Promise.reject(new Error(`Payload not found: ${ref}`));
              return Promise.resolve(store.get(ref));
            },
            writePayload: (kind: string, data: unknown) => {
              // The store's own layout: the patch operation reads the kind off it.
              const step = operationId.replaceAll('.', '_');
              const ref = `gs://test/tenants/t_1/runs/run-large/steps/${step}/attempt/1/${kind}.json`;
              store.set(ref, data);
              outputs[kind] = data;
              return Promise.resolve(ref);
            },
          }) as never;

        const ran: Record<string, unknown> = {};
        const run = await createHostHarnessHandler(policyPath).execute(
          contextFor(
            'host.harness.run',
            { bindingId: 'hb', harness: 'large', task: 'Write it.', timeoutMs: 120_000 },
            ran,
          ),
        );
        expect(run.status).toBe('SUCCEEDED');
        const output = HostHarnessRunOutputSchema.parse(ran['output']);
        const stored = store.get(output.patchRef ?? '');
        expect(typeof stored).toBe('string');
        expect(Buffer.byteLength(String(stored), 'utf8')).toBeGreaterThan(INLINE_DIFF_CAP_BYTES);
        // The inline copy is the cap's worth of the start, and says so.
        expect(output.patchTruncated).toBe(true);
        expect(Buffer.byteLength(output.patch ?? '', 'utf8')).toBe(INLINE_DIFF_CAP_BYTES);
        expect(String(stored).startsWith(output.patch ?? '')).toBe(true);
        expect(output.applies).toBe('clean');

        const published: Record<string, unknown> = {};
        const commit = await createHostPatchHandler(policyPath).execute(
          contextFor(
            'host.file.patch',
            {
              bindingId: 'hb',
              patchRef: output.patchRef,
              commit: {
                branch: 'aflow/large',
                message: 'The large change',
                baseSha: output.baseSha,
              },
            },
            published,
          ),
        );
        expect(commit.status).toBe('SUCCEEDED');
        expect((published['output'] as Record<string, unknown>)['state']).toBe('applied');
        const expected = Array.from(
          { length: LINES },
          (_, i) => `line ${String(i)} of a change larger than any inline copy of it\n`,
        ).join('');
        expect(await vcs('show', 'aflow/large:large.txt')).toBe(expected);
      },
    );
  },
);
