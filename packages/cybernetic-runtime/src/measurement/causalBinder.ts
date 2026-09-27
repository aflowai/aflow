import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { eq, and, isNull, lte, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  causalMeasurements,
  workflowRuns,
} from '@aflow/database';
import { appendEntityEvent } from '@aflow/redis';
import { getCyberneticLogger } from '../logger.js';
import { parseRunEvaluationEnvelope } from '../runEvaluationEnvelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CausalBinderContext {
  tenantId: string;
  spaceId: string;
  db: PostgresJsDatabase;
  redis: Redis;
}

export interface RatifiedProposalInfo {
  proposalId: string;
  subjectKind: string;
  subjectId: string;
  ratifiedAt: Date;
  /** Causal window duration in ms. */
  windowMs: number;
  issueCategory?: string;
}

// ---------------------------------------------------------------------------
// 1. On proposal ratified
// ---------------------------------------------------------------------------

/**
 * Create a causal_measurements row when a proposal is ratified.
 * Computes baseline_metrics from completed runs in the baseline window.
 */
export async function onProposalRatified(
  ctx: CausalBinderContext,
  info: RatifiedProposalInfo,
): Promise<void> {
  const logger = getCyberneticLogger();
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  const baselineStart = new Date(info.ratifiedAt.getTime() - info.windowMs);
  const baselineEnd = info.ratifiedAt;
  const postStart = info.ratifiedAt;
  const postEnd = new Date(info.ratifiedAt.getTime() + info.windowMs);

  // Compute baseline metrics from completed runs in the baseline window
  let baselineMetrics: Record<string, unknown> | null = null;
  try {
    const runs = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
      tx
        .select({
          evaluationJson: workflowRuns.evaluationJson,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.spaceId, ctx.spaceId),
            eq(workflowRuns.workflowSlug, info.subjectId),
            eq(workflowRuns.status, 'completed'),
            sql`${workflowRuns.completedAt} >= ${baselineStart}`,
            sql`${workflowRuns.completedAt} <= ${baselineEnd}`,
          ),
        ),
    );

    if (runs.length > 0) {
      const scores = runs
        .map((r) => parseRunEvaluationEnvelope(r.evaluationJson)?.summary?.scores.overall)
        .filter((s): s is number => s !== undefined);

      if (scores.length > 0) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        baselineMetrics = {
          avgOverall: avg,
          sampleCount: scores.length,
          scores,
        };
      }
    }
  } catch (err) {
    logger.warn(
      `[causalBinder] Failed to compute baseline for ${info.proposalId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Insert the row
  try {
    await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
      tx
        .insert(causalMeasurements)
        .values({
          spaceId: ctx.spaceId,
          proposalId: info.proposalId,
          subjectKind: info.subjectKind,
          subjectId: info.subjectId,
          ratifiedAt: info.ratifiedAt,
          baselineWindowStart: baselineStart,
          baselineWindowEnd: baselineEnd,
          postWindowStart: postStart,
          postWindowEnd: postEnd,
          baselineMetrics,
          metadata: info.issueCategory ? { issueCategory: info.issueCategory } : {},
        })
        .onConflictDoNothing(),
    );

    logger.info(
      `[causalBinder] Created measurement for proposal ${info.proposalId} ` +
        `(subject: ${info.subjectKind}/${info.subjectId})`,
    );
  } catch (err) {
    logger.warn(
      `[causalBinder] Failed to insert measurement for ${info.proposalId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. On eval completed — update post_metrics for matching open windows
// ---------------------------------------------------------------------------

/**
 * When an eval completes, update `post_metrics` for any open causal
 * measurement whose subject matches.
 */
export async function onEvalCompleted(
  ctx: CausalBinderContext,
  evalInfo: {
    workflowSlug: string;
    overallScore: number;
    evaluatedAt: Date;
  },
): Promise<void> {
  const logger = getCyberneticLogger();
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  try {
    // Find open measurements for this skill
    const openMeasurements = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(causalMeasurements)
        .where(
          and(
            eq(causalMeasurements.spaceId, ctx.spaceId),
            eq(causalMeasurements.subjectId, evalInfo.workflowSlug),
            isNull(causalMeasurements.deltaComputedAt),
          ),
        ),
    );

    for (const m of openMeasurements) {
      // Check if eval is within the post window
      if (m.postWindowEnd && evalInfo.evaluatedAt > m.postWindowEnd) {
        continue;
      }
      if (evalInfo.evaluatedAt < m.postWindowStart) {
        continue;
      }

      // Update post_metrics incrementally
      const existing = (m.postMetrics ?? {}) as Record<string, unknown>;
      const scoresRaw = existing['scores'];
      const existingScores: number[] = Array.isArray(scoresRaw) ? (scoresRaw as number[]) : [];
      const updatedScores = [...existingScores, evalInfo.overallScore];
      const avg = updatedScores.reduce((a, b) => a + b, 0) / updatedScores.length;

      await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
        tx
          .update(causalMeasurements)
          .set({
            postMetrics: {
              avgOverall: avg,
              sampleCount: updatedScores.length,
              scores: updatedScores,
            },
          })
          .where(eq(causalMeasurements.id, m.id)),
      );

      logger.debug(
        `[causalBinder] Updated post_metrics for proposal ${m.proposalId} ` +
          `(${updatedScores.length} scores, avg=${avg.toFixed(3)})`,
      );
    }
  } catch (err) {
    logger.warn(
      `[causalBinder] Failed to update post_metrics: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Finalize expired windows
// ---------------------------------------------------------------------------

/**
 * Sweep for measurements whose post window has elapsed, compute delta,
 * set `delta_computed_at`, emit `entity.causal.measured`.
 */
export async function finalizeExpiredWindows(ctx: CausalBinderContext): Promise<number> {
  const logger = getCyberneticLogger();
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const now = new Date();
  let finalized = 0;

  try {
    const expired = await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
      tx
        .select()
        .from(causalMeasurements)
        .where(
          and(
            eq(causalMeasurements.spaceId, ctx.spaceId),
            isNull(causalMeasurements.deltaComputedAt),
            lte(causalMeasurements.postWindowEnd, now),
          ),
        ),
    );

    for (const m of expired) {
      const baseline = (m.baselineMetrics ?? {}) as Record<string, unknown>;
      const post = (m.postMetrics ?? {}) as Record<string, unknown>;
      const baselineAvgRaw = baseline['avgOverall'];
      const postAvgRaw = post['avgOverall'];
      const baselineAvg = typeof baselineAvgRaw === 'number' ? baselineAvgRaw : 0;
      const postAvg = typeof postAvgRaw === 'number' ? postAvgRaw : 0;
      const delta = postAvg - baselineAvg;

      await withTenantSchema(ctx.db, tenantCtx, async (tx) =>
        tx
          .update(causalMeasurements)
          .set({ deltaComputedAt: now })
          .where(eq(causalMeasurements.id, m.id)),
      );

      // Emit entity.causal.measured
      try {
        await appendEntityEvent(ctx.redis, {
          tenantId: ctx.tenantId,
          spaceId: ctx.spaceId,
          event: {
            eventId: randomUUID(),
            eventType: 'entity.causal.measured',
            spaceId: ctx.spaceId,
            tenantId: ctx.tenantId,
            timestamp: Date.now(),
            operatingMode: 'supervisory',
            payload: {
              proposalId: m.proposalId,
              subjectId: m.subjectId,
              subjectKind: m.subjectKind,
              baselineAvg,
              postAvg,
              delta,
              baselineSamples:
                typeof baseline['sampleCount'] === 'number' ? baseline['sampleCount'] : 0,
              postSamples: typeof post['sampleCount'] === 'number' ? post['sampleCount'] : 0,
            },
            summary: `Causal measurement: proposal ${m.proposalId} delta=${delta > 0 ? '+' : ''}${delta.toFixed(3)}`,
          },
        });
      } catch {
        // Best-effort
      }

      finalized++;
      logger.info(
        `[causalBinder] Finalized measurement for proposal ${m.proposalId}: ` +
          `baseline=${baselineAvg.toFixed(3)} post=${postAvg.toFixed(3)} delta=${delta > 0 ? '+' : ''}${delta.toFixed(3)}`,
      );
    }
  } catch (err) {
    logger.warn(
      `[causalBinder] Failed to finalize windows: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return finalized;
}
