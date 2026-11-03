/**
 * Plan 341 P1 — the SWE-bench Pro harness runner.
 *
 * One task attempt is four steps: materialize the task's repository at its
 * base commit as a folder a coding agent can work, let an agent work it,
 * capture the agent's patch against the base commit, and run the official
 * SWE-bench Pro Docker harness on that patch to read the hidden-test verdict.
 * The official harness is the only grader (D2), and no pull request is opened
 * (D5): the patch is the output.
 *
 * Every process goes through an `exec` the caller can replace, so the
 * mechanics are tested without Docker. The pure parts live here and the
 * command line that composes them with the evaluation writer is
 * `swe-bench-pro.ts`, as `loop-decision-set.mjs` and its command line do.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The Docker Hub account the official harness publishes task images under. */
export const DEFAULT_DOCKERHUB_USERNAME = 'jefzda';
export const IMAGE_REPOSITORY = 'sweap-images';

/**
 * What a run leaves in a folder that is not the agent's change: the host
 * lane's run scratch (`RUN_SCRATCH_DIR` in the host executor's worktree).
 */
export const SCRATCH_PATHSPECS = [':(exclude).aflow'];

/** A step that ended the attempt, with the failure class it records. */
export class AttemptStepError extends Error {
  /** @param {string} failureClass @param {string} message */
  constructor(failureClass, message) {
    super(message);
    this.failureClass = failureClass;
  }
}

/**
 * Run one command. A non-zero exit, a timeout and a missing executable all
 * resolve, so the caller classifies them rather than catching them.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, input?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** The last lines of a process's output, for a failure's detail. */
function tail(text, lines = 20) {
  return text.trim().split('\n').slice(-lines).join('\n').slice(-4000);
}

const INSTANCE_ID = /^[\w.-]+$/;

/** A full SHA-1 commit id. A folder is initialised as a SHA-1 repository, so it holds no other kind. */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/**
 * One task as the published SWE-bench Pro set holds it. The raw record is
 * kept whole, because the official harness reads its own fields from it.
 *
 * @param {unknown} raw
 */
export function parseTask(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('A task is a JSON object.');
  const record = /** @type {Record<string, unknown>} */ (raw);
  const field = (name) => {
    const value = record[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`The task has no \`${name}\`, which the runner needs.`);
    }
    return value;
  };
  const instanceId = field('instance_id');
  if (!INSTANCE_ID.test(instanceId)) {
    throw new Error(`The instance id \`${instanceId}\` cannot name a folder.`);
  }
  // The base commit reaches git as an argument in every step that reads it. Only a full commit
  // id passes, so no record can hand git an option such as `--upload-pack=`.
  const baseCommit = field('base_commit');
  if (!COMMIT_ID.test(baseCommit)) {
    throw new Error(`The base commit ${JSON.stringify(baseCommit)} is not a full commit id.`);
  }
  return {
    instanceId,
    repo: field('repo'),
    baseCommit,
    problemStatement: field('problem_statement'),
    dockerhubTag: field('dockerhub_tag'),
    requirements: typeof record['requirements'] === 'string' ? record['requirements'] : undefined,
    interface: typeof record['interface'] === 'string' ? record['interface'] : undefined,
    raw: record,
  };
}

/**
 * The text every arm is given (D2): the problem statement, with the
 * requirements and interface the set publishes beside it.
 */
export function taskText(task) {
  const parts = [task.problemStatement.trim()];
  if (task.requirements?.trim()) parts.push(`Requirements:\n${task.requirements.trim()}`);
  if (task.interface?.trim()) parts.push(`Interface:\n${task.interface.trim()}`);
  return parts.join('\n\n');
}

/** The task's folder under a work root. One folder per task attempt. */
export function taskFolder(workRoot, task) {
  return join(resolve(workRoot), task.instanceId);
}

/**
 * Fetch the task's repository up to its base commit and detach it there (D3).
 *
 * D5 leaves open how the repository reaches the machine. This takes the
 * simplest road: the repository on GitHub, or `repoUrl` when the caller
 * names a mirror or a fixture. The folder is new on every attempt, so no
 * attempt reads another's work.
 *
 * The folder holds the base commit and its ancestors only. A clone would
 * carry the default branch and the tags, and with them the commits after the
 * base, the gold fix among them. So the folder is a new repository that
 * fetches the base commit by its id, with no tags and no remote. No ref in it
 * reaches past the base, and no later object is in it. Protocol v2 is named
 * because a server takes a request for an unadvertised commit only over v2.
 */
