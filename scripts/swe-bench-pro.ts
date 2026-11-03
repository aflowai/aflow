/**
 * Plan 341 P1 — the SWE-bench Pro harness runner and evaluation writer, as a
 * command line.
 *
 *   yarn bench:swe-pro designate --tenant <tenantId> --space <spaceId>
 *   yarn bench:swe-pro materialize --task <task.json> --work-root <dir> [--repo-url <url>]
 *   yarn bench:swe-pro attempt --task <task.json> --work-root <dir> --harness <dir>
 *       [--agent-timeout-min <n>] [--repo-url <url>]
 *       [--tenant <tenantId> --space <spaceId>] [-- <agent command>...]
 *   yarn bench:swe-pro grade --task <task.json> --folder <dir> --work-root <dir> --harness <dir>
 *       --arm <bare_harness|loop|loop_with_learning> --agent-outcome <ok|failed|timeout>
 *       --wall-ms <n> [--tokens <n>] [--cost-usd <x>] [--ref <commit>]
 *       [--tenant <tenantId> --space <spaceId> [--run <runId>]]
 *
 * `--task` names one record of the published SWE-bench Pro set as JSON.
 * `--harness` names a checkout of the official harness (scaleapi/SWE-bench_Pro-os).
 *
 * D3 and D5 leave open how the runner is invoked. It is a command line an
 * operator starts, the simplest thing that proves the mechanics. `attempt` is
 * the bare-harness arm whole: it materializes the task, runs the agent command
 * in the folder with the task text on standard input, and grades the patch.
 * `materialize` leaves a folder whose history ends at the base commit. It has
 * no remote and no tag, so no ref in it reaches a later commit or the gold fix.
 * The loop's arms run between `materialize` and `grade`: the folder is bound
 * to the measurement space through the host lane (D5), the loop works it, and
 * `grade` takes the outcome, tokens, cost and wall time its run reported.
 * The loop's review rounds run without a publication (`review-rounds`, Plan
 * 341 P2): they commit each round on a local branch. Every stop after a
 * completed commission reports the head to grade as `headSha`, and
 * `stoppedAt.reason` names which head it is. A commission that did not
 * complete may leave nothing to grade. `grade --ref <headSha> --run <its run id>`
 * grades that head and records the attempt on the run that holds the rounds.
 *
 * `designate` marks a space as the measurement space. With `--tenant` and
 * `--space`, an attempt is recorded on a workflow run in that space through
 * the one evaluation writer (D6). `attempt` creates the bare-harness arm's
 * run itself. `grade` records on the loop's run named by `--run`, or creates
 * a bare-harness run where none is named. The space and any named run are
 * confirmed before the attempt starts. Nothing here defaults a space, tenant
 * or folder, so the measurement space names its own.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertBenchmarkRun,
  assertMeasurementSpace,
  benchmarkVerdict,
  createBareHarnessRun,
  designateMeasurementSpace,
  writeBenchmarkAttemptEvaluation,
} from '@aflow/cybernetic-runtime';
import { closeConnection, getDatabase } from '@aflow/database';
import { BenchmarkArmSchema, BenchmarkAttemptResultSchema } from '@aflow/schemas';
import type { BenchmarkArm, BenchmarkAttemptResult } from '@aflow/schemas';

import {
  createCommandAgent,
  gradeAttempt,
  materializeTask,
  parseAgentOutcome,
  parseTask,
  runAttempt,
} from './swe-bench-pro.mjs';

/**
 * The bare harness of D2 arm (a) when no command is named after `--`. Edits
 * are accepted without asking, and any other tool still asks, so a bare run
 * on the operator's machine reaches no further than the folder by default.
 */
const DEFAULT_AGENT = [
  'claude',
  '-p',
  '--output-format',
  'json',
  '--permission-mode',
  'acceptEdits',
];
const DEFAULT_AGENT_TIMEOUT_MIN = 60;

function fail(message: string): never {
  console.error(
    `${message}\n\nThe commands and their flags are at the head of scripts/swe-bench-pro.ts.`,
  );
  process.exit(1);
}

const separator = process.argv.indexOf('--');
const argv = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const agentArgv = separator === -1 ? [] : process.argv.slice(separator + 1);
const command = argv[0];

function flag(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) fail(`--${name} takes a value.`);
  return value;
}

function required(name: string): string {
  return flag(name) ?? fail(`${command ?? 'This command'} needs --${name}.`);
}

function count(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} takes a number of zero or more.`);
  return value;
}

function optionalRound(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value);
}

function readTask(): ReturnType<typeof parseTask> {
  const path = required('task');
  try {
    return parseTask(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (error) {
    fail(`${path} is not a task: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RecordTarget {
  tenantId: string;
  spaceId: string;
  /** The loop's run to record on. Absent, the runner creates a bare-harness run. */
  runId?: string;
}

/**
 * Where the attempt is recorded, confirmed before any work starts. A run the
 * operator names must be a benchmark run in the measurement space. A run the
 * runner creates needs that space to be the measurement space.
 */
