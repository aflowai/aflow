import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { TenantId, ResumeCasErrorCode } from '@aflow/schemas';
import { RESUME_CLAIM_DEFAULT_TTL_MS } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
  workflowRunCompletionPending,
} from '@aflow/database';
import { clearBlockedDescendantsForRetry } from './tasks.js';
import { awaitingDispatchPatch } from './dispatchArming.js';
import { hasFreeSlotForTask } from './concurrencySlots.js';

export interface ResumeClaim {
  /** Random nonce stamped into `resume_claim_token`. Required for follow-up writes. */
  claimToken: string;
  /** Snapshot version this claim is bound to. Stale snapshots are rejected up-front. */
  pauseVersion: number;
  /** Wall clock at which the claim is treated as expired. */
  expiresAt: Date;
}

export type ClaimResumeLeaseResult =
  { ok: true; claim: ResumeClaim } | { ok: false; code: ResumeCasErrorCode };

export async function claimResumeLease(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  expectedPauseVersion: number,
  opts: { ttlMs?: number } = {},
): Promise<ClaimResumeLeaseResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const ttlMs = opts.ttlMs ?? RESUME_CLAIM_DEFAULT_TTL_MS;
  const claimToken = randomUUID();
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // Atomic CAS — single UPDATE … RETURNING checks all three guards.
    const updated = await tx
      .update(workflowRuns)
      .set({
        resumeClaimToken: claimToken,
        resumeClaimExpiresAt: sql`now() + (${ttlSeconds} || ' seconds')::interval`,
      })
      .where(
        and(
          eq(workflowRuns.runId, runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.pauseVersion, expectedPauseVersion),
          sql`(${workflowRuns.resumeClaimToken} IS NULL OR ${workflowRuns.resumeClaimExpiresAt} < now())`,
        ),
      )
      .returning({
        pauseVersion: workflowRuns.pauseVersion,
        expiresAt: workflowRuns.resumeClaimExpiresAt,
      });
    if (updated.length === 1) {
      const row = updated[0]!;
      return {
        ok: true as const,
        claim: {
          claimToken,
          pauseVersion: row.pauseVersion,
          expiresAt: row.expiresAt ?? new Date(Date.now() + ttlMs),
        },
      };
    }
    // CAS failed — disambiguate the error by reading the live row.
    const live = await tx
      .select({
        status: workflowRuns.status,
        pauseVersion: workflowRuns.pauseVersion,
        resumeClaimToken: workflowRuns.resumeClaimToken,
        resumeClaimExpiresAt: workflowRuns.resumeClaimExpiresAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1);
    if (live.length === 0 || live[0]!.status !== 'paused') {
      return { ok: false as const, code: 'RUN_NOT_PAUSED' };
    }
    if (live[0]!.pauseVersion !== expectedPauseVersion) {
      return { ok: false as const, code: 'STALE_PAUSE_VERSION' };
    }
    return { ok: false as const, code: 'RESUME_IN_PROGRESS' };
  });
}

export async function releaseResumeClaim(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  claimToken: string,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRuns)
      .set({ resumeClaimToken: null, resumeClaimExpiresAt: null })
      .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.resumeClaimToken, claimToken)))
      .returning({ id: workflowRuns.id });
    return updated.length === 1;
  });
}

export async function resumeRunWithClaim(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  claimToken: string,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        pausedReason: null,
        pausedPayloadRef: null,
      })
      .where(
        and(
          eq(workflowRuns.runId, runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ id: workflowRuns.id });
    return updated.length === 1;
  });
}

export async function bumpResumeAttemptCount(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  claimToken: string,
): Promise<number | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(workflowRuns)
      .set({
        resumeAttemptCount: sql`${workflowRuns.resumeAttemptCount} + 1`,
      })
      .where(
        and(
          eq(workflowRuns.runId, runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ resumeAttemptCount: workflowRuns.resumeAttemptCount });
    return updated[0]?.resumeAttemptCount ?? null;
  });
}

export interface CommitReplaceOutputArgs {
  runId: string;
  claimToken: string;
  failedTaskId: string;
  /** PayloadStore ref to the merged output that satisfies the full schema. */
  outputRef: string;
  /** Human-readable summary written to the task row. */
  summary: string;
  /** Optional completion timestamp (defaults to now). */
  completedAt?: Date;
}