export async function materializeTask(task, { workRoot, repoUrl, exec = runCommand }) {
  const folder = taskFolder(workRoot, task);
  if (
    await stat(folder).then(
      () => true,
      () => false,
    )
  ) {
    throw new AttemptStepError(
      'materialize_failed',
      `${folder} exists already. Each attempt works a fresh folder, so name another work root.`,
    );
  }
  await mkdir(resolve(workRoot), { recursive: true });
  const source = repoUrl ?? `https://github.com/${task.repo}.git`;
  // A failed step leaves no folder behind, so the attempt can run again.
  const failed = async (message) => {
    await rm(folder, { recursive: true, force: true });
    return new AttemptStepError('materialize_failed', message);
  };
  const init = await exec('git', ['init', '--quiet', folder]);
  if (init.code !== 0) throw await failed(`git init ${folder} failed.\n${tail(init.stderr)}`);
  // `--git-dir` keeps the process's own directory, so a relative `repoUrl` names what it named.
  const fetch = await exec('git', [
    `--git-dir=${join(folder, '.git')}`,
    '-c',
    'protocol.version=2',
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--',
    source,
    task.baseCommit,
  ]);
  if (fetch.code !== 0) {
    throw await failed(
      `The base commit ${task.baseCommit} does not fetch from ${source}.\n${tail(fetch.stderr)}`,
    );
  }
  const checkout = await exec('git', ['checkout', '--quiet', '--detach', task.baseCommit], {
    cwd: folder,
  });
  if (checkout.code !== 0) {
    throw await failed(
      `The base commit ${task.baseCommit} does not check out.\n${tail(checkout.stderr)}`,
    );
  }
  return folder;
}

/**
 * The agent's patch against the base commit: committed and uncommitted
 * changes, new files included, the run's scratch left out.
 *
 * It stages into an index of its own, so the folder's index is as the agent
 * left it — the loop's review may still read it.
 *
 * With `ref`, the patch is the diff from the base commit to that commit
 * instead. The loop's review rounds (the `review-rounds` skill) commit each
 * round on a local branch and leave the working tree as it was, so their
 * final patch is `<base>..<headSha>` and the working tree holds none of it.
 */
export async function capturePatch(folder, baseCommit, { exec = runCommand, ref } = {}) {
  // In `git diff` the `--` opens the pathspecs, so `--end-of-options` is what ends the options.
  if (ref !== undefined) {
    const diff = await exec(
      'git',
      [
        'diff',
        '--binary',
        '--no-color',
        '--end-of-options',
        baseCommit,
        ref,
        '--',
        '.',
        ...SCRATCH_PATHSPECS,
      ],
      { cwd: folder },
    );
    if (diff.code !== 0) throw new Error(`git diff ${ref} failed.\n${tail(diff.stderr)}`);
    return diff.stdout;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'swe-bench-pro-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const steps = [
      ['read-tree', '--', baseCommit],
      ['add', '--all', '--', '.', ...SCRATCH_PATHSPECS],
    ];
    for (const args of steps) {
      const result = await exec('git', args, { cwd: folder, env });
      if (result.code !== 0) throw new Error(`git ${args[0]} failed.\n${tail(result.stderr)}`);
    }
    const diff = await exec(
      'git',
      [
        'diff',
        '--cached',
        '--binary',
        '--no-color',
        '--end-of-options',
        baseCommit,
        '--',
        '.',
        ...SCRATCH_PATHSPECS,
      ],
      { cwd: folder, env },
    );
    if (diff.code !== 0) throw new Error(`git diff failed.\n${tail(diff.stderr)}`);
    return diff.stdout;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The agent the bare-harness arm runs (D2 arm a): a command started in the
 * folder with the task text on its standard input. Its tokens and cost are
 * read from a Claude Code style JSON result (`--output-format json`). Any
 * other output leaves them null rather than guessed.
 */
export function createCommandAgent(argv, { exec = runCommand, timeoutMs } = {}) {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error('The agent command is empty.');
  return async (folder, prompt) => {
    const result = await exec(command, args, { cwd: folder, input: prompt, timeoutMs });
    const usage = readAgentUsage(result.stdout);
    return {
      ok: result.code === 0 && !result.timedOut && !usage.isError,
      timedOut: result.timedOut,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      ...(result.code === 0 ? {} : { detail: tail(result.stderr || result.stdout) }),
    };
  };
}

/** Tokens are every usage counter the result reports, cache reads included. */
export function readAgentUsage(stdout) {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  let event;
  try {
    event = JSON.parse(last);
  } catch {
    return { tokens: null, costUsd: null, isError: false };
  }
  const usage = typeof event?.usage === 'object' && event.usage !== null ? event.usage : {};
  const counters = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ].map((key) => usage[key]);
  const counted = counters.filter((value) => typeof value === 'number');
  return {
    tokens: counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0),
    costUsd: typeof event?.total_cost_usd === 'number' ? event.total_cost_usd : null,
    isError: event?.is_error === true,
  };
}

