import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, isNotNull, isNull, asc, desc, sql } from 'drizzle-orm';
import type { Campaign, CampaignConfigChange, CampaignEndedReason, TenantId } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, campaigns, workflowRuns } from '@aflow/database';
import type { CampaignRow } from '@aflow/database';

function rowToCampaign(row: CampaignRow): Campaign {
  return {
    campaignId: row.id,
    spaceId: row.spaceId,
    workflowSlug: row.workflowSlug,
    goalRef: row.goalRef,
    scoreMetricKey: row.scoreMetricKey,
    direction: row.direction as 'maximize' | 'minimize',
    ...(row.config != null ? { config: row.config as Record<string, unknown> } : {}),
    ...(row.contractHash != null ? { contractHash: row.contractHash } : {}),
    ...(Array.isArray(row.configHistory) && row.configHistory.length > 0
      ? { configHistory: row.configHistory as CampaignConfigChange[] }
      : {}),
    status: row.status as 'active' | 'ended',
    startedAt: row.startedAt.toISOString(),
    ...(row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
    ...(row.endedReason ? { endedReason: row.endedReason as CampaignEndedReason } : {}),
  };
}

export interface EnsureActiveCampaignParams {
  spaceId: string;
  workflowSlug: string;
  goalRef: string;
  scoreMetricKey: string;
  direction: 'maximize' | 'minimize';
  config?: Record<string, unknown>;
  contractHash?: string;
}

export async function ensureActiveCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  params: EnsureActiveCampaignParams,
): Promise<Campaign> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const existing = await tx
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.spaceId, params.spaceId),
          eq(campaigns.workflowSlug, params.workflowSlug),
          eq(campaigns.goalRef, params.goalRef),
          eq(campaigns.status, 'active'),
        ),
      )
      .limit(1);
    if (existing[0]) return rowToCampaign(existing[0]);

    const inserted = await tx
      .insert(campaigns)
      .values({
        spaceId: params.spaceId,
        workflowSlug: params.workflowSlug,
        goalRef: params.goalRef,
        scoreMetricKey: params.scoreMetricKey,
        direction: params.direction,
        ...(params.config !== undefined ? { config: params.config } : {}),
        ...(params.contractHash !== undefined ? { contractHash: params.contractHash } : {}),
        status: 'active',
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return rowToCampaign(inserted[0]);

    // Lost the insert race — re-select the winner.
    const winner = await tx
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.spaceId, params.spaceId),
          eq(campaigns.workflowSlug, params.workflowSlug),
          eq(campaigns.goalRef, params.goalRef),
          eq(campaigns.status, 'active'),
        ),
      )
      .limit(1);
    if (winner[0]) return rowToCampaign(winner[0]);
    throw new Error(
      `ensureActiveCampaign: could not create or find campaign for ${params.workflowSlug}:${params.goalRef}`,
    );
  });
}

export async function getActiveCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  identity: { spaceId: string; workflowSlug: string; goalRef: string },
): Promise<Campaign | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.spaceId, identity.spaceId),
          eq(campaigns.workflowSlug, identity.workflowSlug),
          eq(campaigns.goalRef, identity.goalRef),
          eq(campaigns.status, 'active'),
        ),
      )
      .limit(1);
    return rows[0] ? rowToCampaign(rows[0]) : null;
  });
}

export async function getCampaignById(
  db: PostgresJsDatabase,
  tenantId: string,
  campaignId: string,
): Promise<Campaign | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    return rows[0] ? rowToCampaign(rows[0]) : null;
  });
}

export interface ListCampaignsOptions {
  spaceId: string;
  /** Filter to one skill's campaigns. */
  workflowSlug?: string;
  /** Omit for all statuses. */
  status?: 'active' | 'ended';
  /** Default 20. */
  limit?: number;
}

export async function listCampaigns(
  db: PostgresJsDatabase,
  tenantId: string,
  opts: ListCampaignsOptions,
): Promise<Campaign[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const conditions = [eq(campaigns.spaceId, opts.spaceId)];
    if (opts.workflowSlug !== undefined) {
      conditions.push(eq(campaigns.workflowSlug, opts.workflowSlug));
    }
    if (opts.status !== undefined) {
      conditions.push(eq(campaigns.status, opts.status));
    }
    const rows = await tx
      .select()
      .from(campaigns)
      .where(and(...conditions))
      .orderBy(desc(campaigns.startedAt))
      .limit(opts.limit ?? 20);
    return rows.map(rowToCampaign);
  });
}

export interface UpdateCampaignConfigParams {
  campaignId: string;
  /** The FULL merged config to persist (caller merges patch into current). */
  config: Record<string, unknown>;
  /** Ledger entry describing this change — appended to `config_history`. */
  change: CampaignConfigChange;
}

export async function updateCampaignConfig(
  db: PostgresJsDatabase,
  tenantId: string,
  params: UpdateCampaignConfigParams,
): Promise<Campaign | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(campaigns)
      .set({
        config: params.config,
        configHistory: sql`coalesce(${campaigns.configHistory}, '[]'::jsonb) || ${JSON.stringify([params.change])}::jsonb`,
      })
      .where(and(eq(campaigns.id, params.campaignId), eq(campaigns.status, 'active')))
      .returning();
    return updated[0] ? rowToCampaign(updated[0]) : null;
  });
}

export function clearCampaignMemoEntries(
  _db: PostgresJsDatabase,
  _tenantId: string,
  _campaignId: string,
  _taskIds?: readonly string[],
): Promise<string[]> {
  return Promise.resolve([]);
}

export interface CampaignSeriesPoint {
  runId: string;
  score: number;
  startedAt: string;
  completedAt?: string;
}

export async function getCampaignScoreSeries(
  db: PostgresJsDatabase,
  tenantId: string,
  campaignId: string,
): Promise<CampaignSeriesPoint[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({
        runId: workflowRuns.runId,
        score: workflowRuns.score,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      // Frozen eval-batch trials never enter the campaign trajectory —
      // different population from production runs (Plan 269 D13).
      .where(
        and(
          eq(workflowRuns.campaignId, campaignId),
          isNotNull(workflowRuns.score),
          isNull(workflowRuns.evalBatchId),
        ),
      )
      // `runId` is the stable tiebreaker — `startedAt` alone is non-deterministic
      // when runs share a timestamp, which would reorder the trajectory and
      // perturb regression detection / co-injection.
      .orderBy(asc(workflowRuns.startedAt), asc(workflowRuns.runId));
    const out: CampaignSeriesPoint[] = [];
    for (const r of rows) {
      if (r.score == null) continue;
      out.push({
        runId: r.runId,
        score: r.score,
        startedAt: r.startedAt.toISOString(),
        ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
      });
    }
    return out;
  });
}

export async function endCampaign(
  db: PostgresJsDatabase,
  tenantId: string,
  campaignId: string,
  reason: CampaignEndedReason,
): Promise<Campaign | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(campaigns)
      .set({ status: 'ended', endedAt: new Date(), endedReason: reason })
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'active')))
      .returning();
    return updated[0] ? rowToCampaign(updated[0]) : null;
  });
}
