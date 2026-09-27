import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { StreamKeys } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  type getConnection,
  cascadeDeleteSpace,
  previewCascadeForSpace,
  spaces,
  agentSchedules,
  webhookEndpoints,
  workflowRuns,
  sessions,
  tenantAuditLog,
} from '@aflow/database';
import { getCyberneticLogger } from './logger.js';

/** Raw postgres-js client type, derived without a direct `postgres` dep.
 *  Purge needs a raw tx client because the FK-ordered cascade
 *  (`cascadeDeleteSpace`) is hand-written SQL, not drizzle. */
type PostgresSql = ReturnType<typeof getConnection>;

// ============================================================================
// Errors
// ============================================================================

export type SpaceLifecycleErrorCode =
  | 'SPACE_NOT_FOUND'
  | 'SPACE_NOT_ARCHIVED'
  | 'SPACE_GENERAL_PROTECTED'
  | 'SPACE_HAS_ACTIVE_SESSIONS'
  | 'SPACE_HAS_LIVE_SESSIONS'
  | 'SPACE_HAS_ACTIVE_RUNS'
  | 'SPACE_HAS_LIVE_RUNS'
  | 'SPACE_GENERAL_MISSING'
  | 'SPACE_NAME_MISMATCH';

export class SpaceLifecycleError extends Error {
  readonly code: SpaceLifecycleErrorCode;
  readonly details: Record<string, unknown>;
  constructor(
    code: SpaceLifecycleErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SpaceLifecycleError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Context
// ============================================================================

export interface SpaceLifecycleContext {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: string;
  /** Actor who initiated the op. Recorded in audit-log entries when written. */
  actorUserId?: string | null;
  /**
   * Raw postgres-js client backing the same pool as `db`. Required only by
   * `purgeSpace` / `previewSpacePurge` — the FK-ordered cascade is
   * hand-written SQL that needs a raw tx client, not drizzle. archive /
   * unarchive / preview-archive ignore this field.
   */
  sql?: PostgresSql;
}

// ============================================================================
// Constants
// ============================================================================

const GENERAL_SLUG = 'general';

/** Sessions in these statuses are considered active for archive-blocking. */
const ACTIVE_SESSION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'WAITING_ON_CHILD',
  'CANCELLING',
] as const;

/** Status codes that force-archive treats as POTENTIALLY live (subject to
 *  the staleness gate below). RUNNING means an executor reported it was
 *  mid-step; CANCELLING means cancellation is in flight. Both can get
 *  stuck if the executor crashed mid-flight, leaving the row at this
 *  status forever. The staleness gate uses `lastUpdatedAt` to tell apart
 *  genuinely-running sessions from corpses. */
const POTENTIALLY_LIVE_SESSION_STATUSES = new Set(['RUNNING', 'CANCELLING']);

/** Workflow runs in these statuses block archive. */
const ACTIVE_WORKFLOW_RUN_STATUSES = ['running', 'paused'] as const;

/** Runs that might be in-flight (subject to staleness gate). */
const POTENTIALLY_LIVE_WORKFLOW_RUN_STATUSES = new Set(['running']);

/** A session/run is treated as live for force purposes only if it had
 *  activity within this window. Mirrors `runLiveness.ts` 5-min default —
 *  any executor that hasn't checked in in 5 min is considered orphaned. */
const SESSION_STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ============================================================================

const SPACE_ARCHIVED_CACHE_KEY_PREFIX = 'space:archived:';

export async function invalidateSpaceArchivedCache(redis: Redis, spaceId: string): Promise<void> {
  await redis.del(`${SPACE_ARCHIVED_CACHE_KEY_PREFIX}${spaceId}`);
}

// ============================================================================
// Redis-hot active-session probe (§4.4)
//
// Sessions live in Redis hot state during execution and only flush to
// Postgres on terminal status. A Postgres-only probe would miss
// `RUNNING`/`QUEUED`/`WAITING_ON_CHILD`/`CANCELLING` sessions that haven't
// yet flushed. The probe queries both:
//
//   - Redis: SCAN `aflow:session:{tenantId}:*:state`, parse each,
//     filter by `spaceId === target AND status IN active`.
//   - Postgres: SELECT FROM sessions WHERE space_id = target AND
//     status IN active.
//
// Returns the UNION of session IDs. Per-source tagging lets the
// operator-facing error tell them which side flagged the session.
// ============================================================================

export interface ActiveSessionDetail {
  sessionId: string;
  status: string;
  source: 'redis' | 'postgres';
  /** Epoch ms of the last hot-state update. Null when the session is only
   *  visible in Postgres (Redis state TTL'd or never written) — treated as
   *  "definitely stale" by the force-archive classifier. */
  lastUpdatedAt: number | null;
}

export async function detectActiveSessionsForSpace(opts: {
  redis: Redis;
  tx: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}): Promise<ActiveSessionDetail[]> {
  const { redis, tx, tenantId, spaceId } = opts;
  const seen = new Map<string, ActiveSessionDetail>();

  // 1. Redis SCAN over `aflow:session:{tenantId}:*:state` keys.
  //    Parse each hot-state JSON, filter by spaceId + active status.
  const pattern = `aflow:session:${tenantId}:*:state`;
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (batch.length === 0) continue;
    const values = await redis.mget(...batch);
    for (let i = 0; i < batch.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      let state: {
        sessionId?: string;
        status?: string;
        spaceId?: string;
        lastUpdatedAt?: number;
      };
      try {
        state = JSON.parse(raw) as typeof state;
      } catch {
        continue;
      }
      if (state.spaceId !== spaceId) continue;
      if (!state.sessionId || !state.status) continue;
      if (!(ACTIVE_SESSION_STATUSES as readonly string[]).includes(state.status)) continue;
      seen.set(state.sessionId, {
        sessionId: state.sessionId,
        status: state.status,
        source: 'redis',
        lastUpdatedAt: typeof state.lastUpdatedAt === 'number' ? state.lastUpdatedAt : null,
      });
    }
  } while (cursor !== '0');

