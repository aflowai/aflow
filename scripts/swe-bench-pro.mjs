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
 *
 * A server may still refuse an unadvertised commit, and some SWE-bench Pro
 * base commits are reachable only from a pull-request ref. When the fetch by
 * id is refused, the folder fetches every `refs/pull/<n>/head` instead. Once
 * the base is checked out, it deletes those refs and prunes every object the
 * base does not reach. It then counts what the folder holds, and fails the
 * attempt unless the history ends at the base.
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
  const init = await exec('git', ['init', '--quiet', '--object-format=sha1', folder]);
  if (init.code !== 0) throw await failed(`git init ${folder} failed.\n${tail(init.stderr)}`);
  // `--git-dir` keeps the process's own directory, so a relative `repoUrl` names what it named.
  const fetchFromSource = (refspec) =>
    exec('git', [
      `--git-dir=${join(folder, '.git')}`,
      '-c',
      'protocol.version=2',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--',
      source,
      refspec,
    ]);
  const byId = await fetchFromSource(task.baseCommit);
  const fromPullRequests =
    byId.code === 0 ? undefined : await fetchFromSource(PULL_REQUEST_REFSPEC);
  if (fromPullRequests !== undefined) {
    const held = await exec('git', ['cat-file', '-e', `${task.baseCommit}^{commit}`], {
      cwd: folder,
    });
    if (fromPullRequests.code !== 0 || held.code !== 0) {
      throw await failed(
        [
          `The base commit ${task.baseCommit} does not fetch from ${source}.`,
          `By its id: ${tail(byId.stderr) || 'refused'}`,
          `From the pull-request refs: ${tail(fromPullRequests.stderr) || 'no pull-request ref reaches it'}`,
        ].join('\n'),
      );
    }
  }
  const checkout = await exec('git', ['checkout', '--quiet', '--detach', task.baseCommit], {
    cwd: folder,
  });
  if (checkout.code !== 0) {
    throw await failed(
      `The base commit ${task.baseCommit} does not check out.\n${tail(checkout.stderr)}`,
    );
  }
  if (fromPullRequests !== undefined) {
    const pruned =
      (await prunePastBase(folder, exec)) ??
      (await confirmHistoryEndsAtBase(folder, task.baseCommit, exec));
    if (pruned !== undefined) throw await failed(pruned);
  }
  return folder;
}

/** Where the fallback fetch keeps the pull-request heads until the base is checked out. */
const PULL_REQUEST_NAMESPACE = 'refs/materialize/pull/';
const PULL_REQUEST_REFSPEC = `+refs/pull/*/head:${PULL_REQUEST_NAMESPACE}*`;

/**
 * Delete the fetched pull-request refs and every object only they reached.
 * The gold fix may sit on one of them, so none may stay in the folder.
 *
 * @returns {Promise<string | undefined>} what failed, or nothing
 */
async function prunePastBase(folder, exec) {
  const listed = await exec(
    'git',
    ['for-each-ref', '--format=delete %(refname)', PULL_REQUEST_NAMESPACE],
    { cwd: folder },
  );
  if (listed.code !== 0) return `git for-each-ref failed.\n${tail(listed.stderr)}`;
  const steps = [
    { args: ['update-ref', '--stdin'], input: listed.stdout },
    { args: ['reflog', 'expire', '--expire=now', '--all'] },
    { args: ['gc', '--quiet', '--prune=now'] },
  ];
  for (const { args, input } of steps) {
    const result = await exec('git', args, {
      cwd: folder,
      ...(input === undefined ? {} : { input }),
    });
    if (result.code !== 0) {
      return `git ${args[0]} failed while it pruned the commits past the base.\n${tail(result.stderr)}`;
    }
  }
  return undefined;
}

/**
 * Confirm the prune has cut the history at the base, rather than trust
 * `git gc`. No ref or reflog may reach a commit the base does not reach. The
 * store may hold no object the base does not reach, so its object count must
 * equal the count of objects the base reaches. A duplicate across packs makes
 * the store's count larger, so the comparison fails safe.
 *
 * @returns {Promise<string | undefined>} what failed, or nothing
 */