/** The image the official harness runs a task's hidden tests in. */
export function taskImage(task, dockerhubUsername = DEFAULT_DOCKERHUB_USERNAME) {
  return `${dockerhubUsername}/${IMAGE_REPOSITORY}:${task.dockerhubTag}`;
}

/**
 * The official harness's command line, as its README gives it for a local
 * Docker run (`swe_bench_pro_eval.py`, one worker).
 */
export function harnessArgv({ samplePath, patchPath, outputDir, dockerhubUsername }) {
  return [
    'swe_bench_pro_eval.py',
    `--raw_sample_path=${samplePath}`,
    `--patch_path=${patchPath}`,
    `--output_dir=${outputDir}`,
    '--scripts_dir=run_scripts',
    '--num_workers=1',
    `--dockerhub_username=${dockerhubUsername}`,
    '--use_local_docker',
  ];
}

/** The revision of the harness checkout a verdict came from. */
export async function harnessRevision(harnessDir, { exec = runCommand } = {}) {
  const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: harnessDir });
  return result.code === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : 'unversioned';
}

/**
 * Grade one patch with the official SWE-bench Pro harness.
 *
 * D5 leaves open how task images are fetched. The runner pulls the image
 * itself before the harness starts, one task at a time on this machine (the
 * pilot's answer to D5's open question), so a missing image is classified
 * apart from a harness that failed.
 *
 * @returns {Promise<{ passed: boolean } | { passed: null, failureClass: string, detail: string }>}
 */