  // 2. Postgres backstop. Catches PAUSED sessions already flushed to
  //    Postgres (Redis state may have expired its TTL by then). No
  //    `lastUpdatedAt` column on the row, so we set it to null — the
  //    classifier treats null as "definitely stale" since a Postgres-only
  //    session means Redis hot-state expired (~24h TTL by default).
  const pgRows = await tx
    .select({ sessionId: sessions.sessionId, status: sessions.status })
    .from(sessions)
    .where(
      and(
        eq(sessions.spaceId, spaceId),
        inArray(sessions.status, ACTIVE_SESSION_STATUSES as unknown as string[]),
      ),
    );
  for (const r of pgRows) {
    if (seen.has(r.sessionId)) continue; // Redis already accounted for it.
    seen.set(r.sessionId, {
      sessionId: r.sessionId,
      status: r.status,
      source: 'postgres',
      lastUpdatedAt: null,
    });
  }

  return [...seen.values()];
}

// ============================================================================
// Internal helpers
// ============================================================================

interface SpaceRowSnapshot {
  id: string;
  slug: string;
  ownerId: string | null;
  archivedAt: Date | null;
}

/**
 * FOR UPDATE lock on the `spaces` row — the §4.5 sentinel. Every write
 * path that creates work in the space takes the same lock so archive
 * serializes against new session-starts, run-starts, and schedule-fires.
 *
 * Includes archived rows so unarchive can lock them too.
 */
