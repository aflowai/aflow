import { resolvePromotedRunMetrics } from '../promotion.js';
import { computeReadyTasksWithWhen } from './graph.js';
import { outputContractViolations } from './outputContractViolations.js';
import { projectTaskOutput } from './outputProjection.js';
import { decideByRules } from './ruleDecision.js';
// The bundles' derive tasks name run derivers this module registers when it loads.
import './tradingMarketRegime.js';
import {
  getRunDeriver,
  substituteTemplateBinds,
  WorkflowRunDecideInputSchema,
  WorkflowRunDeriveInputSchema,
  type WorkflowStateVariable,
  type WorkflowTask,
} from '@aflow/schemas';

const FAILURE = Symbol('failure');

/** A failure that records `reason`, as a failed task's row records its failure. */
export interface TaskFailure {
  readonly [FAILURE]: string;
}

export const failWith = (reason: string): TaskFailure => ({ [FAILURE]: reason });

/** What a task answers in a run: its raw output, or a failure. */
export type TaskAnswer = Record<string, unknown> | 'fail' | TaskFailure;

const isFailure = (raw: TaskAnswer): raw is TaskFailure =>
  typeof raw === 'object' && FAILURE in raw;

export interface SkillRun {
  /** Every task that ran, in order. */
  readonly ran: string[];
  /** The input each task that ran was handed, after its template. */
  readonly inputs: ReadonlyMap<string, Record<string, unknown>>;
  /** The run's state, as its tasks promoted it. */
  readonly state: Record<string, unknown>;
  readonly statuses: ReadonlyMap<string, string>;
  /** The output each task that succeeded recorded, after its projection. */
  readonly outputs: ReadonlyMap<string, Record<string, unknown>>;
  /** The failure each failed task records. */
  readonly failures: ReadonlyMap<string, string>;
}

function readPath(value: unknown, path: string | undefined): unknown {
  let at = value;
  for (const key of path?.replace(/\[(\d+)\]/g, '.$1').split('.') ?? []) {
    at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  }
  return at;
}

/** A `workflow.run.derive` task, derived as the orchestrator derives it: a refusal fails it. */
function derive(input: Record<string, unknown>): TaskAnswer {
  const parsed = WorkflowRunDeriveInputSchema.parse(input);
  const deriver = getRunDeriver(parsed.deriver);
  if (!deriver) return failWith(`No run deriver is registered as "${parsed.deriver}".`);
  const derived = deriver(parsed.args);
  return derived.ok
    ? { deriver: parsed.deriver, value: derived.value }
    : failWith(`WORKFLOW_RUN_DERIVE_REFUSED: ${derived.message}`);
}

/**
 * A skill's tasks run as the scheduler runs them — readiness, `when`, template,
 * projection and promotion — with each operation answered by `answer`, every
 * `workflow.run.decide` decided and every `workflow.run.derive` derived as the
 * orchestrator does it, and the state promoted under the skill's
 * `stateVariables` where they are given. A `run_id` binding resolves to
 * `context.runId`, and a `campaign_input` binding to its path in
 * `context.campaign`. It runs in memory, with no store, executor or model, so
 * skill tests and the Store bundle smoke run (`yarn store:smoke`) share it.
 */
export function runSkillTasks(
  tasks: readonly WorkflowTask[],
  runInputs: Readonly<Record<string, unknown>>,
  answer: (taskId: string, input: Record<string, unknown>) => TaskAnswer,
  stateVariables?: readonly WorkflowStateVariable[],
  context: { runId?: string; campaign?: Readonly<Record<string, unknown>> } = {},
): SkillRun {
  const all = tasks as WorkflowTask[];
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const failedOptional = new Set<string>();
  const statuses = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const inputs = new Map<string, Record<string, unknown>>();
  const failures = new Map<string, string>();
  const ran: string[] = [];

  for (let round = 0; round <= all.length; round += 1) {
    const ready = computeReadyTasksWithWhen(
      all,
      completed,
      skipped,
      { statuses, outputs },
      failedOptional,
    );
    if (ready.errors.length > 0) {
      throw new Error(ready.errors.map((error) => error.reason).join('; '));
    }
    for (const { task } of ready.skipped) {
      skipped.add(task.taskId);
      statuses.set(task.taskId, 'skipped');
    }
    let moved = ready.skipped.length > 0;
    for (const task of ready.ready) {
      if (ran.includes(task.taskId)) continue;
      moved = true;
      ran.push(task.taskId);
      const bound: Record<string, unknown> = {};
      for (const [name, binding] of Object.entries(task.inputBindings ?? {})) {
        const value =
          binding.kind === 'task_output'
            ? readPath(outputs.get(binding.taskId), binding.path)
            : binding.kind === 'run_input'
              ? runInputs[binding.path]
              : binding.kind === 'run_id'
                ? context.runId
                : binding.kind === 'task_failure'
                  ? failures.get(binding.taskId)
                  : binding.kind === 'campaign_input'
                    ? readPath(context.campaign, binding.path)
                    : undefined;
        if (value !== undefined) bound[name] = value;
      }
      const input =
        task.inputTemplate === undefined
          ? bound
          : substituteTemplateBinds(
              task.inputTemplate,
              bound,
              new Set(Object.keys(task.inputBindings ?? {})),
            );
      inputs.set(task.taskId, input);
      const raw =
        task.operation === 'workflow.run.decide'
          ? { ...decideByRules(WorkflowRunDecideInputSchema.parse(input)) }
          : task.operation === 'workflow.run.derive'
            ? derive(input)
            : answer(task.taskId, input);
      let output: Record<string, unknown> | undefined;
      let failure = `the ${task.taskId} task failed`;
      if (isFailure(raw)) {
        failure = raw[FAILURE];
      } else if (raw !== 'fail') {
        if (task.outputProjection === undefined) {
          output = raw;
        } else {
          const projected = projectTaskOutput(task.outputProjection, raw, input);
          output = projected.ok ? projected.value : undefined;
        }
      }
      if (output === undefined) {
        statuses.set(task.taskId, 'failed');
        failures.set(task.taskId, failure);
        if (task.optional === true) failedOptional.add(task.taskId);
        continue;
      }
      outputs.set(task.taskId, output);
      completed.add(task.taskId);
      statuses.set(task.taskId, 'succeeded');
    }
    if (!moved) break;
  }

  const state = resolvePromotedRunMetrics(
    all,
    [...outputs].map(([taskId, output]) => ({
      taskId,
      status: statuses.get(taskId) ?? 'pending',
      output,
    })),
    stateVariables,
  );
  return { ran, inputs, state, statuses, outputs, failures };
}

/**
 * The task runner the Store bundle smoke run hands its mock client: the run,
 * its failure, and the output contract check of each agent task the fixtures answer.
 */
export const skillTaskRunner = { runSkillTasks, failWith, outputContractViolations };
