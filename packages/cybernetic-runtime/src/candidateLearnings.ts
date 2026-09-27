import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, asc, inArray, isNull } from 'drizzle-orm';
import type {
  CandidateLearning,
  CandidateLearningStatus,
  CompactEvalOutcome,
  TenantId,
  WorkflowLearning,
} from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  coachCandidateLearnings,
  workflowRuns,
} from '@aflow/database';
import type { CoachCandidateLearningRow } from '@aflow/database';

function rowToCandidate(row: CoachCandidateLearningRow): CandidateLearning {
  return {
    entryId: row.id,
    spaceId: row.spaceId,
    skillSlug: row.skillSlug,
    ...(row.campaignId ? { campaignId: row.campaignId } : {}),
    runId: row.runId,
    learning: row.learningJson as WorkflowLearning,
    status: row.status as CandidateLearningStatus,
    ...(row.compactEvalOutcome
      ? { compactEvalOutcome: row.compactEvalOutcome as CompactEvalOutcome }
      : {}),
    ...(row.refs ? { refs: row.refs as CandidateLearning['refs'] } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
    ...(row.coachSessionId ? { coachSessionId: row.coachSessionId } : {}),
  };
}

export interface WriteCandidateLearningsParams {
  spaceId: string;
  skillSlug: string;
  campaignId?: string;
  runId: string;
  learnings: readonly WorkflowLearning[];
  compactEvalOutcome?: CompactEvalOutcome;
}

export async function writeCandidateLearnings(
  db: PostgresJsDatabase,
  tenantId: string,
  params: WriteCandidateLearningsParams,
): Promise<CandidateLearning[]> {
  if (params.learnings.length === 0) return [];
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .insert(coachCandidateLearnings)
      .values(
        params.learnings.map((learning) => ({
          spaceId: params.spaceId,
          skillSlug: params.skillSlug,
          campaignId: params.campaignId ?? null,
          runId: params.runId,
          learningId: learning.id,
          learningJson: learning,
          status: 'pending' as const,
          ...(params.compactEvalOutcome ? { compactEvalOutcome: params.compactEvalOutcome } : {}),
        })),
      )
      .onConflictDoNothing({
        target: [coachCandidateLearnings.runId, coachCandidateLearnings.learningId],
      });

    // Re-select the canonical set for this run (`.returning()` would omit rows
    // that conflicted with an earlier write).
    const rows = await tx
      .select()
      .from(coachCandidateLearnings)
      .where(eq(coachCandidateLearnings.runId, params.runId))
      .orderBy(asc(coachCandidateLearnings.createdAt));
    return rows.map(rowToCandidate);
  });
}

export interface ListCandidatesOptions {
  status?: CandidateLearningStatus | CandidateLearningStatus[];
}

export async function listCandidatesByCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  campaignId: string,
  opts: ListCandidatesOptions = {},
): Promise<CandidateLearning[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const statusFilter = opts.status
      ? Array.isArray(opts.status)
        ? inArray(coachCandidateLearnings.status, opts.status)
        : eq(coachCandidateLearnings.status, opts.status)
      : undefined;
    const where = statusFilter
      ? and(eq(coachCandidateLearnings.campaignId, campaignId), statusFilter)
      : eq(coachCandidateLearnings.campaignId, campaignId);
    const rows = await tx
      .select()
      .from(coachCandidateLearnings)
      .where(where)
      .orderBy(asc(coachCandidateLearnings.createdAt));
    return rows.map(rowToCandidate);
  });
}

export async function listPendingCandidatesBySkill(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; skillSlug: string },
): Promise<CandidateLearning[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(coachCandidateLearnings)
      .where(
        and(
          eq(coachCandidateLearnings.spaceId, params.spaceId),
          eq(coachCandidateLearnings.skillSlug, params.skillSlug),
          isNull(coachCandidateLearnings.campaignId),
          eq(coachCandidateLearnings.status, 'pending'),
        ),
      )
      .orderBy(asc(coachCandidateLearnings.createdAt));
    return rows.map(rowToCandidate);
  });
}

export interface ResolveCandidateParams {
  entryId: string;
  status: Exclude<CandidateLearningStatus, 'pending'>;
  /** The caller's space — the resolve is scoped to candidates of this space
   *  (authorization for a cross-space write). */
  spaceId: string;
  coachSessionId?: string;
}

export async function resolveCandidate(
  db: PostgresJsDatabase,
  tenantId: string,
  params: ResolveCandidateParams,
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(coachCandidateLearnings)
      .set({
        status: params.status,
        reviewedAt: new Date(),
        ...(params.coachSessionId ? { coachSessionId: params.coachSessionId } : {}),
      })
      .where(
        and(
          eq(coachCandidateLearnings.id, params.entryId),
          eq(coachCandidateLearnings.status, 'pending'),
          eq(coachCandidateLearnings.spaceId, params.spaceId),
        ),
      )
      .returning({ id: coachCandidateLearnings.id });
    return updated.length > 0;
  });
}