async function lockSpaceRow(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<SpaceRowSnapshot | null> {
  const [row] = await tx
    .select({
      id: spaces.id,
      slug: spaces.slug,
      ownerId: spaces.ownerId,
      archivedAt: spaces.archivedAt,
    })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .for('update')
    .limit(1);
  return row ?? null;
}

async function countActiveWorkflowRuns(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<{ count: number; runIds: string[] }> {
  const rows = await tx
    .select({ runId: workflowRuns.runId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.spaceId, spaceId),
        inArray(workflowRuns.status, ACTIVE_WORKFLOW_RUN_STATUSES as unknown as string[]),
      ),
    );
  return { count: rows.length, runIds: rows.map((r) => r.runId) };
}

async function countSpaceMembers(tx: PostgresJsDatabase, spaceId: string): Promise<number> {
  // space_memberships lives in the public schema. Use raw SQL with the
  // fully-qualified name so it works under withTenantSchema's search_path.
  const result = await tx.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM public.space_memberships WHERE space_id = ${spaceId}
  `);
  const rows = result as unknown as Array<{ c: number }>;
  return rows[0]?.c ?? 0;
}

async function writeAuditLog(
  tx: PostgresJsDatabase,
  params: {
    spaceId: string;
    actorUserId: string | null | undefined;
    action: 'space.archived' | 'space.unarchived';
    details: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(tenantAuditLog).values({
    actorId: params.actorUserId ?? null,
    actorKind: params.actorUserId ? 'human' : 'system',
    category: 'admin',
    action: params.action,
    outcome: 'success',
    resourceType: 'space',
    resourceId: params.spaceId,
    spaceId: params.spaceId,
    details: params.details,
  });
}

// ============================================================================
// archiveSpace
// ============================================================================

export interface ArchiveSpaceOptions {
  /** Free-text reason persisted in tenant_audit_log.details. */
  reason?: string;
  /**
   * When true, force-cancel **stalled** active sessions and runs in the
   * same tx instead of blocking. Stalled = sessions in PAUSED / QUEUED /
   * WAITING_ON_CHILD (not actively executing); runs in 'paused'. Refuses
   * if any session is RUNNING/CANCELLING or any run is 'running' — those
   * are genuinely in-flight and need to be cancelled deliberately.
   */
  force?: boolean;
}

export interface ArchiveSpaceResult {
  spaceId: string;
  archivedAt: string;
  pausedScheduleCount: number;
  pausedWebhookCount: number;
  memberCount: number;
  tenantDefaultSpaceUpdated: boolean;
  /** Sessions force-cancelled by this archive (only populated when force=true). */
  forceCancelledSessionIds: string[];
  /** Workflow runs force-cancelled by this archive. */
  forceCancelledRunIds: string[];
}

export async function archiveSpace(
  ctx: SpaceLifecycleContext,
  spaceId: string,
  opts: ArchiveSpaceOptions = {},
): Promise<ArchiveSpaceResult> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    // 1. Lock the spaces row + read snapshot. Includes archived rows for
    //    idempotent re-archive.
    const space = await lockSpaceRow(tx, spaceId);
    if (!space) {
      throw new SpaceLifecycleError(
        'SPACE_NOT_FOUND',
        `Space '${spaceId}' not found in tenant '${ctx.tenantId}'.`,
      );
    }

    // 2. Idempotency — already archived returns the existing archivedAt.
    if (space.archivedAt) {
      return {
        spaceId,
        archivedAt: space.archivedAt.toISOString(),
        pausedScheduleCount: 0,
        pausedWebhookCount: 0,
        memberCount: 0,
        tenantDefaultSpaceUpdated: false,
        forceCancelledSessionIds: [],
        forceCancelledRunIds: [],
      };
    }

    // 3. General-space protection.
    if (space.slug === GENERAL_SLUG) {
      throw new SpaceLifecycleError(
        'SPACE_GENERAL_PROTECTED',
        `The General space cannot be archived — it is the tenant's fallback for users without explicit memberships.`,
      );
    }

    // 4. Active-work probe — Redis-hot UNION Postgres.
    const activeSessions = await detectActiveSessionsForSpace({
      redis: ctx.redis,
      tx,
      tenantId: ctx.tenantId,
      spaceId,
    });
    const forceCancelledSessionIds: string[] = [];
    if (activeSessions.length > 0) {
      if (!opts.force) {
        throw new SpaceLifecycleError(
          'SPACE_HAS_ACTIVE_SESSIONS',
          `Space '${spaceId}' has ${String(activeSessions.length)} active session(s). ` +
            `Cancel them, or call archive with force=true to cancel STALLED sessions ` +
            `(PAUSED / QUEUED / WAITING_ON_CHILD; refuses if any are RUNNING or CANCELLING).`,
          { sessions: activeSessions },
        );
      }
      // force=true — split into live (refuse) vs stalled (cancel).
      // A session is "live" only if its status is RUNNING/CANCELLING AND
      // it had a hot-state update within the staleness threshold.
      // RUNNING sessions whose executor crashed (no recent lastUpdatedAt)
      // are bucketed with stalled and force-cancelled.
      const nowMs = Date.now();
      const isLive = (s: ActiveSessionDetail): boolean => {
        if (!POTENTIALLY_LIVE_SESSION_STATUSES.has(s.status)) return false;
        // Postgres-only (Redis state TTL'd) → definitely stale.
        if (s.lastUpdatedAt === null) return false;
        return nowMs - s.lastUpdatedAt < SESSION_STALE_THRESHOLD_MS;
      };
      const live = activeSessions.filter(isLive);
      const stalled = activeSessions.filter((s) => !isLive(s));
      if (live.length > 0) {
        throw new SpaceLifecycleError(
          'SPACE_HAS_LIVE_SESSIONS',
          `Space '${spaceId}' has ${String(live.length)} live session(s) that force-archive ` +
            `cannot cancel: ${live.map((s) => `${s.sessionId} (${s.status})`).join(', ')}. ` +
            `Cancel them deliberately before archiving.`,
          { liveSessions: live, stalledSessions: stalled.map((s) => s.sessionId) },
        );
      }
      // All active sessions are stalled — cancel them.
      for (const s of stalled) {
        // sessions table has no updated_at — only started_at / ended_at.
        await tx.execute(sql`
          UPDATE ${sessions}
            SET status = 'CANCELLED', ended_at = NOW()
            WHERE session_id = ${s.sessionId}::uuid
              AND status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
        `);
        forceCancelledSessionIds.push(s.sessionId);
        // Drop Redis hot-state so the orchestrator stops trying to process it.
        await ctx.redis.del(StreamKeys.sessionStateKey(ctx.tenantId, s.sessionId));
      }
      getCyberneticLogger().info('space: force-cancelled stalled sessions for archive', {
        spaceId,
        cancelledSessionIds: forceCancelledSessionIds,
      });
    }

    const activeRuns = await countActiveWorkflowRuns(tx, spaceId);
    const forceCancelledRunIds: string[] = [];
    if (activeRuns.count > 0) {
      if (!opts.force) {
        throw new SpaceLifecycleError(
          'SPACE_HAS_ACTIVE_RUNS',
          `Space '${spaceId}' has ${String(activeRuns.count)} active workflow run(s). ` +
            `Cancel them, or call archive with force=true to cancel paused runs ` +
            `(refuses any 'running' run).`,
          { runIds: activeRuns.runIds },
        );
      }
      // force=true — bucket runs by status + staleness. A 'running' run is
      // only "live" if its scheduler cursor is recent. Stuck rows (executor
      // crashed, scheduler never advanced) get bucketed with stalled.
      const runDetails = await tx
        .select({
          runId: workflowRuns.runId,
          status: workflowRuns.status,
          startedAt: workflowRuns.startedAt,
          schedulerCursorAt: workflowRuns.schedulerCursorAt,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.spaceId, spaceId),
            inArray(workflowRuns.status, ACTIVE_WORKFLOW_RUN_STATUSES as unknown as string[]),
          ),
        );
      const nowMs = Date.now();
      const isRunLive = (r: (typeof runDetails)[number]): boolean => {
        if (!POTENTIALLY_LIVE_WORKFLOW_RUN_STATUSES.has(r.status)) return false;
        // Use scheduler cursor when present, fall back to startedAt.
        const referenceTime = (r.schedulerCursorAt ?? r.startedAt).getTime();
        return nowMs - referenceTime < SESSION_STALE_THRESHOLD_MS;
      };
      const liveRuns = runDetails.filter(isRunLive);
      const stalledRuns = runDetails.filter((r) => !isRunLive(r));
      if (liveRuns.length > 0) {
        throw new SpaceLifecycleError(
          'SPACE_HAS_LIVE_RUNS',
          `Space '${spaceId}' has ${String(liveRuns.length)} run(s) actively executing: ` +
            `${liveRuns.map((r) => r.runId).join(', ')}. Cancel them deliberately before archiving.`,
          { liveRuns, stalledRuns: stalledRuns.map((r) => r.runId) },
        );
      }
      for (const r of stalledRuns) {
        await tx.execute(sql`
          UPDATE ${workflowRuns}
            SET status = 'cancelled',
                completed_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) ||
                  ${JSON.stringify({ cancelledByArchive: true, archivedSpaceId: spaceId, cancelledAt: new Date().toISOString() })}::jsonb
            WHERE run_id = ${r.runId}
              AND status IN ('running', 'paused')
        `);
        forceCancelledRunIds.push(r.runId);
      }
      getCyberneticLogger().info('space: force-cancelled stalled runs for archive', {
        spaceId,
        cancelledRunIds: forceCancelledRunIds,
      });
    }

    await tx.execute(sql`DELETE FROM api_definitions WHERE space_id = ${spaceId}::uuid`);
    await tx.execute(sql`DELETE FROM api_bindings WHERE space_id = ${spaceId}::uuid`);
    await tx.execute(sql`DELETE FROM api_credentials WHERE space_id = ${spaceId}::uuid`);
    // oauth_tokens is owner-keyed (no space_id). A single-space archive removes
    // only space-owned tokens; user/tenant tokens survive (Plan 185 O2). owner_id
    // is text; spaceId is a uuid string. oauth_state carries space_id directly.
    await tx.execute(
      sql`DELETE FROM oauth_tokens WHERE owner_scope = 'space' AND owner_id = ${spaceId}`,
    );
    await tx.execute(sql`DELETE FROM oauth_state WHERE space_id = ${spaceId}::uuid`);
    await tx.execute(sql`DELETE FROM mcp_server_bindings WHERE space_id = ${spaceId}::uuid`);
    await tx.execute(sql`DELETE FROM mcp_server_definitions WHERE space_id = ${spaceId}::uuid`);

    // 6. Set archived_at on the spaces row.
    const now = new Date();
    await tx.update(spaces).set({ archivedAt: now, updatedAt: now }).where(eq(spaces.id, spaceId));

    // 6. Pause active schedules with archive provenance tag.
    //    ScheduleStatusSchema = 'active'|'paused'|'expired'|'deleted' — we
    //    use 'paused' (matching enum). metadata.disabledByArchive=true
    //    distinguishes archive-paused from operator-paused for unarchive.
    const pausedSchedules = await tx
      .update(agentSchedules)
      .set({
        status: 'paused',
        metadata: sql`COALESCE(${agentSchedules.metadata}, '{}'::jsonb) || '{"disabledByArchive": true}'::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(agentSchedules.spaceId, spaceId), eq(agentSchedules.status, 'active')))
      .returning({ id: agentSchedules.id });

    // 7. Pause active webhooks (same pattern, requires migration 69 column).
    //    WebhookStatusSchema = 'active'|'paused'.
    const pausedWebhooks = await tx
      .update(webhookEndpoints)
      .set({
        status: 'paused',
        metadata: sql`COALESCE(${webhookEndpoints.metadata}, '{}'::jsonb) || '{"disabledByArchive": true}'::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(webhookEndpoints.spaceId, spaceId), eq(webhookEndpoints.status, 'active')))
      .returning({ id: webhookEndpoints.id });

    // 8. Reassign tenants.default_space_id to General if it pointed here.
    //    Cross-schema write — public.tenants is referenced fully-qualified.
    //    If the General space is missing entirely (degenerate tenant),
    //    fail loudly rather than leave default_space_id null.
    let tenantDefaultSpaceUpdated = false;
    const tenantUpdate = await tx.execute<{ id: string }>(sql`
      WITH gen AS (
        SELECT id FROM ${spaces}
          WHERE slug = ${GENERAL_SLUG} AND archived_at IS NULL
          LIMIT 1
      )
      UPDATE public.tenants
        SET default_space_id = (SELECT id FROM gen)
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND default_space_id = ${spaceId}::uuid
          AND (SELECT id FROM gen) IS NOT NULL
        RETURNING tenant_id
    `);
    const tenantUpdateRows = tenantUpdate as unknown as Array<{ tenant_id: string }>;
    if (tenantUpdateRows.length > 0) {
      tenantDefaultSpaceUpdated = true;
    } else {
      // Was the tenant's default this space? If so and we didn't reassign,
      // General is missing — bail before commit.
      const [tenantRow] = (await tx.execute<{ default_space_id: string | null }>(sql`
        SELECT default_space_id FROM public.tenants WHERE tenant_id = ${ctx.tenantId}::uuid
      `)) as unknown as Array<{ default_space_id: string | null }>;
      if (tenantRow?.default_space_id === spaceId) {
        throw new SpaceLifecycleError(
          'SPACE_GENERAL_MISSING',
          `Cannot archive — this space is the tenant default and General is missing. Recreate the General space first.`,
        );
      }
    }

    // 9. Member count for audit display (rows are NOT removed).
    const memberCount = await countSpaceMembers(tx, spaceId);

    // 10. Audit log row.
    await writeAuditLog(tx, {
      spaceId,
      actorUserId: ctx.actorUserId,
      action: 'space.archived',
      details: {
        reason: opts.reason ?? null,
        pausedScheduleCount: pausedSchedules.length,
        pausedWebhookCount: pausedWebhooks.length,
        memberCount,
        tenantDefaultSpaceUpdated,
        pausedScheduleIds: pausedSchedules.map((r) => r.id),
        pausedWebhookIds: pausedWebhooks.map((r) => r.id),
        ...(opts.force ? { force: true } : {}),
        ...(forceCancelledSessionIds.length > 0 ? { forceCancelledSessionIds } : {}),
        ...(forceCancelledRunIds.length > 0 ? { forceCancelledRunIds } : {}),
      },
    });

    getCyberneticLogger().info('space: archived', {
      spaceId,
      slug: space.slug,
      pausedScheduleCount: pausedSchedules.length,
      pausedWebhookCount: pausedWebhooks.length,
      memberCount,
      tenantDefaultSpaceUpdated,
      actorUserId: ctx.actorUserId ?? null,
    });

    const result: ArchiveSpaceResult = {
      spaceId,
      archivedAt: now.toISOString(),
      pausedScheduleCount: pausedSchedules.length,
      pausedWebhookCount: pausedWebhooks.length,
      memberCount,
      tenantDefaultSpaceUpdated,
      forceCancelledSessionIds,
      forceCancelledRunIds,
    };

    invalidateSpaceArchivedCache(ctx.redis, spaceId).catch((err: unknown) => {
      getCyberneticLogger().warn('space: failed to invalidate archived-cache after archive', {
        spaceId,
        err: err instanceof Error ? err.message : String(err),
      });
    });

    return result;
  });
}

