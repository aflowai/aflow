import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRunCompletionPending,
  workflowRunTasks,
} from '@aflow/database';
import { getCyberneticLogger } from '../logger.js';
import { awaitingDispatchPatch } from './dispatchArming.js';
import { hasFreeSlotForTask } from './concurrencySlots.js';

/**
 * Appended to a producer's `prior_failures` each time a downstream consumer
 * rejects its output and triggers a re-run. Powers `maxProducerReruns` budget
 * accounting (via `countProducerReruns`) and the `formatPriorFailuresBlock`
 * prompt the re-run producer sees.
 */
export interface ProducerRerunProvenance {
  kind: 'producer_contract_rerun';
  /**
   * ISO timestamp of the failure that triggered this rerun. Required by the
   * shared `WorkflowTaskPriorFailureSchema` (the run-detail response DTO), so
   * a rerun entry without it fails response serialization on `workflow.run.detail`.
   */
  failedAt: string;
  /** The downstream consumer whose contract the producer's output violated. */
  consumerTaskId: string;
  /** The consumer's local binding name (`source.bindAs`). */
  bindAs: string;
  /** The re-run producer task id (budget-key component). */
  producerTaskId: string;
  /** Contract name (sub-check) that failed — audit only, not a budget-key component. */
  contractName?: string;
  /** Producer attempt being superseded (matches the `attempt` field convention). */
  attempt: number;
  /** Human-readable summary rendered by `formatPriorFailuresBlock`. */
  failureReason?: string;
}

/**
 * Reruns already spent for a `(consumerTaskId, bindAs, producerTaskId)` triple.
 * `contractName` is excluded from the key so a producer that trips a different
 * sub-check each rerun does not multiply its budget.
 */
export function countProducerReruns(
  priorFailures: unknown,
  match: { consumerTaskId: string; bindAs: string; producerTaskId: string },
): number {
  if (!Array.isArray(priorFailures)) return 0;
  let count = 0;
  for (const raw of priorFailures) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (
      e['kind'] === 'producer_contract_rerun' &&
      e['consumerTaskId'] === match.consumerTaskId &&
      e['bindAs'] === match.bindAs &&
      e['producerTaskId'] === match.producerTaskId
    ) {
      count += 1;
    }
  }
  return count;
}

export interface CommitProducerRerunArgs {
  runId: string;
  producerTaskId: string;
  /**
   * CAS token — the producer row must still be `succeeded` at this attempt.
   * A concurrent sibling-validator failure that already won the rerun moves
   * the row to `running`/attempt+1, so the loser's CAS misses here and the
   * caller treats it as "subsumed by a concurrent rerun".
   */
  expectedProducerAttempt: number;
  /**
   * Producer-descendant closure whose rows are cleared so the scheduler
   * re-dispatches them after the producer re-succeeds. Keyed from the producer,
   * not the failed consumer — any descendant may have consumed the stale output.
   */
  descendantTaskIds: string[];
  /** Audit + budget provenance appended to the producer's `prior_failures`. */
  provenance: ProducerRerunProvenance;
}

export type CommitProducerRerunResult =
  | { kind: 'committed'; newAttempt: number; clearedTaskIds: string[] }
  | { kind: 'producer_not_resettable' }
  | { kind: 'at_parallel_limit' };

/**
 * In one TX: CAS the producer `succeeded`@attempt → `running`@attempt+1 (clearing
 * terminal markers + appending rerun provenance), then delete every descendant
 * row and its completion_pending row so the scheduler re-dispatches a rowless
 * descendant once the producer re-succeeds. The run row is left `running`; the
 * caller dispatches the new producer attempt.
 */
export async function commitProducerRerun(
  db: PostgresJsDatabase,
  tenantId: string,
  args: CommitProducerRerunArgs,
): Promise<CommitProducerRerunResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(workflowRunTasks)
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.producerTaskId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row?.status !== 'succeeded' || row.attempt !== args.expectedProducerAttempt) {
      return { kind: 'producer_not_resettable' as const };
    }

    // Same rule as retry: re-entering `running` takes a slot, and an over-limit
    // paid call cannot be undone by a later reservation pass.
    if (!(await hasFreeSlotForTask(tx, args.runId, args.producerTaskId))) {
      return { kind: 'at_parallel_limit' as const };
    }

    const snapshotJson = JSON.stringify(args.provenance);
    const newAttempt = row.attempt + 1;

    const updated = await tx
      .update(workflowRunTasks)
      .set({
        ...awaitingDispatchPatch(),
        attempt: newAttempt,
        outputRef: null,
        summary: null,
        durationMs: null,
        completedAt: null,
        failedAt: null,
        errorCode: null,
        errorClassification: null,
        errorRetryable: null,
        failureReason: null,
        // A leftover session id would cross-attribute the rerun's thread.
        stepExecutionId: null,
        sessionId: null,
        pollCycle: 1,
        priorFailures: sql`COALESCE(${workflowRunTasks.priorFailures}, '[]'::jsonb) || ${snapshotJson}::jsonb`,
      })
      .where(
        and(
          eq(workflowRunTasks.runId, args.runId),
          eq(workflowRunTasks.taskId, args.producerTaskId),
          eq(workflowRunTasks.status, 'succeeded'),
          eq(workflowRunTasks.attempt, args.expectedProducerAttempt),
        ),
      )
      .returning({ id: workflowRunTasks.id });
    if (updated.length !== 1) {
      // Race: a concurrent path advanced the producer out from under us
      // between the select and the CAS.
      return { kind: 'producer_not_resettable' as const };
    }

    let clearedTaskIds: string[] = [];
    if (args.descendantTaskIds.length > 0) {
      const deleted = await tx
        .delete(workflowRunTasks)
        .where(
          and(
            eq(workflowRunTasks.runId, args.runId),
            inArray(workflowRunTasks.taskId, args.descendantTaskIds),
          ),
        )
        .returning({ taskId: workflowRunTasks.taskId });
      clearedTaskIds = deleted.map((r) => r.taskId);
      if (clearedTaskIds.length > 0) {
        await tx
          .delete(workflowRunCompletionPending)
          .where(
            and(
              eq(workflowRunCompletionPending.runId, args.runId),
              inArray(workflowRunCompletionPending.taskId, clearedTaskIds),
            ),
          );
      }
    }

    getCyberneticLogger().info(
      `[commitProducerRerun] re-armed producer=${args.producerTaskId} attempt ${String(row.attempt)}→${String(newAttempt)}; cleared ${String(clearedTaskIds.length)} descendant row(s)`,
      { runId: args.runId, producerTaskId: args.producerTaskId, clearedTaskIds },
    );

    return { kind: 'committed' as const, newAttempt, clearedTaskIds };
  });
}
