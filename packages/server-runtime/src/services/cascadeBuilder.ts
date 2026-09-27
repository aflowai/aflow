import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, desc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { getSessionState, type SessionHotState } from '@aflow/redis';
import { createTenantContext, withTenantSchema, sessions } from '@aflow/database';
import {
  applyPartialSignalAnnotation,
  deriveLifecycleFromSignals,
  LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS,
  type LifecycleSignals,
} from '@aflow/cybernetic-runtime';
import type {
  ActiveSurfaceLifecycleReasonCode,
  ActiveSurfaceRunLifecycle,
  CascadeDetail,
  CascadeListItem,
  CascadeNode,
  CascadeSystemRole,
  TenantId,
} from '@aflow/schemas';

function inferSystemRole(agentId: string): CascadeSystemRole {
  const a = agentId.toLowerCase();
  if (a.includes('helmsman')) return 'helmsman';
  if (a.includes('runner')) return 'runner';
  if (a.includes('coach')) return 'coach';
  return 'other';
}

interface SessionRow {
  sessionId: string;
  agentId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  totalTokens: number | null;
  totalCostCents: string | null;
  spaceId: string | null;
}

function projectAgentIdLabel(row: {
  targetKind: string;
  targetSystemRole: string | null;
  targetAgentId: string | null;
}): string {
  if (row.targetKind === 'platform-role') return row.targetSystemRole ?? 'platform-role';
  if (row.targetKind === 'custom-agent') return row.targetAgentId ?? 'custom-agent';
  return 'inline-agent';
}

async function loadSessionRow(
  db: PostgresJsDatabase,
  tenantCtx: ReturnType<typeof createTenantContext>,
  sessionId: string,
): Promise<SessionRow | null> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
  });
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    agentId: projectAgentIdLabel(row),
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? null,
    totalTokens: row.totalTokens ?? 0,
    totalCostCents: row.totalCostCents != null ? row.totalCostCents : null,
    spaceId: row.spaceId ?? null,
  };
}

function deriveSessionLifecycle(
  row: SessionRow,
  hot: SessionHotState | null,
  partialSignalRead: boolean,
): { lifecycle: ActiveSurfaceRunLifecycle; reasonCode?: ActiveSurfaceLifecycleReasonCode } {
  const status = hot?.status ?? row.status;

  const terminal: 'completed' | 'failed' | 'cancelled' | null =
    status === 'SUCCEEDED'
      ? 'completed'
      : status === 'FAILED'
        ? 'failed'
        : status === 'CANCELLED'
          ? 'cancelled'
          : null;

  const pauseSource = hot?.delegationPauseSource ?? null;
  const waitingChildren = hot?.waitingForChildSessionIds ?? [];

  const isRunning = status === 'RUNNING' || status === 'QUEUED';
  const isWaitingChild = status === 'WAITING_ON_CHILD';
  const isPausedStatus = status === 'PAUSED';
  const isCancelling = status === 'CANCELLING';

  const isPausedLike = isPausedStatus || isWaitingChild;

  const sessionPauseType = hot?.pauseType ?? null;
  const directUserInputPause =
    isPausedLike && (sessionPauseType === 'user_input' || sessionPauseType === 'approval');

  // CANCELLING and the explicit hot-state flag both surface as `interrupting`.
  const interruptRequested = hot?.interruptRequested === true || isCancelling;

  const awaitingUserInput = (isPausedLike && pauseSource === 'child_input') || directUserInputPause;

  const awaitingChild =
    isWaitingChild ||
    (isPausedLike && pauseSource === 'child_running') ||
    (waitingChildren.length > 0 && !isRunning && !awaitingUserInput);

  const signals: LifecycleSignals = {
    terminal,
    interruptRequested,
    awaitingUserInput,
    awaitingChild,
    paused: isPausedStatus && !awaitingUserInput && !awaitingChild,
    hasLiveWork: isRunning,
    hasOnlyScheduledWork: false,
    schedulerStallAgeMs: 0,
    staleThresholdMs: LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS,
    partialSignalRead,
  };

  return applyPartialSignalAnnotation(deriveLifecycleFromSignals(signals), partialSignalRead);
}

async function buildNode(
  db: PostgresJsDatabase,
  redis: Redis | null,
  tenantId: string,
  tenantCtx: ReturnType<typeof createTenantContext>,
  spaceId: string,
  sessionId: string,
  visited: Set<string>,
): Promise<CascadeNode | null> {
  if (visited.has(sessionId)) return null;
  visited.add(sessionId);

  const row = await loadSessionRow(db, tenantCtx, sessionId);
  if (!row) return null;
  if (row.spaceId !== null && row.spaceId !== spaceId) return null;

  let hot: SessionHotState | null = null;
  let partialSignalRead = false;
  if (redis) {
    try {
      hot = await getSessionState(redis, tenantId, sessionId);
    } catch {
      partialSignalRead = true;
    }
  }
  const childIds = hot?.waitingForChildSessionIds ?? [];

  const children: CascadeNode[] = [];
  for (const cid of childIds) {
    const child = await buildNode(db, redis, tenantId, tenantCtx, spaceId, cid, visited);
    if (child) children.push(child);
  }

  const lifecycleResult = deriveSessionLifecycle(row, hot, partialSignalRead);

  return {
    sessionId: row.sessionId,
    agentId: row.agentId,
    systemRole: inferSystemRole(row.agentId),
    lifecycle: lifecycleResult.lifecycle,
    ...(lifecycleResult.reasonCode ? { lifecycleReasonCode: lifecycleResult.reasonCode } : {}),
    ...(lifecycleResult.lifecycle === 'unknown'
      ? { lifecycleReasonDetail: `sessions.status=${row.status}` }
      : {}),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    totalTokens: row.totalTokens ?? 0,
    totalCostCents: row.totalCostCents,
    children,
  };
}

export async function getCascadeDetail(params: {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantId: TenantId;
  spaceId: string;
  cascadeId: string;
}): Promise<CascadeDetail | null> {
  const { db, redis, tenantId, spaceId, cascadeId } = params;
  const tenantCtx = createTenantContext(tenantId);

  const root = await loadSessionRow(db, tenantCtx, cascadeId);
  if (!root) return null;
  if (root.spaceId !== null && root.spaceId !== spaceId) return null;

  const tree = await buildNode(db, redis, tenantId, tenantCtx, spaceId, cascadeId, new Set());
  if (!tree) return null;

  return {
    cascadeId,
    spaceId,
    triggerKind: 'unknown',
    rootSessionId: cascadeId,
    startedAt: root.startedAt.toISOString(),
    tree,
  };
}

export async function listRecentCascades(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  limit: number;
}): Promise<CascadeListItem[]> {
  const { db, tenantId, spaceId, limit } = params;
  const tenantCtx = createTenantContext(tenantId);

  const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
    return tx
      .select()
      .from(sessions)
      .where(eq(sessions.spaceId, spaceId))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);
  });

  return rows.map((row) => ({
    cascadeId: row.sessionId,
    rootSessionId: row.sessionId,
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    agentId: projectAgentIdLabel(row),
    totalTokens: row.totalTokens ?? 0,
  }));
}