// ============================================================================
// unarchiveSpace
// ============================================================================

export interface UnarchiveSpaceResult {
  spaceId: string;
  restoredAt: string;
  /** Counts only — schedules/webhooks paused-by-archive are NOT auto-re-enabled.
   *  The operator opts back in deliberately to avoid surprise cron storms. */
  pausedByArchiveScheduleCount: number;
  pausedByArchiveWebhookCount: number;
}

export async function unarchiveSpace(
  ctx: SpaceLifecycleContext,
  spaceId: string,
): Promise<UnarchiveSpaceResult> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    const space = await lockSpaceRow(tx, spaceId);
    if (!space) {
      throw new SpaceLifecycleError(
        'SPACE_NOT_FOUND',
        `Space '${spaceId}' not found in tenant '${ctx.tenantId}'.`,
      );
    }

    // Idempotency — unarchiving an already-active space is a no-op success.
    if (!space.archivedAt) {
      return {
        spaceId,
        restoredAt: new Date().toISOString(),
        pausedByArchiveScheduleCount: 0,
        pausedByArchiveWebhookCount: 0,
      };
    }

    const now = new Date();
    await tx.update(spaces).set({ archivedAt: null, updatedAt: now }).where(eq(spaces.id, spaceId));

    // Count paused-by-archive schedules + webhooks for the response.
    // We do NOT re-enable them automatically (§4.6). Operator opts back in.
    const [scheduleRow] = (await tx.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM ${agentSchedules}
        WHERE space_id = ${spaceId}
          AND status = 'paused'
          AND metadata ->> 'disabledByArchive' = 'true'
    `)) as unknown as Array<{ c: number }>;
    const [webhookRow] = (await tx.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM ${webhookEndpoints}
        WHERE space_id = ${spaceId}
          AND status = 'paused'
          AND metadata ->> 'disabledByArchive' = 'true'
    `)) as unknown as Array<{ c: number }>;

    const pausedByArchiveScheduleCount = scheduleRow?.c ?? 0;
    const pausedByArchiveWebhookCount = webhookRow?.c ?? 0;

    await writeAuditLog(tx, {
      spaceId,
      actorUserId: ctx.actorUserId,
      action: 'space.unarchived',
      details: {
        pausedByArchiveScheduleCount,
        pausedByArchiveWebhookCount,
      },
    });

    getCyberneticLogger().info('space: unarchived', {
      spaceId,
      slug: space.slug,
      pausedByArchiveScheduleCount,
      pausedByArchiveWebhookCount,
      actorUserId: ctx.actorUserId ?? null,
    });

    const result: UnarchiveSpaceResult = {
      spaceId,
      restoredAt: now.toISOString(),
      pausedByArchiveScheduleCount,
      pausedByArchiveWebhookCount,
    };

    invalidateSpaceArchivedCache(ctx.redis, spaceId).catch((err: unknown) => {
      getCyberneticLogger().warn('space: failed to invalidate archived-cache after unarchive', {
        spaceId,
        err: err instanceof Error ? err.message : String(err),
      });
    });

    return result;
  });
}

