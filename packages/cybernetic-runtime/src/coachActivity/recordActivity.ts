import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { TenantId } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, coachActivity } from '@aflow/database';
import { logCyberneticError } from '../logger.js';

const PREVIEW_FAILED_COUNTER_TTL_SECONDS = 24 * 60 * 60;

/**
 * Per-Coach-session Redis counter incremented every time
 * `previewProposalApply` rejects a proposal inside the proposal-write
 * handler (§9.1 Phase 6). `handleReviewFinalize` reads + clears the
 * counter to populate `previewFailedCount` / `status` on the
 * coach_activity row. Best-effort throughout — a Redis hiccup here
 * silently leaves the count at 0.
 */
export function previewFailedCounterKey(tenantId: string, coachSessionId: string): string {
  return `coach:preview_failed_count:${tenantId}:${coachSessionId}`;
}

export async function incrementPreviewFailedCounter(
  redis: Redis,
  tenantId: string,
  coachSessionId: string,
): Promise<void> {
  try {
    const key = previewFailedCounterKey(tenantId, coachSessionId);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, PREVIEW_FAILED_COUNTER_TTL_SECONDS);
    }
  } catch {
    // best-effort
  }
}

export async function readPreviewFailedCounter(
  redis: Redis,
  tenantId: string,
  coachSessionId: string,
): Promise<number> {
  try {
    const raw = await redis.get(previewFailedCounterKey(tenantId, coachSessionId));
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

export type CoachActivityOutcome =
  | 'with_proposals'
  | 'observation_only'
  | 'learning_only'
  | 'silent'
  | 'suppressed'
  | 'preview_failed'
  | 'error';

export interface CoachActivityRecord {
  spaceId: string;
  /**
   * Coach session id for completed reviews. Suppressed reviews that
   * never start a real Coach session omit this field — they accumulate
   * naturally because Postgres UNIQUE indexes treat NULL as distinct.
   * Treated as the dedupe key when present.
   */
  coachSessionId?: string;
  skillSlug?: string;
  triggerKind: string;
  triggerCause?: string;
  outcome: CoachActivityOutcome;
  /**
   * Detail-bearing status string. Examples:
   *   `completed`
   *   `suppressed:rate_cap`
   *   `suppressed:cost_ceiling`
   *   `suppressed:dedup`
   *   `preview_failed:3`  (3 corrected attempts)
   *   `error`
   */
  status: string;
  proposalCount?: number;
  observationCount?: number;
  learningCount?: number;
  previewFailedCount?: number;
  bypassesGate?: boolean;
  costCents?: number;
  durationMs?: number;
  contextDocPath?: string;
  factsDocPath?: string;
  rationale?: string;
}

export interface CoachActivityWriterCtx {
  tenantId: string;
  db: PostgresJsDatabase;
}

/**
 * Insert (or skip-on-conflict) a Coach activity row.
 *
 * Best-effort: a write failure here must never fail the Coach review
 * itself. Logs and returns. The unique `(spaceId, coachSessionId)`
 * index makes the call idempotent.
 */
export async function recordCoachActivity(
  ctx: CoachActivityWriterCtx,
  record: CoachActivityRecord,
): Promise<void> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  try {
    await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
      tx
        .insert(coachActivity)
        .values({
          spaceId: record.spaceId,
          coachSessionId: record.coachSessionId ?? null,
          skillSlug: record.skillSlug ?? null,
          triggerKind: record.triggerKind,
          triggerCause: record.triggerCause ?? null,
          outcome: record.outcome,
          status: record.status,
          proposalCount: record.proposalCount ?? 0,
          observationCount: record.observationCount ?? 0,
          learningCount: record.learningCount ?? 0,
          previewFailedCount: record.previewFailedCount ?? 0,
          bypassesGate: record.bypassesGate ?? false,
          costCents:
            record.costCents !== undefined && record.costCents !== null
              ? String(record.costCents)
              : null,
          durationMs: record.durationMs ?? null,
          contextDocPath: record.contextDocPath ?? null,
          factsDocPath: record.factsDocPath ?? null,
          rationale: record.rationale ?? null,
        })
        .onConflictDoNothing({
          target: [coachActivity.spaceId, coachActivity.coachSessionId],
        }),
    );
  } catch (err) {
    logCyberneticError(
      `[coachActivity] Failed to record activity row for coachSessionId=${record.coachSessionId ?? '(none)'}`,
      err,
      { spaceId: record.spaceId, triggerKind: record.triggerKind, status: record.status },
    );
  }
}
