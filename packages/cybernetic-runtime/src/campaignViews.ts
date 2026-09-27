import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  Campaign,
  CampaignScoreSummary,
  CampaignScoreSeriesPoint,
  WorkflowCampaignView,
} from '@aflow/schemas';

import { getCampaignById, getCampaignScoreSeries, type CampaignSeriesPoint } from './campaigns.js';
import { bestScoreByDirection } from './promotion.js';

/**
 * Space-scoped campaign lookup: a campaign from another space is treated as
 * not-found (campaign ids are not a cross-space read channel). Shared by the
 * orchestrator inline-ops and the server's read REST surface so both enforce
 * the same boundary.
 */
export async function getCampaignInSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  campaignId: string,
): Promise<Campaign | null> {
  const campaign = await getCampaignById(db, tenantId, campaignId);
  if (!campaign) return null;
  return campaign.spaceId === spaceId ? campaign : null;
}

function toSeriesPoint(p: CampaignSeriesPoint): CampaignScoreSeriesPoint {
  return {
    runId: p.runId,
    score: p.score,
    startedAt: p.startedAt,
    ...(p.completedAt !== undefined ? { completedAt: p.completedAt } : {}),
  };
}

/** Direction-aware compact summary of a campaign's score series. */
export function summarizeScoreSeries(
  campaign: Campaign,
  series: readonly CampaignSeriesPoint[],
): CampaignScoreSummary {
  const best = bestScoreByDirection(
    series.map((p) => p.score),
    campaign.direction,
  );
  const latest = series[series.length - 1];
  return {
    scoredRunCount: series.length,
    ...(best !== undefined ? { bestScore: best } : {}),
    ...(latest !== undefined ? { latestScore: latest.score, latestRunId: latest.runId } : {}),
  };
}

/** Bounded tail of the series (oldest-first), for the campaign detail read. */
export function recentSeriesTail(
  series: readonly CampaignSeriesPoint[],
  limit = 20,
): CampaignScoreSeriesPoint[] {
  return series.slice(-limit).map(toSeriesPoint);
}

/**
 * How many recent scored runs the list view carries per campaign. Larger than
 * the detail-read tail so the per-campaign trajectory chart has enough points
 * to be legible; still bounded so a long campaign's list response stays small.
 */
const CAMPAIGN_VIEW_SERIES_LIMIT = 60;

/** Campaign + score summary + a bounded score series — the list/get read shape. */
export async function buildCampaignView(
  db: PostgresJsDatabase,
  tenantId: string,
  campaign: Campaign,
): Promise<WorkflowCampaignView> {
  const series = await getCampaignScoreSeries(db, tenantId, campaign.campaignId);
  return {
    campaign,
    scoreSummary: summarizeScoreSeries(campaign, series),
    recentSeries: recentSeriesTail(series, CAMPAIGN_VIEW_SERIES_LIMIT),
  };
}