// ============================================================================
// previewArchiveSpace — read-only dry-run (§4.2)
// ============================================================================

export interface BlockingItem {
  kind: 'session' | 'workflow_run';
  id: string;
  status: string;
}

export interface PreviewArchiveSpaceResult {
  spaceId: string;
  isGeneralSpace: boolean;
  isTenantDefaultSpace: boolean;
  activeSessionCount: number;
  activeWorkflowRunCount: number;
  activeScheduleCount: number;
  activeWebhookCount: number;
  memberCount: number;
  blockingItems: BlockingItem[];
}

export async function previewArchiveSpace(
  ctx: SpaceLifecycleContext,
  spaceId: string,
): Promise<PreviewArchiveSpaceResult> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    const [spaceRow] = await tx
      .select({ id: spaces.id, slug: spaces.slug })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);
    if (!spaceRow) {
      throw new SpaceLifecycleError(
        'SPACE_NOT_FOUND',
        `Space '${spaceId}' not found in tenant '${ctx.tenantId}'.`,
      );
    }

    const activeSessions = await detectActiveSessionsForSpace({
      redis: ctx.redis,
      tx,
      tenantId: ctx.tenantId,
      spaceId,
    });
    const activeRuns = await countActiveWorkflowRuns(tx, spaceId);

    const [scheduleCountRow] = (await tx.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM ${agentSchedules}
        WHERE space_id = ${spaceId} AND status = 'active'
    `)) as unknown as Array<{ c: number }>;
    const [webhookCountRow] = (await tx.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM ${webhookEndpoints}
        WHERE space_id = ${spaceId} AND status = 'active'
    `)) as unknown as Array<{ c: number }>;

    const memberCount = await countSpaceMembers(tx, spaceId);

    const [tenantRow] = (await tx.execute<{ default_space_id: string | null }>(sql`
      SELECT default_space_id FROM public.tenants WHERE tenant_id = ${ctx.tenantId}::uuid
    `)) as unknown as Array<{ default_space_id: string | null }>;

    const blockingItems: BlockingItem[] = [
      ...activeSessions.map<BlockingItem>((s) => ({
        kind: 'session',
        id: s.sessionId,
        status: s.status,
      })),
      ...activeRuns.runIds.map<BlockingItem>((id) => ({
        kind: 'workflow_run',
        id,
        status: 'running',
      })),
    ];

    return {
      spaceId,
      isGeneralSpace: spaceRow.slug === GENERAL_SLUG,
      isTenantDefaultSpace: tenantRow?.default_space_id === spaceId,
      activeSessionCount: activeSessions.length,
      activeWorkflowRunCount: activeRuns.count,
      activeScheduleCount: scheduleCountRow?.c ?? 0,
      activeWebhookCount: webhookCountRow?.c ?? 0,
      memberCount,
      blockingItems,
    };
  });
}

