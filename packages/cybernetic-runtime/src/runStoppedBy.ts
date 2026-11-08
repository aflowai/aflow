/**
 * What stopped a run short of its primary output.
 *
 * A run can end green while its headline output never arrived: a task
 * succeeded with an outcome its successors' `when` conditions skip on, such
 * as a commit that conflicted. `result.stoppedBy` names that task, or the
 * run's own cancel or failure where no task row holds the cause, so a caller
 * reads one result rather than every task row.
 */
import type { PayloadStore } from '@aflow/payload-store';
import {
  WorkflowRunTaskStatusSchema,
  type Workflow,
  type WorkflowRunResultStoppedBy,
  type WorkflowTask,
} from '@aflow/schemas';
import { decodeTaskOutput } from './humanTaskHydration.js';
import { extractRunFailureReason } from './evalJudgeEvidence.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from './ledger/types.js';

/** A storage ceiling for the detail, sized for an error or a git account. */
const MAX_DETAIL_CHARS = 8_000;

const REDACTED = '[redacted]';

type StoppingRun = Pick<
  WorkflowRunDetail,
  'status' | 'failureJson' | 'cancelledBy' | 'cancelReason' | 'tasks'
>;
type StoppingWorkflow = Pick<Workflow, 'tasks' | 'stateVariables'>;

/** What the run named: a task row, or the run itself where no row holds the cause. */
export type RunStopper =
  { kind: 'task'; row: WorkflowTaskRow } | { kind: 'run'; status: 'failed' | 'cancelled' };

function inOrder(workflow: StoppingWorkflow, taskIds: ReadonlySet<string>): WorkflowTask[] {
  return workflow.tasks.filter((t) => taskIds.has(t.taskId));
}

function producersOf(workflow: StoppingWorkflow, primary: string): string[] {
  return workflow.tasks
    .filter((t) => (t.promoteOutputs ?? []).some((p) => p.toState === primary))
    .map((t) => t.taskId);
}

/** The producers of the primary output and every task they depend on, transitively. */
function producerAncestry(workflow: StoppingWorkflow, primary: string): Set<string> {
  const taskById = new Map(workflow.tasks.map((t) => [t.taskId, t]));
  const seen = new Set<string>();
  const pending = producersOf(workflow, primary);
  for (let taskId = pending.pop(); taskId !== undefined; taskId = pending.pop()) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    pending.push(...(taskById.get(taskId)?.dependsOn ?? []));
  }
  return seen;
}

function namedByRunFailure(failureJson: unknown): Set<string> {
  if (failureJson === null || typeof failureJson !== 'object') return new Set();
  const taskIds = (failureJson as Record<string, unknown>)['taskIds'];
  return new Set(
    Array.isArray(taskIds) ? taskIds.filter((id): id is string => typeof id === 'string') : [],
  );
}

/**
 * A cancelled run stopped on its own account: the cancel cascades into the
 * task rows, so a cancelled task names the cascade rather than its cause.
 * Otherwise only a required task on the way to a producer of the primary
 * output can stop it: an optional task's failure counts as a satisfied
 * dependency, and a task off that path withholds nothing from it. A failed
 * one comes first. A blocked or cancelled one comes next, behind any task the
 * run's failure names, because a `cancel_siblings` failure off the path
 * blocks the tasks on it. A failed run with none of these stopped on its own
 * account. A run that completed names the latest task that succeeded toward
 * the producer.
 */
export function findStopper(
  workflow: StoppingWorkflow,
  run: StoppingRun,
  primary: string,
): RunStopper | undefined {
  if (run.status === 'cancelled') return { kind: 'run', status: 'cancelled' };
  const rowByTaskId = new Map(run.tasks.map((r) => [r.taskId, r]));
  const onPath = inOrder(workflow, producerAncestry(workflow, primary)).filter(
    (t) => t.optional !== true,
  );
  const rowWith = (tasks: readonly WorkflowTask[], status: string): WorkflowTaskRow | undefined => {
    for (const task of tasks) {
      const row = rowByTaskId.get(task.taskId);
      if (row?.status === status) return row;
    }
    return undefined;
  };

  const failed = rowWith(onPath, 'failed');
  if (failed) return { kind: 'task', row: failed };
  const halted = rowWith(onPath, 'blocked') ?? rowWith(onPath, 'cancelled');
  if (halted) {
    const named = rowWith(inOrder(workflow, namedByRunFailure(run.failureJson)), 'failed');
    return { kind: 'task', row: named ?? halted };
  }
  if (run.status === 'failed') return { kind: 'run', status: 'failed' };
  const latest = latestSucceededTowardProducer(workflow, rowByTaskId, primary);
  return latest ? { kind: 'task', row: latest } : undefined;
}

/**
 * The latest task that succeeded on the way to a producer of the primary
 * output — the producer itself where it succeeded and promoted nothing, or
 * else the last ancestor that succeeded before every task between it and the
 * producer was skipped. It passes over every other row, so an optional task
 * that failed counts as satisfied, as readiness counts it.
 */
