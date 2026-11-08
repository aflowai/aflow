/**
 * The task that stopped a run short of its primary output.
 *
 * A run can end green while its headline output never arrived: a task
 * succeeded with an outcome its successors' `when` conditions skip on, such
 * as a commit that conflicted. `result.stoppedBy` names that task, so a caller
 * reads one result rather than every task row.
 */
import type { PayloadStore } from '@aflow/payload-store';
import type { Workflow, WorkflowRunResultStoppedBy } from '@aflow/schemas';
import { decodeTaskOutput } from './humanTaskHydration.js';
import type { WorkflowTaskRow } from './ledger/types.js';

/** A storage ceiling for the detail, sized for an error or a git account. */
const MAX_DETAIL_CHARS = 8_000;

const FAILURE_STATUSES = ['failed', 'blocked', 'cancelled'] as const;

function ran(row: WorkflowTaskRow | undefined): row is WorkflowTaskRow {
  return row !== undefined && row.status !== 'skipped';
}

/**
 * A failed task first, then a blocked one, then a cancelled one: a failure
 * comes before the tasks it blocked. With none, the latest task that ran on
 * the way to a producer of the primary output — the producer itself where it
 * ran and promoted nothing, or else the last ancestor that ran before every
 * task between it and the producer was skipped.
 */
export function findStoppingTask(
  workflow: Pick<Workflow, 'tasks'>,
  rows: readonly WorkflowTaskRow[],
  primary: string,
): WorkflowTaskRow | undefined {
  const rowByTaskId = new Map(rows.map((r) => [r.taskId, r]));
  for (const status of FAILURE_STATUSES) {
    for (const task of workflow.tasks) {
      const row = rowByTaskId.get(task.taskId);
      if (row?.status === status) return row;
    }
  }

  const taskById = new Map(workflow.tasks.map((t) => [t.taskId, t]));
  const order = new Map(workflow.tasks.map((t, i) => [t.taskId, i]));
  const pending = workflow.tasks
    .filter((t) => (t.promoteOutputs ?? []).some((p) => p.toState === primary))
    .map((t) => t.taskId);
  const visited = new Set<string>();
  const candidates: WorkflowTaskRow[] = [];
  for (let taskId = pending.pop(); taskId !== undefined; taskId = pending.pop()) {
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    const row = rowByTaskId.get(taskId);
    if (ran(row)) {
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
 * What the task said about how it ended: a failure's reason, or, for a task
 * that succeeded, the `state` and `detail` its output reports.
 */
async function describeEnding(
  payloadStore: PayloadStore,
  row: WorkflowTaskRow,
): Promise<string | undefined> {
  const recorded = text(row.failureReason) ?? text(row.summary);
  if (row.status !== 'succeeded') return recorded;
  const output = await decodeTaskOutput(row.outputRef, payloadStore).catch(() => null);
  const state = text(output?.['state']);
  const said = text(output?.['detail']) ?? text(output?.['summary']) ?? recorded;
  const parts = [state === undefined ? undefined : `state: ${state}`, said].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

export async function buildStoppedBy(
  payloadStore: PayloadStore,
  workflow: Pick<Workflow, 'tasks'>,
  rows: readonly WorkflowTaskRow[],
  primary: string,
): Promise<WorkflowRunResultStoppedBy | undefined> {
  const row = findStoppingTask(workflow, rows, primary);
  if (!row) return undefined;
  const detail = await describeEnding(payloadStore, row);
  return {
    taskId: row.taskId,
    status: row.status,
    ...(detail === undefined
      ? {}
      : {
          detail:
            detail.length > MAX_DETAIL_CHARS
              ? `${detail.slice(0, MAX_DETAIL_CHARS)}… [truncated]`
              : detail,
        }),
  };
}