// ============================================================================
// Sentinel-lock helper for write-path defenders (§4.5)
// ============================================================================

export class SpaceArchivedError extends Error {
  readonly code = 'SPACE_ARCHIVED' as const;
  readonly spaceId: string;
  readonly archivedAt: Date;
  constructor(spaceId: string, archivedAt: Date) {
    super(
      `Space '${spaceId}' is archived (archived_at=${archivedAt.toISOString()}). ` +
        `Unarchive it before creating new work.`,
    );
    this.name = 'SpaceArchivedError';
    this.spaceId = spaceId;
    this.archivedAt = archivedAt;
  }
}

/**
 * Acquire the spaces-row sentinel lock and assert the space is active.
 * Call from session-start, run-start, schedule-fire, webhook-ingest paths.
 * Use the optional `tx` parameter to reuse an existing tenant tx.
 */
export async function assertSpaceActiveUnderLock(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: spaces.id, archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .for('update')
    .limit(1);

  if (!row) {
    throw new SpaceLifecycleError('SPACE_NOT_FOUND', `Space '${spaceId}' not found.`);
  }
  if (row.archivedAt) {
    throw new SpaceArchivedError(spaceId, row.archivedAt);
  }
}

// ============================================================================

interface PurgeSpaceRowSnapshot {
  id: string;
  slug: string;
  name: string;
  archived_at: Date | null;
}