function latestSucceededTowardProducer(
  workflow: StoppingWorkflow,
  rowByTaskId: ReadonlyMap<string, WorkflowTaskRow>,
  primary: string,
): WorkflowTaskRow | undefined {
  const taskById = new Map(workflow.tasks.map((t) => [t.taskId, t]));
  const order = new Map(workflow.tasks.map((t, i) => [t.taskId, i]));
  const pending = producersOf(workflow, primary);
  const visited = new Set<string>();
  const candidates: WorkflowTaskRow[] = [];
  for (let taskId = pending.pop(); taskId !== undefined; taskId = pending.pop()) {
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    const row = rowByTaskId.get(taskId);
    if (row?.status === 'succeeded') {
      candidates.push(row);
      continue;
    }
    pending.push(...(taskById.get(taskId)?.dependsOn ?? []));
  }
  const at = (row: WorkflowTaskRow): number => row.completedAt?.getTime() ?? 0;
  const position = (row: WorkflowTaskRow): number => order.get(row.taskId) ?? 0;
  let latest: WorkflowTaskRow | undefined;
  for (const row of candidates) {
    if (
      !latest ||
      at(row) > at(latest) ||
      (at(row) === at(latest) && position(row) > position(latest))
    ) {
      latest = row;
    }
  }
  return latest;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Which of a task's own accounts fill a sensitive variable: its whole output,
 * named output paths, or its summary. Those stay out of the detail, as the
 * variables they fill stay out of `output`.
 */
function sensitiveSources(task: WorkflowTask | undefined, sensitiveIds: ReadonlySet<string>) {
  const promotions = (task?.promoteOutputs ?? []).filter((p) => sensitiveIds.has(p.toState));
  const paths = promotions.flatMap((p) => (p.kind === 'output_path' ? [p.path] : []));
  return {
    output: promotions.some((p) => p.kind === 'output_root'),
    summary: promotions.some((p) => p.kind === 'task_summary'),
    field: (key: string): boolean => paths.some((p) => p === key || p.startsWith(`${key}.`)),
  };
}

/**
 * What the task said about how it ended: a failure's reason, or, for a task
 * that succeeded, the `state` and `detail` its output reports.
 */
async function describeTaskEnding(
  payloadStore: PayloadStore,
  row: WorkflowTaskRow,
  task: WorkflowTask | undefined,
  sensitiveIds: ReadonlySet<string>,
): Promise<string | undefined> {
  const hidden = sensitiveSources(task, sensitiveIds);
  const recorded = text(row.failureReason) ?? (hidden.summary ? undefined : text(row.summary));
  if (row.status !== 'succeeded' || hidden.output) return recorded;
  const output = await decodeTaskOutput(row.outputRef, payloadStore).catch(() => null);
  const field = (key: string): string | undefined =>
    hidden.field(key) ? undefined : text(output?.[key]);
  const state = field('state');
  const said = field('detail') ?? field('summary') ?? recorded;
  const parts = [state === undefined ? undefined : `state: ${state}`, said].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

function describeRunEnding(run: StoppingRun): string | undefined {
  if (run.status !== 'cancelled') return text(extractRunFailureReason(run.failureJson));
  const actor = text(run.cancelledBy);
  const reason = text(run.cancelReason);
  if (actor === undefined) return reason;
  return reason === undefined ? `cancelled by ${actor}` : `cancelled by ${actor}: ${reason}`;
}

/**
 * The spellings a sensitive value takes when a reason quotes it: a string as
 * itself, and a number, boolean or object as its JSON text. An object's
 * leaves are spelled too, as a message usually quotes one field of it.
 */
function sensitiveSpellings(value: unknown): string[] {
  if (typeof value === 'string') return text(value) === undefined ? [] : [value];
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return [String(value)];
  }
  if (value === null || typeof value !== 'object') return [];
  const leaves = Object.values(value).flatMap(sensitiveSpellings);
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(value);
  } catch {
    serialised = undefined;
  }
  return serialised === undefined ? leaves : [serialised, ...leaves];
}

function redact(detail: string, sensitiveValues: readonly string[]): string {
  // Longest first, so an object's JSON text is replaced whole before its leaves.
  const spellings = [...new Set(sensitiveValues)].sort((a, b) => b.length - a.length);
  let out = detail;
  for (const value of spellings) out = out.split(value).join(REDACTED);
  return out;
}

function bounded(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS
    ? `${detail.slice(0, MAX_DETAIL_CHARS)}… [truncated]`
    : detail;
}

export interface BuildStoppedByArgs {
  workflow: StoppingWorkflow;
  run: StoppingRun;
  primary: string;
  /** The raw promoted bag. Its sensitive values are redacted from the detail. */
  bag: Readonly<Record<string, unknown>>;
}

export async function buildStoppedBy(
  payloadStore: PayloadStore,
  args: BuildStoppedByArgs,
): Promise<WorkflowRunResultStoppedBy | undefined> {
  const { workflow, run, primary, bag } = args;
  const stopper = findStopper(workflow, run, primary);
  if (!stopper) return undefined;

  const sensitiveIds = new Set(
    workflow.stateVariables.filter((v) => v.sensitive).map((v) => v.variableId),
  );
  const sensitiveValues = Object.entries(bag)
    .filter(([key]) => sensitiveIds.has(key))
    .flatMap(([, value]) => sensitiveSpellings(value));

  let head: Pick<WorkflowRunResultStoppedBy, 'taskId' | 'status'>;
  let detail: string | undefined;
  if (stopper.kind === 'run') {
    head = { taskId: null, status: stopper.status };
    detail = describeRunEnding(run);
  } else {
    const status = WorkflowRunTaskStatusSchema.safeParse(stopper.row.status);
    if (!status.success) return undefined;
    head = { taskId: stopper.row.taskId, status: status.data };
    const task = workflow.tasks.find((t) => t.taskId === stopper.row.taskId);
    detail = await describeTaskEnding(payloadStore, stopper.row, task, sensitiveIds);
  }
  return detail === undefined
    ? head
    : { ...head, detail: bounded(redact(detail, sensitiveValues)) };
}
