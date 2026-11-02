/**
 * Plan 341 P1 — the SWE-bench Pro harness runner and evaluation writer, as a
 * command line.
 *
 *   yarn bench:swe-pro materialize --task <task.json> --work-root <dir> [--repo-url <url>]
 *   yarn bench:swe-pro attempt --task <task.json> --work-root <dir> --harness <dir>
 *       [--arm bare_harness] [--agent-timeout-min <n>] [--repo-url <url>]
 *       [--tenant <tenantId> --run <runId>] [-- <agent command>...]
 *   yarn bench:swe-pro grade --task <task.json> --folder <dir> --work-root <dir> --harness <dir>
 *       --arm <bare_harness|loop|loop_with_learning> --wall-ms <n> [--tokens <n>] [--cost-usd <x>]
 *       [--tenant <tenantId> --run <runId>]
 *
 * `--task` names one record of the published SWE-bench Pro set as JSON.
 * `--harness` names a checkout of the official harness (scaleapi/SWE-bench_Pro-os).
 *
 * D3 and D5 leave open how the runner is invoked. It is a command line an
 * operator starts, the simplest thing that proves the mechanics. `attempt` is
 * the bare-harness arm whole: it materializes the task, runs the agent command
 * in the folder with the task text on standard input, and grades the patch.
 * The loop's arms run between `materialize` and `grade`: the folder is bound
 * to the measurement space through the host lane (D5), the loop works it, and
 * `grade` takes the tokens, cost and wall time its run reported.
 *
 * With `--tenant` and `--run`, the attempt is recorded on that workflow run
 * through the one evaluation writer (D6). Nothing here defaults a space,
 * tenant or folder, so the measurement space names its own.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeBenchmarkAttemptEvaluation } from '@aflow/cybernetic-runtime';
import { closeConnection, getDatabase } from '@aflow/database';
import { BenchmarkArmSchema, BenchmarkAttemptResultSchema } from '@aflow/schemas';
import type { BenchmarkAttemptResult } from '@aflow/schemas';

import {
  createCommandAgent,
  gradeAttempt,
  materializeTask,
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

function recordTarget(): { tenantId: string; runId: string } | undefined {
  const tenantId = flag('tenant');
  const runId = flag('run');
  if (tenantId === undefined && runId === undefined) return undefined;
  if (tenantId === undefined || runId === undefined) {
    fail('Recording an attempt needs both --tenant and --run.');
  }
  return { tenantId, runId };
}

async function report(
  attempt: BenchmarkAttemptResult,
  gradeDir: string,
  target: { tenantId: string; runId: string } | undefined,
): Promise<void> {
  const parsed = BenchmarkAttemptResultSchema.parse(attempt);
  writeFileSync(join(gradeDir, 'attempt.json'), `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(JSON.stringify(parsed, null, 2));
  if (target === undefined) return;
  try {
    const { written } = await writeBenchmarkAttemptEvaluation(getDatabase(), target.tenantId, {
      runId: target.runId,
      attempt: parsed,
    });
    console.error(
      written
        ? `Recorded on run ${target.runId}.`
        : `Run ${target.runId} took no write: it is not in this tenant, or holds this verdict already.`,
    );
  } finally {
    await closeConnection();
  }
}

async function main(): Promise<void> {
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
    const target = recordTarget();
    const arm = BenchmarkArmSchema.parse(flag('arm') ?? 'bare_harness');
    const timeoutMin = count('agent-timeout-min') ?? DEFAULT_AGENT_TIMEOUT_MIN;
    const repoUrl = flag('repo-url');
    const runAgent = createCommandAgent(agentArgv.length > 0 ? agentArgv : DEFAULT_AGENT, {
      timeoutMs: timeoutMin * 60_000,
    });
    const result = await runAttempt(task, {
      arm,
      workRoot,
      harnessDir,
      runAgent,
      ...(repoUrl === undefined ? {} : { repoUrl }),
    });
    const gradeDir = join(resolve(workRoot), `${task.instanceId}.grade`);
    mkdirSync(gradeDir, { recursive: true });
    await report(result.attempt as BenchmarkAttemptResult, gradeDir, target);
    return;
  }

  if (command === 'grade') {
    const task = readTask();
    const workRoot = resolve(required('work-root'));
    const arm = BenchmarkArmSchema.parse(required('arm'));
    const target = recordTarget();
    const gradeDir = join(workRoot, `${task.instanceId}.grade`);
    const result = await gradeAttempt(task, {
      arm,
      folder: resolve(required('folder')),
      harnessDir: resolve(required('harness')),
      gradeDir,
      agent: {
        ok: true,
        timedOut: false,
        tokens: optionalRound(count('tokens')),
        costUsd: count('cost-usd') ?? null,
        wallTimeMs: Math.round(count('wall-ms') ?? fail('grade needs --wall-ms.')),
      },
    });
    await report(result.attempt as BenchmarkAttemptResult, gradeDir, target);
    return;
  }

  fail(command === undefined ? 'Name a command.' : `There is no command \`${command}\`.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