export type CommitReplaceOutputResult = 'committed' | 'claim_lost' | 'task_row_not_paused';

export async function commitReplaceOutputAndResume(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitReplaceOutputArgs,
): Promise<CommitReplaceOutputResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // Single atomic CAS on the run row — verifies the claim is still
    // live and flips status in one shot. If the row update returns 0,
    // the claim is gone and we abort the transaction.
    const runUpdate = await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        pausedReason: null,
        pausedPayloadRef: null,
      })
      .where(
        and(
          eq(workflowRuns.runId, args.runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, args.claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (runUpdate.length === 0) {
      // Lease lost or row repaused. Roll back the whole tx.
      throw new ResumeClaimLostError();
    }
    // Update the failed task row in the same tx. Conditioned on the
    // task being in `paused` state to avoid clobbering a row that
    // somehow got reprocessed — safer to leave the bad state visible
    // than overwrite with stale info.
    //
    const taskUpdate = await tx
      .update(workflowRunTasks)
      .set({
        status: 'succeeded',
        outputRef: args.outputRef,
        completedAt: args.completedAt ?? new Date(),
        summary: args.summary,
        failureReason: null,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.failedTaskId),
          eq(workflowRunTasks.status, 'paused'),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (taskUpdate.length !== 1) {
      throw new TaskRowNotPausedError(args.runId, args.failedTaskId);
    }
    return 'committed' as const;
  }).catch((err: unknown) => {
    if (err instanceof ResumeClaimLostError) return 'claim_lost' as const;
    if (err instanceof TaskRowNotPausedError) return 'task_row_not_paused' as const;
    throw err;
  });
}

class ResumeClaimLostError extends Error {
  constructor() {
    super('Resume claim was lost between mode work and commit');
    this.name = 'ResumeClaimLostError';
  }
}

class TaskRowNotPausedError extends Error {
  constructor(runId: string, taskId: string) {
    super(
      `Task ${taskId} on run ${runId} is not in 'paused' state — replace_output cannot transition it.`,
    );
    this.name = 'TaskRowNotPausedError';
  }
}

export interface CommitProvideInputArgs {
  runId: string;
  claimToken: string;
  /** The paused task whose row will be deleted for re-dispatch. */
  taskId: string;
  /**
   * Stored shape from `StoredParentTaskInputsSchema` — `{ taskId, inputs }`.
   * Merged into `workflow_runs.metadata.parentTaskInputs` via JSONB
   * concat (replaces any prior `parentTaskInputs`).
   */
  parentTaskInputs: { taskId: string; inputs: Record<string, unknown> };
}

export type CommitProvideInputResult = 'committed' | 'claim_lost' | 'task_row_not_paused';

export async function commitProvideInputAndResume(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitProvideInputArgs,
): Promise<CommitProvideInputResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. CAS the run row. Merges parentTaskInputs into metadata via
    //    JSONB concat (`||`): right side wins on key conflicts, so a
    //    re-resume with new inputs overwrites the prior blob. Other
    //    keys on metadata (parentInstructions, evaluationJson, etc.)
    //    survive intact.
    const newMetadataPatch = JSON.stringify({ parentTaskInputs: args.parentTaskInputs });
    const runUpdate = await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        pausedReason: null,
        pausedPayloadRef: null,
        metadata: sql`COALESCE(${workflowRuns.metadata}, '{}'::jsonb) || ${newMetadataPatch}::jsonb`,
      })
      .where(
        and(
          eq(workflowRuns.runId, args.runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, args.claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (runUpdate.length === 0) {
      throw new ResumeClaimLostError();
    }

    // 2. Delete the paused task row. The dead attempt clears the way
    //    for `dispatchTask`'s `claimAndSchedule` to INSERT a fresh row.
    const taskDelete = await tx
      .delete(workflowRunTasks)
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.taskId),
          eq(workflowRunTasks.status, 'paused'),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (taskDelete.length !== 1) {
      throw new TaskRowNotPausedError(args.runId, args.taskId);
    }

    // 3. Phase 3 review fix (P1) — delete any matching
    //    `workflow_run_completion_pending` rows for this task. The FK
    //    on that table targets `workflow_runs(run_id)` only, NOT
    //    `workflow_run_tasks`, so deleting the task row above does NOT
    //    cascade-clear pending rows. Stale completion_pending rows
    //    would:
    //
    //      - Block `claimAndSchedule` on the re-dispatch because of the
    //        unique `(run_id, task_id, attempt)` constraint when the
    //        new attempt happens to collide with the old one.
    //      - Be picked up by the sweeper and re-apply the OLD
    //        `workerSessionId`'s PAUSED hot state to the freshly running
    //        task — a stale pause from the previous attempt.
    //
    //    Match by `(run_id, task_id)` so any stale row for any attempt
    //    is swept up, not just the one whose attempt happened to match
    //    the deleted task row.
    await tx
      .delete(workflowRunCompletionPending)
      .where(
        and(
          eq(workflowRunCompletionPending.runId, args.runId),
          eq(workflowRunCompletionPending.taskId, args.taskId),
        ),
      );

    return 'committed' as const;
  }).catch((err: unknown) => {
    if (err instanceof ResumeClaimLostError) return 'claim_lost' as const;
    if (err instanceof TaskRowNotPausedError) return 'task_row_not_paused' as const;
    throw err;
  });
}

