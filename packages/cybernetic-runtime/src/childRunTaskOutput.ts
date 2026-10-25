import type { WorkflowRunResult, WorkflowTask } from '@aflow/schemas';
import { projectTaskOutput } from './scheduling/outputProjection.js';

/**
 * A task that starts a run and waits for it records that run as it first
 * ended. A run that failed can be retried in place — the same run, the same
 * id, its failed task attempted again — and completed then, and the task that
 * waited on it heard only the failure: its waiter was answered and retired.
 * Read through here, the task's output is projected again from the run as it
 * stands, through the task's own projection, exactly as the waiter would have
 * delivered a first pass that completed — so an in-place retry and a first
 * pass read the same.
 */

const START_OPERATION = 'workflow.run.start';

/** The field of the task's output that holds this path of the envelope it was answered with. */
function envelopeField(task: WorkflowTask, envelopePath: 'runId' | 'outcome'): string | undefined {
  if (task.outputProjection === undefined) return envelopePath;
  for (const [field, spec] of Object.entries(task.outputProjection)) {
    if ('path' in spec && spec.path === envelopePath && spec.select === undefined) return field;
  }
  return undefined;
}

/**
 * The run a recorded task output says the task waited on, where that run
 * ended failed — the only ending a retry in place can follow. Undefined for
 * any other task or ending.
 */
export function failedChildRunOf(task: WorkflowTask, recorded: unknown): string | undefined {
  if (task.operation !== START_OPERATION) return undefined;
  if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) {
    return undefined;
  }
  const output = recorded as Record<string, unknown>;
  const runField = envelopeField(task, 'runId');
  const outcomeField = envelopeField(task, 'outcome');
  if (runField === undefined || outcomeField === undefined) return undefined;
  const runId = output[runField];
  return typeof runId === 'string' && output[outcomeField] === 'failed' ? runId : undefined;
}

/**
 * The task's output as the waiter would have recorded the run's completion:
 * its envelope — the run, `completed`, and its result — through the task's
 * projection, which reads `resolvedInput` for any field echoing its input.
 * Undefined where the projection does not resolve, which leaves the output
 * as it was recorded.
 */
export function taskOutputFromCompletedRun(
  task: WorkflowTask,
  recorded: Record<string, unknown>,
  run: { runId: string; result: WorkflowRunResult | undefined },
  resolvedInput: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const envelope: Record<string, unknown> = {
    runId: run.runId,
    outcome: 'completed',
    ...(typeof recorded['waiterId'] === 'string' ? { waiterId: recorded['waiterId'] } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
  };
  if (task.outputProjection === undefined) return envelope;
  const projected = projectTaskOutput(task.outputProjection, envelope, resolvedInput);
  return projected.ok ? projected.value : undefined;
}