async function confirmHistoryEndsAtBase(folder, baseCommit, exec) {
  const count = async (args) => {
    const result = await exec('git', args, { cwd: folder });
    const value = Number(result.stdout.trim());
    return result.code === 0 && result.stdout.trim() !== '' && Number.isSafeInteger(value)
      ? value
      : undefined;
  };
  const past = await count(['rev-list', '--count', '--all', '--reflog', '--not', baseCommit]);
  if (past === undefined) return 'git rev-list failed while it counted the commits past the base.';
  if (past !== 0) {
    return `After the prune, the folder's refs still reach ${past} commits past the base ${baseCommit}.`;
  }
  const reached = await count(['rev-list', '--count', '--objects', baseCommit]);
  if (reached === undefined) return 'git rev-list failed while it counted the objects of the base.';
  const listed = await exec('git', ['count-objects', '-v'], { cwd: folder });
  if (listed.code !== 0) return `git count-objects failed.\n${tail(listed.stderr)}`;
  const field = (name) => {
    const match = new RegExp(`^${name}: (\\d+)$`, 'm').exec(listed.stdout);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const loose = field('count');
  const packed = field('in-pack');
  if (loose === undefined || packed === undefined) {
    return `git count-objects printed no object count.\n${tail(listed.stdout)}`;
  }
  const stored = loose + packed;
  if (stored !== reached) {
    return [
      `After the prune, the folder stores ${stored} objects and the base ${baseCommit} reaches ${reached}.`,
      'An object past the base may remain, so the attempt does not use the folder.',
    ].join(' ');
  }
  return undefined;
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

/** The workflow slugs of the loop's runs that hold a patch to grade. */
export const COMMISSION_SLUG = 'commission-change';
export const REVIEW_ROUNDS_SLUG = 'review-rounds';

/** How a unified diff opens: git's own header, or a plain one. */
const UNIFIED_DIFF_START = /^(?:diff --git |--- )/;

/** A run in one of these has stopped, so its output is final. */
const ENDED_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * The loop's patch, read from the run that produced it (Plan 341 P2).
 *
 * The loop leaves the bound folder as it found it. Commission Change works a
 * scratch copy and stores its diff as the harness step's `patchRef`, so a
 * commission run's patch is the payload that ref names. The review rounds
 * commit on a local branch of the folder, so a rounds run's patch is
 * `<base>..<headSha>` there. Either way the run says where the patch is, and
 * no one applies it to the folder first.
 *
 * A run that ended with no patch grades as an empty patch. `readRunPatch`
 * reads the run's output whole first, because an output left out would read
 * here as no patch. A run still going,
 * or one that worked another base, is refused, because its patch is not this
 * attempt's.
 *
 * @param {{ baseCommit: string }} task
 * @param {{ runId: string, slug: string, status: string, output: Record<string, unknown> }} run
 * @param {{ folder?: string, readPatch: (patchRef: string) => Promise<unknown>, exec?: typeof runCommand }} options
 * @returns {Promise<string>}
 */
export async function readLoopPatch(task, run, { folder, readPatch, exec = runCommand }) {
  if (!ENDED_RUN_STATUSES.has(run.status)) {
    throw new Error(`Run ${run.runId} is ${run.status}. Grade it once it has ended.`);
  }
  const text = (name) => {
    const value = run.output[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const baseSha = text('baseSha');
  if (baseSha !== undefined && baseSha !== task.baseCommit) {
    throw new Error(
      `Run ${run.runId} worked from ${baseSha}, not from the task's base commit ${task.baseCommit}.`,
    );
  }
  if (run.slug === COMMISSION_SLUG) {
    const patchRef = text('patchRef');
    if (patchRef === undefined) return '';
    if (baseSha === undefined) {
      throw new Error(`Run ${run.runId} reports a patch but no \`baseSha\` it was taken from.`);
    }
    const patch = await readPatch(patchRef);
    if (typeof patch !== 'string' || !UNIFIED_DIFF_START.test(patch)) {
      throw new Error(`The \`patchRef\` of run ${run.runId} names no diff.`);
    }
    return patch;
  }
  if (run.slug === REVIEW_ROUNDS_SLUG) {
    const headSha = text('headSha');
    if (headSha === undefined) return '';
    // The head reaches git as an argument, so only a full commit id passes.
    if (!COMMIT_ID.test(headSha)) {
      throw new Error(`The \`headSha\` of run ${run.runId} is not a full commit id.`);
    }
    if (folder === undefined) {
      throw new Error(
        `Run ${run.runId} committed its rounds in the task folder. Name that folder with --folder.`,
      );
    }
    return capturePatch(folder, task.baseCommit, { exec, ref: headSha });
  }
  throw new Error(
    `Run ${run.runId} is a ${run.slug} run. A loop arm's patch is on a ${COMMISSION_SLUG} or ${REVIEW_ROUNDS_SLUG} run.`,
  );
}

/**
 * The loop arm's patch, read from the run `--run` names in the measurement
 * space. The run is loaded and its output built as the platform builds it.
 * Its `patchRef` is read from the payload store the services share, so no
 * patch passes through the operator's hands.
 *
 * The platform builds a run's output best-effort: a task output the store
 * cannot read is left out, so a lost `patchRef` would read as no patch. A
 * run grades as an empty patch only once every succeeded task's stored
 * output has been read, and a run with any output unread is refused.
 *
 * The `patchRef` is data on the run, so only an object ref of kind `patch`
 * of this tenant reaches the store. Each platform call is passed in, so the
 * command line supplies the platform's own and the tests supply stand-ins.
 *
 * @template {{
 *   runId: string,
 *   workflowSlug: string,
 *   status: string,
 *   tasks: ReadonlyArray<{ taskId: string, status: string, outputRef: string | null }>,
 * }} Run
 * @param {{ baseCommit: string }} task
 * @param {{ tenantId: string, spaceId: string, runId: string }} target
 * @param {{
 *   folder?: string,
 *   loadRun: (runId: string) => Promise<Run | null>,
 *   buildResult: (run: Run) => Promise<{ output?: Record<string, unknown> | null } | undefined>,
 *   retrieve: (patchRef: string) => Promise<unknown>,
 *   parsePayloadRef: (ref: string) => { form: string, payloadKind?: string, tenantId?: string } | null,
 *   exec?: typeof runCommand,
 * }} options
 * @returns {Promise<string>}
 */
export async function readRunPatch(
  task,
  target,
  { folder, loadRun, buildResult, retrieve, parsePayloadRef, exec = runCommand },
) {
  const run = await loadRun(target.runId);
  if (run === null) throw new Error(`Run ${target.runId} is not in space ${target.spaceId}.`);
  await readEveryTaskOutput(run, retrieve);
  const result = await buildResult(run);
  if (result === undefined) {
    throw new Error(`The output of run ${target.runId} cannot be read, so its patch is unknown.`);
  }
  return readLoopPatch(
    task,
    { runId: run.runId, slug: run.workflowSlug, status: run.status, output: result.output ?? {} },
    {
      ...(folder === undefined ? {} : { folder }),
      exec,
      readPatch: async (patchRef) => {
        const parsed = parsePayloadRef(patchRef);
        if (
          parsed?.form !== 'object' ||
          parsed.payloadKind !== 'patch' ||
          parsed.tenantId !== target.tenantId
        ) {
          throw new Error(`The \`patchRef\` of run ${target.runId} names no diff of this tenant.`);
        }
        try {
          return await retrieve(patchRef);
        } catch (error) {
          throw new Error(
            `The patch of run ${target.runId} cannot be read. Stored diffs expire, and this one may be gone. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    },
  );
}

/**
 * Read the stored output of each succeeded task of a run, and refuse the run
 * if any of them cannot be read. The output build reads them again, but it
 * leaves out what it cannot read, so only this read says one is missing.
 *
 * @param {{ runId: string, tasks: ReadonlyArray<{ taskId: string, status: string, outputRef: string | null }> }} run
 * @param {(ref: string) => Promise<unknown>} retrieve
 */
async function readEveryTaskOutput(run, retrieve) {
  for (const task of run.tasks) {
    if (task.status !== 'succeeded' || !task.outputRef) continue;
    const unread = `The output of task ${task.taskId} of run ${run.runId} cannot be read, so the run's patch is unknown.`;
    let output;
    try {
      output = await retrieve(task.outputRef);
    } catch (error) {
      throw new Error(`${unread} ${error instanceof Error ? error.message : String(error)}`);
    }
    if (output === null || typeof output !== 'object' || Array.isArray(output)) {
      throw new Error(`${unread} The store holds no output object at its ref.`);
    }
  }
}

/** The operation that runs a coding harness, whose output holds the harness's usage. */
export const HARNESS_OPERATION = 'host.harness.run';
/** The operation that starts a run of its own, whose spend the loop's run includes. */
const START_OPERATION = 'workflow.run.start';

/**
 * The loop's tokens and cost, read from the usage each harness reported on
 * the run's records (Plan 341 D6). Every `host.harness.run` task of the run
 * holds the harness's own report as `usage`, and the sum of them is what the
 * loop spent. The walk follows every run a task of it started, so a rounds
 * run counts its reviews and its fix rounds. A rounds run also counts the
 * commission it took, named by its `commission` input, because arm (b) spends
 * that commission too.
 *
 * A count is null wherever one harness run reported none, or a task that may
 * have run left no output to read. A total that leaves out a run would read
 * as a cheaper loop, so the total is unknown instead, and `unknown` says why.
 * A run that is still going is refused, because its spend is not final.
 *
 * Each platform call is passed in: the run load, the workflow tasks a run
 * ran, the store read and the platform's own read of a started run's id.
 *
 * @template {{
 *   runId: string,
 *   workflowSlug: string,
 *   status: string,
 *   metadata?: unknown,
 *   tasks: ReadonlyArray<{ taskId: string, status: string, outputRef: string | null }>,
 * }} Run
 * @template {{ taskId: string, operation?: string | undefined }} Task
 * @param {{ spaceId: string, runId: string }} target
 * @param {{
 *   loadRun: (runId: string) => Promise<Run | null>,
 *   workflowTasks: (run: Run) => Promise<ReadonlyArray<Task>>,
 *   retrieve: (ref: string) => Promise<unknown>,
 *   startedRunOf: (task: Task, output: unknown) => string | undefined,
 * }} options
 * @returns {Promise<{ tokens: number | null, costUsd: number | null, runIds: string[], unknown: string[] }>}
 */
export async function readRunUsage(target, { loadRun, workflowTasks, retrieve, startedRunOf }) {
  let tokens = 0;
  let costUsd = 0;
  const unknownTokens = [];
  const unknownCost = [];
  const runIds = [];
  const queue = [target.runId];
  const seen = new Set();
  while (queue.length > 0) {
    const runId = /** @type {string} */ (queue.shift());
    if (seen.has(runId)) continue;
    seen.add(runId);
    const run = await loadRun(runId);
    if (run === null) throw new Error(`Run ${runId} is not in space ${target.spaceId}.`);
    if (!ENDED_RUN_STATUSES.has(run.status)) {
      throw new Error(`Run ${runId} is ${run.status}, so what it spent is not final yet.`);
    }
    runIds.push(runId);
    if (run.workflowSlug === REVIEW_ROUNDS_SLUG) {
      const commission = commissionOf(run);
      if (commission === undefined) {
        throw new Error(`Run ${runId} names no \`commission\` input, so its spend is unknown.`);
      }
      queue.push(commission);
    }
    const definitions = new Map((await workflowTasks(run)).map((task) => [task.taskId, task]));
    for (const row of run.tasks) {
      const task = definitions.get(row.taskId);
      const operation = task?.operation;
      if (
        task === undefined ||
        (operation !== HARNESS_OPERATION && operation !== START_OPERATION)
      ) {
        continue;
      }
      // A skipped task and a task blocked behind a failure never ran.
      if (row.status === 'skipped' || row.status === 'blocked') continue;
      const where = `task ${row.taskId} of run ${runId}`;
      if (row.status !== 'succeeded' || !row.outputRef) {
        unknownTokens.push(`${where} ended ${row.status} with no output to read`);
        unknownCost.push(`${where} ended ${row.status} with no output to read`);
        continue;
      }
      const output = await retrieve(row.outputRef);
      if (operation === START_OPERATION) {
        const started = startedRunOf(task, output);
        if (started === undefined) {
          unknownTokens.push(`${where} names no run it started`);
          unknownCost.push(`${where} names no run it started`);
        } else queue.push(started);
        continue;
      }
      const usage = usageOf(output);
      if (usage.tokens === null) unknownTokens.push(`the harness of ${where} reported no tokens`);
      else tokens += usage.tokens;
      if (usage.costUsd === null) unknownCost.push(`the harness of ${where} reported no cost`);
      else costUsd += usage.costUsd;
    }
  }
  return {
    tokens: unknownTokens.length === 0 ? tokens : null,
    // Summed in floating point, so rounded to the micro-dollar a harness reports.
    costUsd: unknownCost.length === 0 ? Math.round(costUsd * 1e6) / 1e6 : null,
    runIds,
    unknown: [...new Set([...unknownTokens, ...unknownCost])],
  };
}

/** @param {{ metadata?: unknown }} run */
function commissionOf(run) {
  const metadata = run.metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const inputs = /** @type {{ parentTaskInputs?: { inputs?: Record<string, unknown> } }} */ (
    metadata
  ).parentTaskInputs?.inputs;
  const commission = inputs?.['commission'];
  return typeof commission === 'string' && commission !== '' ? commission : undefined;
}

/**
 * The `usage` a harness task's output holds, as `host.harness.run` reports it.
 * @param {unknown} output
 * @returns {{ tokens: number | null, costUsd: number | null }}
 */
function usageOf(output) {
  const usage =
    output !== null && typeof output === 'object' && !Array.isArray(output)
      ? /** @type {Record<string, unknown>} */ (output)['usage']
      : undefined;
  if (usage === null || typeof usage !== 'object') return { tokens: null, costUsd: null };
  const count = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const record = /** @type {Record<string, unknown>} */ (usage);
  const tokens = count(record['tokens']);
  return {
    tokens: tokens !== null && Number.isInteger(tokens) ? tokens : null,
    costUsd: count(record['costUsd']),
  };
}

/**
 * Grade an attempt's patch and report the attempt as the evaluation writer
 * records it (`BenchmarkAttemptResult`). With `patch`, that patch is graded,
 * as a loop arm's run reported it (`readLoopPatch`). Without it, the patch is
 * captured from the agent's changes in `folder`, as the bare harness left
 * them. The caller passes the agent's tokens, cost and wall time. The bare
 * harness's come from its JSON result (`readAgentUsage`). A loop arm's come
 * from the usage its harnesses reported on its runs (`readRunUsage`).
 */
export async function gradeAttempt(task, options) {
  const { arm, folder, harnessDir, gradeDir, agent, exec = runCommand } = options;
  // A task record may reach here unparsed, so git reads no base commit that is not a full id.
  if (!COMMIT_ID.test(task.baseCommit)) {
    throw new Error(`The base commit ${JSON.stringify(task.baseCommit)} is not a full commit id.`);
  }
  const patch = options.patch ?? (await capturePatch(folder, task.baseCommit, { exec }));
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