export interface CommitFailTaskArgs {
  runId: string;
  claimToken: string;
  taskId: string;
  attempt: number;
  reason: string;
  summary?: string;
  completedAt?: Date;
}

export type CommitFailTaskResult = 'committed' | 'claim_lost' | 'task_row_state_mismatch';

class TaskRowStateMismatchError extends Error {
  constructor(runId: string, taskId: string, attempt: number) {
    super(
      `Task ${taskId} on run ${runId} is not paused at attempt ${String(attempt)} — fail resolution cannot transition it.`,
    );
    this.name = 'TaskRowStateMismatchError';
  }
}

export async function commitFailTaskAndResume(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitFailTaskArgs,
): Promise<CommitFailTaskResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const runUpdate = await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        pausedReason: null,
        pausedPayloadRef: null,
      })
      .where(
        and(
          eq(workflowRuns.runId, args.runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, args.claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (runUpdate.length === 0) {
      throw new ResumeClaimLostError();
    }

    const taskUpdate = await tx
      .update(workflowRunTasks)
      .set({
        status: 'failed',
        outputRef: null,
        completedAt: args.completedAt ?? new Date(),
        summary: args.summary ?? `Rejected via workflow.run.resume fail (reason=${args.reason}).`,
        failureReason: args.reason,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.taskId),
          eq(workflowRunTasks.status, 'paused'),
          eq(workflowRunTasks.attempt, args.attempt),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (taskUpdate.length !== 1) {
      throw new TaskRowStateMismatchError(args.runId, args.taskId, args.attempt);
    }

    return 'committed' as const;
  }).catch((err: unknown) => {
    if (err instanceof ResumeClaimLostError) return 'claim_lost' as const;
    if (err instanceof TaskRowStateMismatchError) return 'task_row_state_mismatch' as const;
    throw err;
  });
}

/**
 * Atomic commit for `workflow.run.resume` mode `reject` — an operator's "no"
 * on an approval gate (reject-but-learn).
 *
 * In ONE transaction:
 *   1. Flip the run `paused` → `running` (claim-token CAS, mirrors
 *      `commitFailTaskAndResume`).
 *   2. CAS the approve task row `paused` → **skipped** with the rejected
 *      decision recorded as its output (`outputRef`). Skipped — not failed —
 *      so the run does NOT surface as failed and a skipped upstream satisfies
 *      `dependsOn` for the always-on downstream.
 *   3. Insert `skipped` rows for `skipDescendantTaskIds` (the approve task's
 *      `when`-gated descendant branch — the conditional action the approval
 *      guards). Atomic with (1)+(2) so a crash can never leave the run
 *      `running` with the gated branch un-skipped — which would let the
 *      scheduler dispatch the rejected action (e.g. submit despite a "no").
 *
 * The caller then drives `dispatchNextOrTerminate`, which dispatches the
 * always-on (when-less) descendants with their bindings to the skipped branch
 * resolving to ABSENT.
 */
export interface CommitRejectApproveTaskArgs {
  runId: string;
  claimToken: string;
  /** The approve task being rejected. */
  taskId: string;
  attempt: number;
  /** PayloadRef of the persisted `{ decision: 'rejected', … }` output. */
  outputRef: string;
  /** `when`-gated descendants to skip alongside the approve task. */
  skipDescendantTaskIds: string[];
  summary?: string;
  completedAt?: Date;
}

export type CommitRejectApproveTaskResult = 'committed' | 'claim_lost' | 'task_row_state_mismatch';

export async function commitRejectApproveTaskAndResume(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitRejectApproveTaskArgs,
): Promise<CommitRejectApproveTaskResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const runUpdate = await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        pausedReason: null,
        pausedPayloadRef: null,
      })
      .where(
        and(
          eq(workflowRuns.runId, args.runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, args.claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (runUpdate.length === 0) {
      throw new ResumeClaimLostError();
    }

    const completedAt = args.completedAt ?? new Date();
    const taskUpdate = await tx
      .update(workflowRunTasks)
      .set({
        status: 'skipped',
        outputRef: args.outputRef,
        completedAt,
        summary: args.summary ?? 'Rejected via workflow.run.resume reject (gated branch skipped).',
      })
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.taskId),
          eq(workflowRunTasks.status, 'paused'),
          eq(workflowRunTasks.attempt, args.attempt),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (taskUpdate.length !== 1) {
      throw new TaskRowStateMismatchError(args.runId, args.taskId, args.attempt);
    }

    // Skip the gated descendants. INSERT rows for the (typically rowless)
    // downstream tasks; only overwrite a NON-terminal existing row, never a
    // task that already reached a terminal status.
    for (const descendantTaskId of args.skipDescendantTaskIds) {
      await tx
        .insert(workflowRunTasks)
        .values({
          runId: args.runId,
          taskId: descendantTaskId,
          status: 'skipped',
          attempt: 0,
          completedAt,
          summary: 'Skipped — upstream approval rejected.',
        })
        .onConflictDoUpdate({
          target: [workflowRunTasks.runId, workflowRunTasks.taskId],
          set: {
            status: sql`CASE WHEN workflow_run_tasks.status NOT IN ('succeeded', 'failed', 'blocked', 'skipped') THEN 'skipped' ELSE workflow_run_tasks.status END`,
            completedAt: sql`COALESCE(workflow_run_tasks.completed_at, excluded.completed_at)`,
          },
        });
    }

    return 'committed' as const;
  }).catch((err: unknown) => {
    if (err instanceof ResumeClaimLostError) return 'claim_lost' as const;
    if (err instanceof TaskRowStateMismatchError) return 'task_row_state_mismatch' as const;
    throw err;
  });
}