/** Raw client guard — purge needs `ctx.sql`. Programmer error if absent
 *  (the HTTP route guards and 500s before reaching here). */
function requirePurgeSql(ctx: SpaceLifecycleContext): PostgresSql {
  if (!ctx.sql) {
    throw new Error('purgeSpace/previewSpacePurge require ctx.sql (raw postgres client).');
  }
  return ctx.sql;
}

export function assertSpacePurgeAllowed(
  space: Pick<PurgeSpaceRowSnapshot, 'slug' | 'name' | 'archived_at'>,
  opts: PurgeSpaceOptions,
): void {
  if (space.slug === GENERAL_SLUG) {
    throw new SpaceLifecycleError(
      'SPACE_GENERAL_PROTECTED',
      `The General space cannot be purged — it is the tenant's fallback for users without explicit memberships.`,
    );
  }
  if (space.archived_at === null) {
    throw new SpaceLifecycleError(
      'SPACE_NOT_ARCHIVED',
      `This space must be archived before it can be purged. Archive it first, then purge.`,
    );
  }
  if (opts.confirmName !== space.name) {
    throw new SpaceLifecycleError(
      'SPACE_NAME_MISMATCH',
      `Confirmation name did not match. Type the exact space name to purge.`,
      { expected: space.name },
    );
  }
}

export interface PreviewSpacePurgeResult {
  spaceId: string;
  name: string;
  slug: string;
  isGeneralSpace: boolean;
  /** Archive-first: the UI gates the purge button on this. */
  isArchived: boolean;
  /** Per-table row counts that purge would delete (blast-radius preview). */
  perTableCounts: Record<string, number>;
  totalRows: number;
}

/**
 * Read-only blast-radius preview for purge. Reachable on archived spaces so
 * the danger-zone dialog can populate counts + drive the name-confirm field.
 * Throws only SPACE_NOT_FOUND — non-archived / General are reported via the
 * result flags so the UI can explain why purge is disabled.
 */
