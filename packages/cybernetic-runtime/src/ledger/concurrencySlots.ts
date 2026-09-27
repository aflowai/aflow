import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { SkillConcurrencyPolicy, TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import { DISPATCH_CLAIM_GRACE_MS } from './dispatchArming.js';
import { readPinnedConcurrencyPolicy } from '../scheduling/concurrencyPolicy.js';

/** A dispatch the scheduler has placed that no worker has picked up yet. */
export const SCHEDULED_TASK_STATUSES: ReadonlySet<string> = new Set(['scheduled']);

/** A dispatch a worker is executing. */
export const LIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['running', 'claimed', 'in_flight']);

/**
 * The statuses that occupy one of a run's parallel slots: dispatched, not yet
 * terminal.
 *
 * A polled task is in here for the whole loop, not just while a cycle is in
 * flight — the poll gate advances `poll_cycle` on a row that stays `running`.
 * Releasing the slot between cycles would let a limit of four submissions grow
 * into as many live provider jobs as the poll budgets allow.
 */
export const SLOT_HOLDING_TASK_STATUSES: ReadonlySet<string> = new Set([
  ...SCHEDULED_TASK_STATUSES,
  ...LIVE_TASK_STATUSES,
]);

/**
 * The state a reserved-but-undispatched task row sits in. The claim that
 * follows may only upgrade a row in this state, so a dispatch can never
 * overwrite a row some other path is already driving.
 */
export const RESERVED_TASK_STATUS = 'scheduled';

export function holdsConcurrencySlot(status: string): boolean {
  return SLOT_HOLDING_TASK_STATUSES.has(status);
}

export function countHeldSlots(taskRows: ReadonlyArray<{ status: string }>): number {
  return taskRows.filter((row) => holdsConcurrencySlot(row.status)).length;
}

export interface SlotSelection {
  /** Ready tasks that fit in the free slots, in the caller's order. */
  selected: string[];
  /** Ready tasks left over; they stay ready and are reconsidered next wave. */
  deferred: string[];
  freeSlots: number;
}

export function selectTasksForFreeSlots(args: {
  limit: number;
  activeCount: number;
  readyTaskIds: readonly string[];
}): SlotSelection {
  const freeSlots = Math.max(0, args.limit - args.activeCount);
  return {
    freeSlots,
    selected: args.readyTaskIds.slice(0, freeSlots),
    deferred: args.readyTaskIds.slice(freeSlots),
  };
}

/**
 * Lock the run row and read its pinned limit alongside current slot usage.
 *
 * Every path that puts a task into a slot-holding state goes through this, in
 * its own transaction, so the limit is a property of the run rather than of one
 * scheduler. `excludeTaskId` is for a row that is about to transition into a
 * slot: it must not be counted against the budget it is asking for.
 */
export async function readRunSlotState(
  tx: PostgresJsDatabase,
  runId: string,
  opts?: { excludeTaskId?: string },
): Promise<{ limit: number; activeCount: number; freeSlots: number }> {
  const runRows = await tx.execute<{ row: Record<string, unknown> }>(
    sql`SELECT to_jsonb(${workflowRuns}) AS row FROM ${workflowRuns} WHERE ${workflowRuns.runId} = ${runId} FOR UPDATE`,
  );
  const rawRow = runRows[0]?.row;
  if (!rawRow) {
    throw new Error(`[readRunSlotState] workflow run not found: runId=${runId}`);
  }
  const limit = readPinnedConcurrencyPolicy({
    effectiveConcurrencyPolicy: (rawRow['effective_concurrency_policy'] ??
      null) as SkillConcurrencyPolicy | null,
  }).maxParallelTasksPerRun;

  const statuses = [...SLOT_HOLDING_TASK_STATUSES];
  const activeRows = await tx.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM ${workflowRunTasks}
        WHERE ${workflowRunTasks.runId} = ${runId}
          AND ${workflowRunTasks.status} IN ${sql.raw(`(${statuses.map((s) => `'${s}'`).join(', ')})`)}
          ${opts?.excludeTaskId !== undefined ? sql`AND ${workflowRunTasks.taskId} <> ${opts.excludeTaskId}` : sql``}`,
  );
  const activeCount = activeRows[0]?.count ?? 0;
  return { limit, activeCount, freeSlots: Math.max(0, limit - activeCount) };
}

/**
 * Whether a task may enter a slot-holding state right now.
 *
 * Retry, resume and producer-rerun all put a row back into `running` in place.
 * Admitting those unconditionally would make the limit advisory, and for an
 * operation that bills on submit an over-limit call cannot be undone by a later
 * reservation pass — so the excess is not self-correcting in the way that
 * matters. Refusing is legible and the caller can try again once a slot frees.
 */
export async function hasFreeSlotForTask(
  tx: PostgresJsDatabase,
  runId: string,
  taskId: string,
): Promise<boolean> {
  const state = await readRunSlotState(tx, runId, { excludeTaskId: taskId });
  return state.freeSlots > 0;
}

export interface ReserveTaskSlotsParams {
  runId: string;
  /** Ready task ids, in the order the caller would dispatch them. */
  readyTaskIds: readonly string[];
}

export interface TaskSlotReservation {
  /** Claimed by this call — the caller dispatches exactly these. */
  reserved: string[];
  /** Ready but unreserved, either over the limit or claimed by another pass. */
  deferred: string[];
  limit: number;
  activeCount: number;
}

/**
 * Take up to `maxParallelTasksPerRun` slots for a run and claim the tasks that
 * got them.
 *
 * The lock, the count and the claims are deliberately one transaction. Several
 * completion paths drive scheduling for the same run concurrently; with the
 * count taken outside the lock each pass reads the same free slots and reserves
 * against them, which makes the limit per-scheduler rather than per-run. Only
 * `SELECT … FOR UPDATE` on the run row orders them.
 *
 * The limit comes off the run row's pinned policy — never from re-resolving the
 * skill manifest, which would let an edit landing mid-run change the limits of
 * a run already in flight.
 */
export async function reserveTaskSlots(
  db: PostgresJsDatabase,
  tenantId: string,
  params: ReserveTaskSlotsParams,
): Promise<TaskSlotReservation> {
  if (params.readyTaskIds.length === 0) {
    return { reserved: [], deferred: [], limit: 0, activeCount: 0 };
  }
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const { limit, activeCount } = await readRunSlotState(tx, params.runId);

    const { selected } = selectTasksForFreeSlots({
      limit,
      activeCount,
      readyTaskIds: params.readyTaskIds,
    });
    if (selected.length === 0) {
      return { reserved: [], deferred: [...params.readyTaskIds], limit, activeCount };
    }

    const inserted = await tx
      .insert(workflowRunTasks)
      .values(
        selected.map((taskId) => ({
          runId: params.runId,
          taskId,
          status: RESERVED_TASK_STATUS,
          attempt: 1,
          // This row commits before the dispatch it reserves. Without a
          // deadline a process that dies in that window leaves it holding a
          // slot no worker will ever claim, invisible to recovery.
          dispatchDeadlineAt: new Date(Date.now() + DISPATCH_CLAIM_GRACE_MS),
        })),
      )
      .onConflictDoNothing({ target: [workflowRunTasks.runId, workflowRunTasks.taskId] })
      .returning({ taskId: workflowRunTasks.taskId });

    const reserved = inserted.map((row) => row.taskId);
    const reservedSet = new Set(reserved);
    return {
      reserved,
      deferred: params.readyTaskIds.filter((taskId) => !reservedSet.has(taskId)),
      limit,
      activeCount,
    };
  });
}