export interface CommitReExecutePausedTaskArgs {
  runId: string;
  claimToken: string;
  /** The paused task whose row gets reset to running with attempt+1. */
  taskId: string;
  /**
   * CAS check on the task row's current attempt. Caller reads this from
   * the surfaced contract / live row before claiming the lease; passing
   * the wrong value rolls back as `task_row_not_paused`.
   */
  expectedAttempt: number;
  remediationNote?: string;
  parentInstructionsPatch?: Record<string, unknown>;
  descendantTaskIds?: string[];
}

export type CommitReExecutePausedTaskResult =
  'committed' | 'claim_lost' | 'task_row_not_paused' | 'at_parallel_limit';

export async function commitReExecutePausedTaskAndResume(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitReExecutePausedTaskArgs,
): Promise<CommitReExecutePausedTaskResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. Load the paused task row to capture state for the
    //    prior-failures snapshot. Locking via the CAS-on-status below.
    const rows = await tx
      .select()
      .from(workflowRunTasks)
      .where(and(eq(workflowRunTasks.runId, args.runId), eq(workflowRunTasks.taskId, args.taskId)))
      .limit(1);
    const row = rows[0];
    if (row?.status !== 'paused' || row.attempt !== args.expectedAttempt) {
      // Row missing, wrong status, or attempt drift — caller's CAS view
      // is stale. Roll back without touching the run row.
      throw new TaskRowNotPausedError(args.runId, args.taskId);
    }

    // 2. Build prior-failure snapshot. Uses the same field names
    //    `formatPriorFailuresBlock` already renders (`failedAt`,
    //    `failureReason`, etc.) so the new Runner sees the pause cause
    //    in its "PRIOR ATTEMPTS" block without formatter changes —
    //    a paused-vs-failed attempt is still "the prior attempt didn't
    //    finish successfully" from the Runner's perspective.
    //    `errorClassification: 'paused'` distinguishes the row source for
    //    audit purposes.
    const newSnapshot: Record<string, unknown> = {
      attempt: row.attempt,
      failedAt: (row.completedAt ?? new Date()).toISOString(),
      errorClassification: 'paused',
      ...(row.failureReason ? { failureReason: row.failureReason } : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      ...(args.remediationNote ? { remediationNote: args.remediationNote } : {}),
    };
    const snapshotJson = JSON.stringify(newSnapshot);

    // 3. CAS the run row: paused → running under the live claim. Same
    //    shape as commitReplaceOutputAndResume — see resume.ts:257-279.
    //    Optionally merge parentInstructionsPatch into metadata via JSONB
    //    concat (right side wins on key conflicts, other metadata keys
    //    survive). Mirrors commitProvideInputAndResume's metadata merge.
    const runSet: Record<string, unknown> = {
      status: 'running',
      completedAt: null,
      resumeClaimToken: null,
      resumeClaimExpiresAt: null,
      pausedReason: null,
      pausedPayloadRef: null,
    };
    if (args.parentInstructionsPatch) {
      const patchJson = JSON.stringify({
        parentInstructions: args.parentInstructionsPatch,
      });
      runSet['metadata'] =
        sql`COALESCE(${workflowRuns.metadata}, '{}'::jsonb) || ${patchJson}::jsonb`;
    }
    const runUpdate = await tx
      .update(workflowRuns)
      .set(runSet)
      .where(
        and(
          eq(workflowRuns.runId, args.runId),
          eq(workflowRuns.status, 'paused'),
          eq(workflowRuns.resumeClaimToken, args.claimToken),
          sql`${workflowRuns.resumeClaimExpiresAt} >= now()`,
        ),
      )
      .returning({ id: workflowRuns.id });
    if (runUpdate.length === 0) {
      throw new ResumeClaimLostError();
    }

    // A paused row holds no slot; resuming it takes one. Enforced here for the
    // same reason as retry — an over-limit call that bills on submit cannot be
    // undone by a later reservation pass.
    if (!(await hasFreeSlotForTask(tx, args.runId, args.taskId))) {
      return 'at_parallel_limit';
    }

    // 4. In-place task row UPDATE. Status to 'running' (NOT 'scheduled')
    //    to match `claimRetriedTask`'s CAS guard. Clear worker session
    //    + dispatch token + started_at + summary + failure_reason +
    //    output_ref + duration_ms — the new attempt starts with a clean
    //    row. priorFailures gets the snapshot appended.
    //
    const taskUpdate = await tx
      .update(workflowRunTasks)
      .set({
        ...awaitingDispatchPatch(),
        attempt: row.attempt + 1,
        completedAt: null,
        outputRef: null,
        summary: null,
        failureReason: null,
        durationMs: null,
        stepExecutionId: null,
        sessionId: null,
        dispatchAttemptToken: null,
        pollCycle: 1,
        priorFailures: sql`COALESCE(${workflowRunTasks.priorFailures}, '[]'::jsonb) || ${snapshotJson}::jsonb`,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.taskId),
          eq(workflowRunTasks.status, 'paused'),
          eq(workflowRunTasks.attempt, args.expectedAttempt),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (taskUpdate.length !== 1) {
      // Race: the row moved out from under us between the load and the
      // UPDATE (concurrent cancel, sweeper, etc.). Roll back the run-row
      // flip rather than leave a paused task on a running run.
      throw new TaskRowNotPausedError(args.runId, args.taskId);
    }

    await clearBlockedDescendantsForRetry(tx, args.runId, args.descendantTaskIds ?? []);

    return 'committed' as const;
  }).catch((err: unknown) => {
    if (err instanceof ResumeClaimLostError) return 'claim_lost' as const;
    if (err instanceof TaskRowNotPausedError) return 'task_row_not_paused' as const;
    throw err;
  });
}
