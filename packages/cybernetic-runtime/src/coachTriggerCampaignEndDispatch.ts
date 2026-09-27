import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type { CampaignEndedReason, EntityDirectives } from '@aflow/schemas';
import { EntityDirectivesSchema } from '@aflow/schemas';
import { getCyberneticLogger } from './logger.js';
import { triggerCoachReview } from './coachTrigger.js';
import { getRunStatistics, listRecentRuns } from './ledger/queries.js';
import { loadSpaceDirectives } from './modelResolution.js';

export interface TriggerCampaignEndReviewParams {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  /** The campaign's last run — the review's anchor, not its subject. */
  runId: string;
  totalRuns: number;
  campaignId: string;
  reason: CampaignEndedReason;
  directives?: EntityDirectives;
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore?: PayloadStore;
  /** Who summoned an explicit (re-)synthesis, for the review-context audit. */
  requestedBy?: string;
  /** Caller-supplied rationale; defaults to the campaign-ended framing. */
  rationale?: string;
  /**
   * Explicit summon of a synthesis for an already-ended campaign. The natural
   * end-transition dispatch is campaign-keyed (idempotent per campaign), so a
   * re-summon needs a fresh idempotency key or it would dedupe against the
   * first synthesis. The per-skill rate cap still applies.
   */
  freshDispatch?: boolean;
}

/**
 * Dispatch the campaign-end synthesis review — the curate entry point that
 * decides what survives an ended campaign into skill scope.
 */
export async function triggerCampaignEndReview(
  params: TriggerCampaignEndReviewParams,
): Promise<string | null> {
  return triggerCoachReview({
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
    runId: params.runId,
    totalRuns: params.totalRuns,
    campaignId: params.campaignId,
    ...(params.directives ? { directives: params.directives } : {}),
    db: params.db,
    redis: params.redis,
    ...(params.payloadStore ? { payloadStore: params.payloadStore } : {}),
    ...(params.freshDispatch ? { freshDispatch: true } : {}),
    reviewContextOverrides: {
      triggerKind: 'campaign_end_review',
      rationale: params.rationale ?? `campaign ended (${params.reason})`,
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
    },
  });
}

export interface MaybeTriggerCampaignEndReviewParams {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore?: PayloadStore;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  campaignId: string;
  reason: CampaignEndedReason;
  requestedBy?: string;
  rationale?: string;
  freshDispatch?: boolean;
}

/**
 * Resolve the review anchors (the campaign's last run, run stats, space
 * directives) and dispatch the campaign-end synthesis review. Every site
 * that ends a campaign by id routes through this one resolver; sites that
 * end it from inside a run (goal-met finalize) already hold the anchors and
 * call `triggerCampaignEndReview` directly. Best-effort by design — the
 * campaign is already ended, so a failed dispatch never fails the end.
 */
export async function maybeTriggerCampaignEndReview(
  params: MaybeTriggerCampaignEndReviewParams,
): Promise<string | null> {
  const logger = getCyberneticLogger();
  const { db, redis, tenantId, spaceId, workflowSlug, campaignId, reason } = params;
  try {
    const lastRun = (
      await listRecentRuns(db, tenantId, spaceId, workflowSlug, { limit: 1, campaignId })
    )[0];
    if (!lastRun) {
      logger.debug(
        `campaignEndTrigger: campaign ${campaignId} ended with no runs — nothing to synthesize`,
      );
      return null;
    }
    const stats = await getRunStatistics(db, tenantId, spaceId, workflowSlug, {
      windowDays: 36500,
    });
    const rawDirectives = await loadSpaceDirectives(db, tenantId, spaceId);
    const directives = rawDirectives ? EntityDirectivesSchema.safeParse(rawDirectives) : null;
    return await triggerCampaignEndReview({
      tenantId,
      spaceId,
      workflowSlug,
      runId: lastRun.runId,
      totalRuns: stats.totalRuns,
      campaignId,
      reason,
      ...(directives?.success ? { directives: directives.data } : {}),
      db,
      redis,
      ...(params.payloadStore ? { payloadStore: params.payloadStore } : {}),
      ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
      ...(params.rationale ? { rationale: params.rationale } : {}),
      ...(params.freshDispatch ? { freshDispatch: true } : {}),
    });
  } catch (err) {
    logger.warn(
      `campaignEndTrigger: dispatch failed for campaign=${campaignId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
