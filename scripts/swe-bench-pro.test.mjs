/**
 * Plan 341 P1 — the harness runner's mechanics: a fixture task materializes
 * at its base commit, the agent's patch is captured against that commit and
 * applies there, and the official harness is invoked on it with Docker
 * stubbed, its verdict read and its failures classified.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyAttempt,
  capturePatch,
  createCommandAgent,
  gradeAttempt,
  gradePatch,
  materializeTask,
  parseAgentOutcome,
  parseTask,
  readAgentUsage,
  runAttempt,
  runCommand,
  taskText,
} from './swe-bench-pro.mjs';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
}

/** `runCommand` with the fixture's git identity, so a commit in a test needs no global config. */
const exec = (command, args, options = {}) =>
  runCommand(command, args, { ...options, env: { ...GIT_ENV, ...options.env } });

let scratch;
let upstream;
let baseCommit;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'swe-bench-pro-test-'));
  upstream = join(scratch, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(upstream, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  writeFileSync(join(upstream, 'obsolete.py'), 'print("old")\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '--quiet', '-m', 'base');
  baseCommit = git(upstream, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(upstream, 'later.py'), 'print("after the base")\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '--quiet', '-m', 'after the base');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixtureTask(over = {}) {
  return parseTask({
    instance_id: 'instance_fixture__calc-0001',
    repo: 'fixture/calc',
    base_commit: baseCommit,
    problem_statement: 'add() subtracts.',
    requirements: 'add(a, b) returns a + b.',
    dockerhub_tag: 'fixture.calc-0001',
    fail_to_pass: '["test_calc.py::test_add"]',
    ...over,
  });
}

describe('the fixture task', () => {
  it('reads the fields the runner needs and keeps the raw record for the harness', () => {
    const task = fixtureTask();
    expect(task).toMatchObject({ instanceId: 'instance_fixture__calc-0001', baseCommit });
    expect(task.raw['fail_to_pass']).toBe('["test_calc.py::test_add"]');
    expect(taskText(task)).toBe('add() subtracts.\n\nRequirements:\nadd(a, b) returns a + b.');
  });

  it('refuses a task without its image tag', () => {
    expect(() => fixtureTask({ dockerhub_tag: undefined })).toThrow(/dockerhub_tag/);
  });

  it('materializes as a folder detached at the base commit, not at the branch tip', async () => {
    const folder = await materializeTask(fixtureTask(), {
      workRoot: join(scratch, 'work'),
      repoUrl: upstream,
      exec,
    });
    expect(git(folder, 'rev-parse', 'HEAD').trim()).toBe(baseCommit);
    expect(() => readFileSync(join(folder, 'later.py'))).toThrow();
  });

  it('refuses to reuse a folder an earlier attempt worked', async () => {
    const options = { workRoot: join(scratch, 'work'), repoUrl: upstream, exec };
    await materializeTask(fixtureTask(), options);
    await expect(materializeTask(fixtureTask(), options)).rejects.toMatchObject({
      failureClass: 'materialize_failed',
    });
  });
});

describe('patch capture', () => {
  it('captures committed, uncommitted, new and deleted changes against the base, without the run scratch', async () => {
    const task = fixtureTask();
    const folder = await materializeTask(task, {
      workRoot: join(scratch, 'work'),
      repoUrl: upstream,
      exec,
    });
    writeFileSync(join(folder, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git(folder, 'commit', '--quiet', '-am', 'the agent commits');
    writeFileSync(join(folder, 'test_calc.py'), 'from calc import add\n');
    unlinkSync(join(folder, 'obsolete.py'));
    mkdirSync(join(folder, '.aflow'));
    writeFileSync(join(folder, '.aflow', 'result.json'), '{}\n');

    const patch = await capturePatch(folder, task.baseCommit, { exec });

    expect(patch).toContain('+    return a + b');
    expect(patch).toContain('+++ b/test_calc.py');
    expect(patch).toContain('deleted file mode');
    expect(patch).not.toContain('.aflow');
    expect(git(folder, 'status', '--porcelain')).toContain('?? test_calc.py');

    const fresh = join(scratch, 'fresh');
    git(scratch, 'clone', '--quiet', upstream, fresh);
    git(fresh, 'checkout', '--quiet', '--detach', baseCommit);
    writeFileSync(join(scratch, 'agent.patch'), patch);
    expect(() => git(fresh, 'apply', '--check', join(scratch, 'agent.patch'))).not.toThrow();
  });

  it('captures an empty patch when the agent changed nothing', async () => {
    const task = fixtureTask();
    const folder = await materializeTask(task, {
      workRoot: join(scratch, 'work'),
      repoUrl: upstream,
      exec,
    });
    expect(await capturePatch(folder, task.baseCommit, { exec })).toBe('');
  });

  it("captures the review rounds' head from a local branch in a folder with no remote, where the working tree holds none of it", async () => {
    const task = fixtureTask();
    const folder = await materializeTask(task, {
      workRoot: join(scratch, 'work'),
      repoUrl: upstream,
      exec,
    });
    git(folder, 'remote', 'remove', 'origin');
    expect(git(folder, 'remote').trim()).toBe('');
    // As the rounds commit: on a branch nothing has checked out, round by round.
    git(folder, 'switch', '--quiet', '-c', 'bench/calc-0001');
    writeFileSync(join(folder, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git(folder, 'commit', '--quiet', '-am', 'Make add() add');
    writeFileSync(join(folder, 'test_calc.py'), 'from calc import add\n');
    git(folder, 'add', 'test_calc.py');
    git(folder, 'commit', '--quiet', '-m', 'Fix what review round 1 found');
    const head = git(folder, 'rev-parse', 'HEAD').trim();
    git(folder, 'checkout', '--quiet', '--detach', baseCommit);

    expect(await capturePatch(folder, task.baseCommit, { exec })).toBe('');
    const patch = await capturePatch(folder, task.baseCommit, { exec, ref: head });
    expect(patch).toContain('+    return a + b');
    expect(patch).toContain('+++ b/test_calc.py');
    expect(patch).not.toContain('later.py');
  });
});

/**
 * A stand-in for Docker and the official harness. `docker` answers as the
 * test says, and the harness writes `eval_results.json` where it was told to.
 */
function stubbedHarness({ pull = 0, harness = 0, verdict = 'pass' }) {
  const calls = [];
  const stub = async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === 'docker') {
      return {
        code: pull,
        stdout: '',
        stderr: pull === 0 ? '' : 'manifest unknown',
        timedOut: false,
      };
    }
    if (command === 'python3') {
      if (harness !== 0) return { code: harness, stdout: '', stderr: 'Traceback', timedOut: false };
      if (verdict === 'unwritten') return { code: 0, stdout: '', stderr: '', timedOut: false };
      const outputDir = args.find((arg) => arg.startsWith('--output_dir=')).slice(13);
      const patches = JSON.parse(
        readFileSync(args.find((arg) => arg.startsWith('--patch_path=')).slice(13), 'utf8'),
      );
      mkdirSync(outputDir, { recursive: true });
      const results = verdict === 'none' ? {} : { [patches[0].instance_id]: verdict === 'pass' };
      writeFileSync(join(outputDir, 'eval_results.json'), JSON.stringify(results));
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    return exec(command, args, options);
  };
  return { calls, stub };
}

describe('the official harness, with Docker stubbed', () => {
  const options = (stub) => ({
    harnessDir: join(scratch, 'harness'),
    gradeDir: join(scratch, 'grade'),
    prefix: 'bare_harness',
    exec: stub,
  });

  beforeEach(() => {
    mkdirSync(join(scratch, 'harness'));
  });

  it('pulls the task image, then runs the harness on the patch with local Docker', async () => {
    const { calls, stub } = stubbedHarness({});
    const task = fixtureTask();
    const grade = await gradePatch(task, 'diff --git a/x b/x\n', options(stub));

    expect(grade).toEqual({ passed: true });
    expect(calls[0]).toMatchObject({
      command: 'docker',
      args: ['pull', '--quiet', 'jefzda/sweap-images:fixture.calc-0001'],
    });
    expect(calls[1]).toMatchObject({ command: 'python3', cwd: join(scratch, 'harness') });
    expect(calls[1].args).toEqual(
      expect.arrayContaining([
        'swe_bench_pro_eval.py',
        '--use_local_docker',
        '--num_workers=1',
        '--dockerhub_username=jefzda',
        '--scripts_dir=run_scripts',
      ]),
    );
    const patches = JSON.parse(readFileSync(join(scratch, 'grade', 'patches.json'), 'utf8'));
    expect(patches).toEqual([
      { instance_id: task.instanceId, patch: 'diff --git a/x b/x\n', prefix: 'bare_harness' },
    ]);
    const sample = JSON.parse(readFileSync(join(scratch, 'grade', 'sample.jsonl'), 'utf8'));
    expect(sample['fail_to_pass']).toBe('["test_calc.py::test_add"]');
  });

  it('reads a hidden-test failure as a verdict', async () => {
    const { stub } = stubbedHarness({ verdict: 'fail' });
    expect(await gradePatch(fixtureTask(), 'p', options(stub))).toEqual({ passed: false });
  });

  it('classifies an image that does not pull apart from the harness, and never runs the harness', async () => {
    const { calls, stub } = stubbedHarness({ pull: 1 });
    const grade = await gradePatch(fixtureTask(), 'p', options(stub));
    expect(grade).toMatchObject({ passed: null, failureClass: 'image_unavailable' });
    expect(calls.map((call) => call.command)).toEqual(['docker']);
  });

  it('classifies a harness that exits non-zero, or names no verdict, as a harness error', async () => {
    const crashed = stubbedHarness({ harness: 2 });
    expect(await gradePatch(fixtureTask(), 'p', options(crashed.stub))).toMatchObject({
      passed: null,
      failureClass: 'harness_error',
    });
    const silent = stubbedHarness({ verdict: 'none' });
    expect(await gradePatch(fixtureTask(), 'p', options(silent.stub))).toMatchObject({
      passed: null,
      failureClass: 'harness_error',
    });
  });

  it('reads no verdict an earlier grading left in the output folder', async () => {
    const earlier = stubbedHarness({});
    expect(await gradePatch(fixtureTask(), 'p', options(earlier.stub))).toEqual({ passed: true });
    const silent = stubbedHarness({ verdict: 'unwritten' });
    expect(await gradePatch(fixtureTask(), 'p', options(silent.stub))).toMatchObject({
      passed: null,
      failureClass: 'harness_error',
    });
  });
});

describe('one attempt end to end, with Docker stubbed', () => {
  it('reports pass, tokens, cost, wall time and no failure class, and keeps the patch', async () => {
    mkdirSync(join(scratch, 'harness'));
    const { stub } = stubbedHarness({});
    let clock = 1_000;
    const result = await runAttempt(fixtureTask(), {
      arm: 'bare_harness',
      workRoot: join(scratch, 'work'),
      repoUrl: upstream,
      harnessDir: join(scratch, 'harness'),
      exec: stub,
      now: () => clock,
      runAgent: async (folder, prompt) => {
        expect(prompt).toContain('add() subtracts.');
        writeFileSync(join(folder, 'calc.py'), 'def add(a, b):\n    return a + b\n');
        clock += 42_000;
        return { ok: true, timedOut: false, tokens: 900, costUsd: 0.05 };
      },
    });

    expect(result.attempt).toEqual({
      benchmark: 'swe-bench-pro',
      instanceId: 'instance_fixture__calc-0001',
      arm: 'bare_harness',
      passed: true,
      failureClass: null,
      tokens: 900,
      costUsd: 0.05,
      wallTimeMs: 42_000,
      patchBytes: Buffer.byteLength(readFileSync(result.patchFile, 'utf8')),
      harnessRevision: 'unversioned',
    });
    expect(readFileSync(result.patchFile, 'utf8')).toContain('+    return a + b');
  });

  it("grades a loop arm's review-rounds head, named by its commit, and hands the harness that patch", async () => {
    mkdirSync(join(scratch, 'harness'));
    const task = fixtureTask();
    const folder = await materializeTask(task, {
      workRoot: join(scratch, 'work'),
      repoUrl: upstream,
      exec,
    });
    git(folder, 'switch', '--quiet', '-c', 'bench/calc-0001');
    writeFileSync(join(folder, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git(folder, 'commit', '--quiet', '-am', 'Make add() add');
    const head = git(folder, 'rev-parse', 'HEAD').trim();
    git(folder, 'checkout', '--quiet', '--detach', baseCommit);
    const { stub } = stubbedHarness({});

    const result = await gradeAttempt(task, {
      arm: 'loop',
      folder,
      ref: head,
      harnessDir: join(scratch, 'harness'),
      gradeDir: join(scratch, 'work', `${task.instanceId}.grade`),
      agent: { ok: true, timedOut: false, tokens: null, costUsd: null, wallTimeMs: 1 },
      exec: stub,
    });

    expect(result.attempt).toMatchObject({ arm: 'loop', passed: true, failureClass: null });
    expect(readFileSync(result.patchFile, 'utf8')).toContain('+    return a + b');
    const sent = JSON.parse(
      readFileSync(join(scratch, 'work', `${task.instanceId}.grade`, 'patches.json'), 'utf8'),
    );
    expect(sent[0]).toMatchObject({ prefix: 'loop' });
    expect(sent[0].patch).toContain('+    return a + b');
  });

  it('records a repository that does not clone as a materialize failure, with no grade', async () => {
    const { calls, stub } = stubbedHarness({});
    const result = await runAttempt(fixtureTask(), {
      arm: 'bare_harness',
      workRoot: join(scratch, 'work'),
      repoUrl: join(scratch, 'missing'),
      harnessDir: scratch,
      exec: stub,
      runAgent: async () => {
        throw new Error('the agent must not run');
      },
    });
    expect(result.attempt).toMatchObject({ passed: false, failureClass: 'materialize_failed' });
    expect(calls.some((call) => call.command === 'docker')).toBe(false);
  });
});

describe('the failure class', () => {
  const agent = { ok: true, timedOut: false };
  it('names why a graded attempt did not pass', () => {
    expect(classifyAttempt({ grade: { passed: true }, agent, patch: 'p' })).toBeNull();
    expect(classifyAttempt({ grade: { passed: false }, agent, patch: 'p' })).toBe('tests_failed');
    expect(classifyAttempt({ grade: { passed: false }, agent, patch: '' })).toBe('empty_patch');
    expect(
      classifyAttempt({
        grade: { passed: false },
        agent: { ok: false, timedOut: false },
        patch: 'p',
      }),
    ).toBe('agent_failed');
    expect(
      classifyAttempt({
        grade: { passed: false },
        agent: { ok: false, timedOut: true },
        patch: 'p',
      }),
    ).toBe('agent_timeout');
    expect(
      classifyAttempt({
        grade: { passed: null, failureClass: 'harness_error' },
        agent: { ok: false, timedOut: true },
        patch: '',
      }),
    ).toBe('harness_error');
  });

  it('carries a loop run that failed or timed out through grading, never as an agent that finished', () => {
    expect(parseAgentOutcome('ok')).toEqual({ ok: true, timedOut: false });
    for (const [value, failureClass] of [
      ['failed', 'agent_failed'],
      ['timeout', 'agent_timeout'],
    ]) {
      const outcome = parseAgentOutcome(value);
      expect(classifyAttempt({ grade: { passed: false }, agent: outcome, patch: '' })).toBe(
        failureClass,
      );
    }
    expect(() => parseAgentOutcome(undefined)).toThrow(/one of ok, failed, timeout/);
    expect(() => parseAgentOutcome('crashed')).toThrow(/one of ok, failed, timeout/);
  });
});

describe('the bare-harness agent', () => {
  it('reads tokens and cost from a JSON result, and null where there is none', () => {
    expect(
      readAgentUsage(
        JSON.stringify({
          type: 'result',
          total_cost_usd: 0.5,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        }),
      ),
    ).toEqual({ tokens: 115, costUsd: 0.5, isError: false });
    expect(readAgentUsage('plain text')).toEqual({ tokens: null, costUsd: null, isError: false });
  });

  it('runs its command in the folder with the task text on standard input', async () => {
    const calls = [];
    const agent = createCommandAgent(['claude', '-p', '--output-format', 'json'], {
      exec: async (command, args, options) => {
        calls.push({ command, args, ...options });
        return {
          code: 0,
          stdout: '{"total_cost_usd":1,"usage":{"input_tokens":3}}',
          stderr: '',
          timedOut: false,
        };
      },
    });
    expect(await agent('/task', 'fix it')).toEqual({
      ok: true,
      timedOut: false,
      tokens: 3,
      costUsd: 1,
    });
    expect(calls).toEqual([
      {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        cwd: '/task',
        input: 'fix it',
        timeoutMs: undefined,
      },
    ]);
  });
});