export async function previewSpacePurge(
  ctx: SpaceLifecycleContext,
  spaceId: string,
): Promise<PreviewSpacePurgeResult> {
  const sqlClient = requirePurgeSql(ctx);
  const { schemaName } = createTenantContext(ctx.tenantId as TenantId);

  const rows = (await sqlClient`
    SELECT id, slug, name, archived_at
      FROM ${sqlClient(schemaName)}.spaces
      WHERE id = ${spaceId}
      LIMIT 1
  `) as unknown as PurgeSpaceRowSnapshot[];
  const row = rows[0];
  if (!row) {
    throw new SpaceLifecycleError(
      'SPACE_NOT_FOUND',
      `Space '${spaceId}' not found in tenant '${ctx.tenantId}'.`,
    );
  }

  const perTableCounts = await previewCascadeForSpace(sqlClient, schemaName, spaceId);
  const totalRows = Object.values(perTableCounts).reduce((a, b) => a + b, 0);

  return {
    spaceId,
    name: row.name,
    slug: row.slug,
    isGeneralSpace: row.slug === GENERAL_SLUG,
    isArchived: row.archived_at !== null,
    perTableCounts,
    totalRows,
  };
}

export interface PurgeSpaceOptions {
  /** Must match the space's current name exactly. The typed-confirmation gate. */
  confirmName: string;
}

export interface PurgeSpaceResult {
  spaceId: string;
  name: string;
  purgedAt: string;
  perTableCounts: Record<string, number>;
  totalRows: number;
}

export async function purgeSpace(
  ctx: SpaceLifecycleContext,
  spaceId: string,
  opts: PurgeSpaceOptions,
): Promise<PurgeSpaceResult> {
  const sqlClient = requirePurgeSql(ctx);
  const { schemaName } = createTenantContext(ctx.tenantId as TenantId);
  const actorUserId = ctx.actorUserId ?? null;

  const { name, perTableCounts } = await sqlClient.begin(async (txHandle) => {
    // postgres-js types the tx handle as `TransactionSql`, whose `Omit` drops
    // the anonymous call signatures (tagged-template + identifier helper). It
    // is callable at runtime; re-type it as `Sql` for the SQL below.
    const tx = txHandle as unknown as PostgresSql;

    // 1. Lock the spaces row + read snapshot.
    const lockRows = (await tx`
      SELECT id, slug, name, archived_at
        FROM ${tx(schemaName)}.spaces
        WHERE id = ${spaceId}
        FOR UPDATE
        LIMIT 1
    `) as unknown as PurgeSpaceRowSnapshot[];
    const space = lockRows[0];
    if (!space) {
      throw new SpaceLifecycleError(
        'SPACE_NOT_FOUND',
        `Space '${spaceId}' not found in tenant '${ctx.tenantId}'.`,
      );
    }

    // 2. Precondition gates: General-protected, archive-first, name-confirm.
    assertSpacePurgeAllowed(space, opts);

    // 3. Run the FK-ordered cascade over every space-owned table.
    const counts = await cascadeDeleteSpace(tx, schemaName, spaceId);

    // 4. Write the one surviving tenant-level purge record. space_id MUST be
    //    NULL — the cascade above already deleted `tenant_audit_log WHERE
    //    space_id = <id>`, so a space-scoped row here would be a no-op
    //    survivor only by luck of ordering; NULL makes it explicit and
    //    tenant-scoped (the §forget-me record outlives the space).
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await tx`
      INSERT INTO ${tx(schemaName)}.tenant_audit_log
        (actor_id, actor_kind, category, action, outcome, resource_type, resource_id, space_id, details)
      VALUES (
        ${actorUserId},
        ${actorUserId ? 'human' : 'system'},
        'admin',
        'space.purged',
        'success',
        'space',
        ${spaceId},
        NULL,
        ${JSON.stringify({
          spaceName: space.name,
          slug: space.slug,
          perTableCounts: counts,
          totalRows: total,
        })}::jsonb
      )
    `;

    return { name: space.name, perTableCounts: counts };
  });

  const totalRows = Object.values(perTableCounts).reduce((a, b) => a + b, 0);
  const purgedAt = new Date().toISOString();

  getCyberneticLogger().info('space: purged', {
    spaceId,
    name,
    totalRows,
    actorUserId,
  });

  // Best-effort: drop the archived-state cache key. The space is gone now, so
  // this is hygiene — downstream lookups 404 on a missing space regardless.
  invalidateSpaceArchivedCache(ctx.redis, spaceId).catch((err: unknown) => {
    getCyberneticLogger().warn('space: failed to invalidate archived-cache after purge', {
      spaceId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return { spaceId, name, purgedAt, perTableCounts, totalRows };
}
