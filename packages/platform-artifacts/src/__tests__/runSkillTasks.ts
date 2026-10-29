import {
  computeReadyTasksWithWhen,
  decideByRules,
  projectTaskOutput,
  resolvePromotedRunMetrics,
} from '@aflow/cybernetic-runtime';
import {
  substituteTemplateBinds,
  WorkflowRunDecideInputSchema,
  type WorkflowStateVariable,
  type WorkflowTask,
} from '@aflow/schemas';

/** What a task answers in a run: its raw output, or a failure. */
export type TaskAnswer = Record<string, unknown> | 'fail';

export interface SkillRun {
  /** Every task that ran, in order. */
  readonly ran: string[];
  /** The input each task that ran was handed, after its template. */
  readonly inputs: ReadonlyMap<string, Record<string, unknown>>;
  /** The run's state, as its tasks promoted it. */
  readonly state: Record<string, unknown>;
  readonly statuses: ReadonlyMap<string, string>;
}

function readPath(value: unknown, path: string | undefined): unknown {
  let at = value;
  for (const key of path?.replace(/\[(\d+)\]/g, '.$1').split('.') ?? []) {
    at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  }
  return at;
}

/**
 * A skill's tasks run as the scheduler runs them — readiness, `when`, template,
 * projection and promotion — with each operation answered by `answer`, and
 * every `workflow.run.decide` decided as the orchestrator decides it, and the
 * state promoted under the skill's `stateVariables` where they are given.
 */
export function runSkillTasks(
  tasks: readonly WorkflowTask[],
  runInputs: Readonly<Record<string, unknown>>,
  answer: (taskId: string, input: Record<string, unknown>) => TaskAnswer,
  stateVariables?: readonly WorkflowStateVariable[],
): SkillRun {
  const all = tasks as WorkflowTask[];
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const failedOptional = new Set<string>();
  const statuses = new Map<string, string>();
  const outputs = new Map<string, Record<string, unknown>>();
  const inputs = new Map<string, Record<string, unknown>>();
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
          : answer(task.taskId, input);
      let output: Record<string, unknown> | undefined;
      if (raw !== 'fail') {
        if (task.outputProjection === undefined) {
          output = raw;
        } else {
          const projected = projectTaskOutput(task.outputProjection, raw, input);
          output = projected.ok ? projected.value : undefined;
        }
      }
      if (output === undefined) {
        statuses.set(task.taskId, 'failed');
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
  return { ran, inputs, state, statuses };
}