export interface ResolveCandidateByNaturalKeyParams {
  runId: string;
  learningId: string;
  status: Exclude<CandidateLearningStatus, 'pending'>;
  /** The caller's space — the run must belong to it (authorization). */
  spaceId: string;
  coachSessionId?: string;
}

export interface ResolveCandidateByNaturalKeyResult {
  /** False when the entry was already resolved, or the identity is unknown. */
  applied: boolean;
  /** Present whenever a candidate row exists (or was just created). */
  entry?: {
    entryId: string;
    campaignId?: string;
    skillSlug: string;
    learning: WorkflowLearning;
    status: CandidateLearningStatus;
  };
}

/**
 * Resolve a candidate by its natural key `(runId, learningId)`, with upsert
 * (tombstone) semantics: when no ledger row exists yet — the post-run hooks
 * are async and may not have materialized it — the resolution INSERTS the row
 * directly with the resolved status, hydrating the learning from the run's
 * durable `learnings_json`. The hooks' later insert carries
 * `onConflictDoNothing` on the identity index, so a pre-row resolution is
 * preserved, never overwritten back to pending.
 */
export async function resolveCandidateByNaturalKey(
  db: PostgresJsDatabase,
  tenantId: string,
  params: ResolveCandidateByNaturalKeyParams,
): Promise<ResolveCandidateByNaturalKeyResult> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const runRows = await tx
      .select({
        spaceId: workflowRuns.spaceId,
        workflowSlug: workflowRuns.workflowSlug,
        campaignId: workflowRuns.campaignId,
        learningsJson: workflowRuns.learningsJson,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, params.runId))
      .limit(1);
    const run = runRows[0];
    if (run?.spaceId !== params.spaceId) return { applied: false };
    const campaignId = run.campaignId;

    const identityWhere = and(
      eq(coachCandidateLearnings.runId, params.runId),
      eq(coachCandidateLearnings.learningId, params.learningId),
    );
    const entryOf = (
      row: { id: string; learningJson: unknown },
      status: CandidateLearningStatus,
    ) => ({
      entryId: row.id,
      ...(campaignId ? { campaignId } : {}),
      skillSlug: run.workflowSlug,
      learning: row.learningJson as WorkflowLearning,
      status,
    });

    const updatePending = () =>
      tx
        .update(coachCandidateLearnings)
        .set({
          status: params.status,
          reviewedAt: new Date(),
          ...(params.coachSessionId ? { coachSessionId: params.coachSessionId } : {}),
        })
        .where(and(identityWhere, eq(coachCandidateLearnings.status, 'pending')))
        .returning({
          id: coachCandidateLearnings.id,
          learningJson: coachCandidateLearnings.learningJson,
        });

    let updated = await updatePending();
    if (updated.length === 0) {
      const recorded = Array.isArray(run.learningsJson)
        ? (run.learningsJson as WorkflowLearning[])
        : [];
      const learning = recorded.find((l) => l.id === params.learningId);
      if (learning) {
        const inserted = await tx
          .insert(coachCandidateLearnings)
          .values({
            spaceId: run.spaceId,
            skillSlug: run.workflowSlug,
            campaignId: campaignId ?? null,
            runId: params.runId,
            learningId: params.learningId,
            learningJson: learning,
            status: params.status,
            reviewedAt: new Date(),
            ...(params.coachSessionId ? { coachSessionId: params.coachSessionId } : {}),
          })
          .onConflictDoNothing({
            target: [coachCandidateLearnings.runId, coachCandidateLearnings.learningId],
          })
          .returning({
            id: coachCandidateLearnings.id,
            learningJson: coachCandidateLearnings.learningJson,
          });
        const insertedRow = inserted[0];
        if (insertedRow) return { applied: true, entry: entryOf(insertedRow, params.status) };
        // Lost the insert race to the hook's pending write — resolve that row.
        updated = await updatePending();
      }
    }
    const updatedRow = updated[0];
    if (updatedRow) return { applied: true, entry: entryOf(updatedRow, params.status) };

    const existing = await tx
      .select({
        id: coachCandidateLearnings.id,
        learningJson: coachCandidateLearnings.learningJson,
        status: coachCandidateLearnings.status,
      })
      .from(coachCandidateLearnings)
      .where(identityWhere)
      .limit(1);
    const existingRow = existing[0];
    return existingRow
      ? {
          applied: false,
          entry: entryOf(existingRow, existingRow.status as CandidateLearningStatus),
        }
      : { applied: false };
  });
}