async function recordTarget(arm: BenchmarkArm): Promise<RecordTarget | undefined> {
  const tenantId = flag('tenant');
  const spaceId = flag('space');
  const runId = flag('run');
  if (tenantId === undefined && spaceId === undefined && runId === undefined) return undefined;
  if (tenantId === undefined || spaceId === undefined) {
    fail('Recording an attempt needs both --tenant and --space.');
  }
  if (command === 'attempt' && runId !== undefined) {
    fail('`attempt` creates the run it records on, so it takes no --run.');
  }
  if (runId === undefined && arm !== 'bare_harness') {
    fail(`Recording a ${arm} attempt needs --run, the loop's run that worked the folder.`);
  }
  const db = getDatabase();
  if (runId === undefined) {
    await assertMeasurementSpace(db, tenantId, { spaceId });
    return { tenantId, spaceId };
  }
  await assertBenchmarkRun(db, tenantId, {
    runId,
    spaceId,
    instanceId: readTask().instanceId,
    arm,
  });
  return { tenantId, spaceId, runId };
}

async function report(
  attempt: BenchmarkAttemptResult,
  gradeDir: string,
  target: RecordTarget | undefined,
  span: { startedAt: Date; completedAt: Date },
): Promise<void> {
  const parsed = BenchmarkAttemptResultSchema.parse(attempt);
  writeFileSync(join(gradeDir, 'attempt.json'), `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(JSON.stringify(parsed, null, 2));
  if (target === undefined) return;
  const db = getDatabase();
  const runId =
    target.runId ??
    (
      await createBareHarnessRun(db, target.tenantId, {
        spaceId: target.spaceId,
        attempt: parsed,
        ...span,
      })
    ).runId;
  const { written, storedBenchmark } = await writeBenchmarkAttemptEvaluation(db, target.tenantId, {
    runId,
    spaceId: target.spaceId,
    attempt: parsed,
  });
  if (written) {
    console.error(`Recorded on run ${runId}.`);
    return;
  }
  const stored = storedBenchmark === undefined ? 'a verdict' : benchmarkVerdict(storedBenchmark);
  console.error(
    `The new verdict ${benchmarkVerdict(parsed)} was not stored. Run ${runId} already holds ${stored} from harness revision ${parsed.harnessRevision}, and that verdict is final.`,
  );
  if (storedBenchmark !== undefined) {
    console.error(`The stored attempt:\n${JSON.stringify(storedBenchmark, null, 2)}`);
  }
}

async function main(): Promise<void> {
  if (command === 'designate') {
    const tenantId = required('tenant');
    const spaceId = required('space');
    await designateMeasurementSpace(getDatabase(), tenantId, { spaceId });
    console.error(`Space ${spaceId} is the measurement space for SWE-bench Pro.`);
    return;
  }

  if (command === 'materialize') {
    const task = readTask();
    const repoUrl = flag('repo-url');
    const folder = await materializeTask(task, {
      workRoot: required('work-root'),
      ...(repoUrl === undefined ? {} : { repoUrl }),
    });
    console.log(folder);
    return;
  }

  if (command === 'attempt') {
    const task = readTask();
    const workRoot = required('work-root');
    const harnessDir = resolve(required('harness'));
    if (flag('arm') !== undefined) {
      fail('`attempt` runs the bare-harness arm only. Grade a loop arm with `grade`.');
    }
    const arm: BenchmarkArm = 'bare_harness';
    const target = await recordTarget(arm);
    const timeoutMin = count('agent-timeout-min') ?? DEFAULT_AGENT_TIMEOUT_MIN;
    const repoUrl = flag('repo-url');
    const runAgent = createCommandAgent(agentArgv.length > 0 ? agentArgv : DEFAULT_AGENT, {
      timeoutMs: timeoutMin * 60_000,
    });
    const startedAt = new Date();
    const result = await runAttempt(task, {
      arm,
      workRoot,
      harnessDir,
      runAgent,
      ...(repoUrl === undefined ? {} : { repoUrl }),
    });
    const completedAt = new Date();
    const gradeDir = join(resolve(workRoot), `${task.instanceId}.grade`);
    mkdirSync(gradeDir, { recursive: true });
    await report(result.attempt as BenchmarkAttemptResult, gradeDir, target, {
      startedAt,
      completedAt,
    });
    return;
  }

  if (command === 'grade') {
    const task = readTask();
    const workRoot = resolve(required('work-root'));
    const arm = BenchmarkArmSchema.parse(required('arm'));
    let outcome: ReturnType<typeof parseAgentOutcome>;
    try {
      outcome = parseAgentOutcome(required('agent-outcome'));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const wallTimeMs = Math.round(count('wall-ms') ?? fail('grade needs --wall-ms.'));
    const target = await recordTarget(arm);
    const gradeDir = join(workRoot, `${task.instanceId}.grade`);
    const ref = flag('ref');
    const result = await gradeAttempt(task, {
      arm,
      ...(ref === undefined ? {} : { ref }),
      folder: resolve(required('folder')),
      harnessDir: resolve(required('harness')),
      gradeDir,
      agent: {
        ...outcome,
        tokens: optionalRound(count('tokens')),
        costUsd: count('cost-usd') ?? null,
        wallTimeMs,
      },
    });
    const completedAt = new Date();
    await report(result.attempt as BenchmarkAttemptResult, gradeDir, target, {
      startedAt: new Date(completedAt.getTime() - wallTimeMs),
      completedAt,
    });
    return;
  }

  fail(command === undefined ? 'Name a command.' : `There is no command \`${command}\`.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnection());