export async function gradePatch(task, patch, options) {
  const {
    harnessDir,
    gradeDir,
    prefix,
    python = 'python3',
    dockerhubUsername = DEFAULT_DOCKERHUB_USERNAME,
    gradeTimeoutMs,
    exec = runCommand,
  } = options;
  const image = taskImage(task, dockerhubUsername);
  const pull = await exec('docker', ['pull', '--quiet', image], { timeoutMs: gradeTimeoutMs });
  if (pull.code !== 0) {
    return {
      passed: null,
      failureClass: 'image_unavailable',
      detail: `docker pull ${image} failed.\n${tail(pull.stderr)}`,
    };
  }

  await mkdir(gradeDir, { recursive: true });
  const samplePath = join(resolve(gradeDir), 'sample.jsonl');
  const patchPath = join(resolve(gradeDir), 'patches.json');
  const outputDir = join(resolve(gradeDir), 'harness-output');
  // An earlier grading in this folder left its own eval_results.json. A
  // harness that writes nothing this time would otherwise hand that one back.
  await rm(outputDir, { recursive: true, force: true });
  await writeFile(samplePath, `${JSON.stringify(task.raw)}\n`);
  await writeFile(
    patchPath,
    `${JSON.stringify([{ instance_id: task.instanceId, patch, prefix }], null, 2)}\n`,
  );

  const run = await exec(
    python,
    harnessArgv({ samplePath, patchPath, outputDir, dockerhubUsername }),
    { cwd: harnessDir, timeoutMs: gradeTimeoutMs },
  );
  if (run.code !== 0) {
    return {
      passed: null,
      failureClass: 'harness_error',
      detail: `The official harness exited ${String(run.code)}${run.timedOut ? ' on its timeout' : ''}.\n${tail(run.stderr || run.stdout)}`,
    };
  }
  const results = await readFile(join(outputDir, 'eval_results.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined);
  const verdict = results?.[task.instanceId];
  if (typeof verdict !== 'boolean') {
    return {
      passed: null,
      failureClass: 'harness_error',
      detail: `The official harness wrote no verdict for ${task.instanceId} in eval_results.json.`,
    };
  }
  return { passed: verdict };
}

/** How the agent that worked a folder ended, as `grade --agent-outcome` names it. */
export const AGENT_OUTCOMES = /** @type {const} */ ({
  ok: { ok: true, timedOut: false },
  failed: { ok: false, timedOut: false },
  timeout: { ok: false, timedOut: true },
});

/**
 * The agent's outcome for an arm the runner did not start. It has no default:
 * a loop run that failed must not grade as an agent that finished.
 *
 * @param {string | undefined} value
 */
export function parseAgentOutcome(value) {
  const allowed = Object.keys(AGENT_OUTCOMES).join(', ');
  if (value === undefined) throw new Error(`The agent's outcome is one of ${allowed}.`);
  if (!Object.hasOwn(AGENT_OUTCOMES, value)) {
    throw new Error(`The agent's outcome is one of ${allowed}, not ${value}.`);
  }
  return AGENT_OUTCOMES[/** @type {keyof typeof AGENT_OUTCOMES} */ (value)];
}

/**
 * The failure class of a graded attempt. A harness that gave no verdict wins,
 * because nothing else about the attempt was measured.
 */
export function classifyAttempt({ grade, agent, patch }) {
  if (grade.passed === null) return grade.failureClass;
  if (grade.passed) return null;
  if (agent.timedOut) return 'agent_timeout';
  if (!agent.ok) return 'agent_failed';
  if (patch.trim() === '') return 'empty_patch';
  return 'tests_failed';
}

/**
 * Capture and grade the patch an agent left in a task folder, and report the
 * attempt as the evaluation writer records it (`BenchmarkAttemptResult`).
 * The arm that worked the folder reports its own tokens, cost and wall time,
 * so the loop's arm grades here as the bare harness's does.
 */
export async function gradeAttempt(task, options) {
  const { arm, folder, harnessDir, gradeDir, agent, ref, exec = runCommand } = options;
  const patch = await capturePatch(folder, task.baseCommit, { exec, ref });
  await mkdir(gradeDir, { recursive: true });
  const patchFile = join(gradeDir, `${task.instanceId}.patch`);
  await writeFile(patchFile, patch);
  const grade = await gradePatch(task, patch, { ...options, prefix: arm, exec });
  const failureClass = classifyAttempt({ grade, agent, patch });
  const detail = grade.passed === null ? grade.detail : agent.detail;
  return {
    attempt: {
      benchmark: 'swe-bench-pro',
      instanceId: task.instanceId,
      arm,
      passed: grade.passed === true,
      failureClass,
      tokens: agent.tokens,
      costUsd: agent.costUsd,
      wallTimeMs: agent.wallTimeMs,
      patchBytes: Buffer.byteLength(patch),
      harnessRevision: await harnessRevision(harnessDir, { exec }),
      ...(detail === undefined ? {} : { detail }),
    },
    patchFile,
  };
}

/**
 * One whole attempt of the bare-harness arm: materialize, let the agent work,
 * grade. Wall time is the agent's work alone, because grading is the
 * instrument's time and not the arm's.
 */
export async function runAttempt(task, options) {
  const { workRoot, runAgent, now = Date.now, exec = runCommand } = options;
  const gradeDir = join(resolve(workRoot), `${task.instanceId}.grade`);
  let folder;
  try {
    folder = await materializeTask(task, { workRoot, repoUrl: options.repoUrl, exec });
  } catch (error) {
    if (!(error instanceof AttemptStepError)) throw error;
    return {
      attempt: {
        benchmark: 'swe-bench-pro',
        instanceId: task.instanceId,
        arm: options.arm,
        passed: false,
        failureClass: error.failureClass,
        tokens: null,
        costUsd: null,
        wallTimeMs: 0,
        patchBytes: 0,
        harnessRevision: await harnessRevision(options.harnessDir, { exec }),
        detail: error.message,
      },
    };
  }
  const started = now();
  const report = await runAgent(folder, taskText(task));
  const agent = { ...report, wallTimeMs: Math.max(0, Math.round(now() - started)) };
  const graded = await gradeAttempt(task, { ...options, folder, gradeDir, agent, exec });
  return { ...graded, folder };
}
