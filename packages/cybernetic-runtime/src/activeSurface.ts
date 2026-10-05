import { createHash } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  type ActiveSurfaceCapturedFrom,
  type ActiveSurfaceLifecycleReasonCode,
  type ActiveSurfaceRun,
  type ActiveSurfaceRunLifecycle,
  type ActiveSurfaceSnapshot,
  type ActiveSurfaceTask,
  type ActiveSurfaceTaskStatus,
  type ActiveSurfaceTransition,
  type ActiveSurfaceWorkflowGraph,
  type EntityEventEnvelope,
  type EntityOperatingMode,
  type SkillManifest,
  SkillManifestSchema,
  type TenantId,
  WorkflowSchema,
} from '@aflow/schemas';
import {
  createMemoryDocRepository,
  createTenantContext,
  memoryDocs,
  sessions,
  withTenantSchema,
} from '@aflow/database';
import { listPlatformSkillBundles } from '@aflow/platform-artifacts';
import { ENTITY_EVENTS_STREAM_KEY, getSessionState, type SessionHotState } from '@aflow/redis';
import {
  type ActiveRunWithTaskCounts,
  findCascadeRoot,
  listActiveRunsWithLiveness,
  listRecentlyTerminalRuns,
  listRunsForSessionsWithLiveness,
  listSessionDescendants,
  loadRunById,
} from './ledger.js';
import {
  applyPartialSignalAnnotation,
  deriveLifecycleFromSignals,
  LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS,
  type LifecycleSignals,
} from './lifecycle.js';
import { buildHelmsmanAttention } from './attentionBuilder.js';
import { getCyberneticLogger } from './logger.js';

// Note: `deriveRunLivenessFromCounts` (104d) is no longer consumed here —

// ============================================================================
// Constants
// ============================================================================

/** Cap on concurrent active runs surfaced. Beyond this, callers should fall back to Console. */
const MAX_ACTIVE_RUNS = 20;

const MAX_RECENTLY_TERMINAL_RUNS = 5;

/** Window for recently-terminal-run sticky display — 2 minutes. */
const RECENTLY_TERMINAL_WINDOW_MS = 2 * 60 * 1000;

/**
 * How long the surface may hold a value nothing will announce before it is
 * re-derived. One timer per space that has such a value, not one per watcher,
 * and none at all once the space is idle.
 */
const UNANNOUNCED_INPUT_RECHECK_MS = 15 * 1000;

/** Cap on runs surfaced when the snapshot is scoped to a session cascade. */
const MAX_SESSION_SCOPED_RUNS = 100;

/** Bounds on the recursive descendant walk for session scoping. */
const MAX_DESCENDANT_DEPTH = 16;
const MAX_DESCENDANT_SESSIONS = 256;

/** Recent entity events read for breadcrumb + helmsman summary. */
const RECENT_EVENT_SCAN_COUNT = 50;

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Cap on breadcrumb entries returned. */
const RECENT_TRANSITIONS_LIMIT = 5;

/** Trigger source field names checked on `entity.interaction.started` payloads. */
const TRIGGER_SOURCE_FIELDS = ['triggerSource', 'trigger', 'source', 'origin'] as const;

const VALID_TRIGGER_SOURCES = new Set(['user', 'schedule', 'webhook', 'internal']);

// ============================================================================
// Inputs
// ============================================================================

export interface BuildActiveSurfaceParams {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: string;
  spaceId: string;
  /**
   * When provided, the snapshot is scoped to this session and all its
   * descendants (via `sessions.parent_session_id`). Surfaced runs include
   * every status (no time window) so the chat session inspector's Map tab
   * shows all skill activations belonging to the current session.
   */
  rootSessionId?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build the active-surface snapshot for a space.
 *
 * Joins:
 *  - `listActiveRunsWithLiveness` + `loadRunById` (run ledger — primary)
 *  - `buildHelmsmanAttention` (cached, for proposal/anomaly counts)
 *  - Memory doc scan for skill manifests (workflow slug → skill identity)
 *  - Memory doc read for current workflow JSON (graph fidelity check)
 *  - Live `cybernetic-helmsman` and `cybernetic-coach` session lookups
 *  - `XREVRANGE` on the entity event stream (mode + breadcrumb)
 *
 * On any internal failure, returns a degraded snapshot with `capturedFrom:
 * 'fallback-static'` so the caller can render the static topology view.
 */
export async function buildActiveSurface(
  params: BuildActiveSurfaceParams,
): Promise<ActiveSurfaceSnapshot> {
  const { db, redis, tenantId, spaceId, rootSessionId } = params;
  const startedAt = new Date();

  try {
    const tenantCtx = createTenantContext(tenantId as TenantId);
    const repo = createMemoryDocRepository(db, tenantCtx);

    // Resolve the descendant session set up-front when scoped — the runs
    // query needs it as input. The chat inspector may open on any agent in
    // the cascade (Helmsman / Driver / Runner / Coach); to keep the bird's-
    // eye view coherent we walk upward to the cascade root first, then
    // collect descendants from there. That way "scoped to my chat" always
    // means "the entire cybernetic loop my chat is a part of", not just
    // the sub-tree below my chat.
    const cascadeRootId = rootSessionId
      ? await findCascadeRoot(db, tenantId, rootSessionId, { maxDepth: MAX_DESCENDANT_DEPTH })
      : null;
    const scopedSessionIds = cascadeRootId
      ? await listSessionDescendants(db, tenantId, cascadeRootId, {
          maxDepth: MAX_DESCENDANT_DEPTH,
          limit: MAX_DESCENDANT_SESSIONS,
        })
      : null;

    const [runRowsRaw, attention, helmsmanSession, coachLifecycle, recentEvents, slugToSkill] =
      await Promise.all([
        scopedSessionIds
          ? listRunsForSessionsWithLiveness(db, tenantId, spaceId, scopedSessionIds, {
              limit: MAX_SESSION_SCOPED_RUNS,
            })
          : (async () => {
              const [active, terminal] = await Promise.all([
                listActiveRunsWithLiveness(db, tenantId, spaceId, { limit: MAX_ACTIVE_RUNS }),
                listRecentlyTerminalRuns(db, tenantId, spaceId, {
                  limit: MAX_RECENTLY_TERMINAL_RUNS,
                  withinMs: RECENTLY_TERMINAL_WINDOW_MS,
                }).then((rows) =>
                  // Adapt summary shape to ActiveRunWithTaskCounts so the
                  // active and terminal paths converge below.
                  rows.map((r) => ({
                    runId: r.runId,
                    spaceId: r.spaceId,
                    workflowSlug: r.workflowSlug,
                    sessionId: r.sessionId,
                    status: r.status,
                    startedAt: r.startedAt,
                    completedAt: r.completedAt,
                    schedulerCursorAt: null,
                    totalTasks: 0,
                    succeededTasks: 0,
                    liveTasks: 0,
                    scheduledTasks: 0,
                    pausedTasks: 0,
                  })),
                ),
              ]);
              return [...active, ...terminal];
            })(),
        buildHelmsmanAttention({ tenantId, spaceId, db, redis }).catch((err: unknown) => {
          getCyberneticLogger().warn('activeSurface: attention build failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
        findLiveSessionByPlatformRole(db, tenantCtx, spaceId, 'cybernetic-helmsman'),
        buildCoachLifecycle(db, tenantCtx, spaceId),
        readRecentEntityEvents(redis, tenantId, spaceId, RECENT_EVENT_SCAN_COUNT),
        buildSlugToSkillMap(db, tenantCtx, spaceId),
      ]);

    // Split rows by status so live and terminal runs use the appropriate
    // enrichment path. Live needs hot-state signals + workflow JSON drift
    // check; terminal just needs the recorded task list.
    const liveRows = runRowsRaw.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status));
    const terminalRows = runRowsRaw.filter((r) => TERMINAL_RUN_STATUSES.has(r.status));

    const [enrichedActive, enrichedTerminal] = await Promise.all([
      Promise.all(
        liveRows.map((raw) => enrichRun(db, redis, repo, tenantId, spaceId, raw, slugToSkill)),
      ),
      Promise.all(
        terminalRows.map((row) =>
          enrichTerminalRun(
            db,
            repo,
            tenantId,
            spaceId,
            {
              runId: row.runId,
              sessionId: row.sessionId,
              workflowSlug: row.workflowSlug,
              status: row.status,
              startedAt: row.startedAt,
              completedAt: row.completedAt ?? null,
            },
            slugToSkill,
          ),
        ),
      ),
    ]);
    const surfacedRuns = [...enrichedActive, ...enrichedTerminal].filter(
      (r): r is ActiveSurfaceRun => r !== null,
    );

    // Helmsman lifecycle reads its own hot-state signals.
    const helmsman = await buildHelmsmanSummary(redis, tenantId, helmsmanSession, recentEvents);
    const coach: ActiveSurfaceSnapshot['coach'] = {
      lifecycle: coachLifecycle.lifecycle,
      ...(coachLifecycle.coachSessionId !== undefined
        ? { coachSessionId: coachLifecycle.coachSessionId }
        : {}),
      pendingProposals: attention?.pendingProposals ?? 0,
      pendingPlatformIssues: attention?.pendingPlatformIssues ?? 0,
      pendingAnomalies: attention?.pendingAnomalies ?? 0,
    };
    const recentTransitions = buildRecentTransitions(recentEvents);

    const anyDegraded = surfacedRuns.some((r) => r.graphFidelity === 'degraded');
    const driftSlugs = surfacedRuns
      .filter((r) => r.graphFidelity === 'degraded')
      .map((r) => r.workflowSlug);

    const partialSignalRuns = surfacedRuns.filter(
      (r) => r.lifecycleReasonCode === 'partial_signal_read',
    );
    const hasPartialSignal = partialSignalRuns.length > 0;
    const unknownLifecycleRuns = surfacedRuns.filter((r) => r.lifecycle === 'unknown');
    const hasUnknown = unknownLifecycleRuns.length > 0;

    for (const run of unknownLifecycleRuns) {
      getCyberneticLogger().warn('activeSurface.lifecycle.unknown', {
        tenantId,
        spaceId,
        runId: run.runId,
        workflowSlug: run.workflowSlug,
        lifecycleReasonDetail: run.lifecycleReasonDetail,
      });
    }
    if (hasPartialSignal) {
      getCyberneticLogger().warn('activeSurface.lifecycle.partial_signal_read', {
        tenantId,
        spaceId,
        affectedRunIds: partialSignalRuns.map((r) => r.runId),
      });
    }

    const capturedFrom: ActiveSurfaceCapturedFrom =
      anyDegraded || hasPartialSignal || hasUnknown ? 'degraded' : 'live';

    const freshnessReasonParts: string[] = [];
    if (anyDegraded) freshnessReasonParts.push(`workflow drift on ${driftSlugs.join(', ')}`);
    if (hasPartialSignal) freshnessReasonParts.push('session hot state partial read');
    if (hasUnknown) {
      // Cap the listed runIds so the joined reason fits the schema's 500-char
      // limit even when many runs are unknown (the warn log above lists every id).
      const MAX_LISTED = 5;
      const ids = unknownLifecycleRuns.map((r) => r.runId);
      const listed = ids.slice(0, MAX_LISTED).join(', ');
      const overflow = ids.length - MAX_LISTED;
      freshnessReasonParts.push(
        overflow > 0
          ? `unknown lifecycle for runId=${listed} (+${String(overflow)} more)`
          : `unknown lifecycle for runId=${listed}`,
      );
    }
    const freshnessReasonRaw =
      freshnessReasonParts.length > 0 ? freshnessReasonParts.join('; ') : undefined;
    const freshnessReason =
      freshnessReasonRaw && freshnessReasonRaw.length > 500
        ? `${freshnessReasonRaw.slice(0, 497)}...`
        : freshnessReasonRaw;

    const activeSurfaceVersion = computeVersion({
      surfacedRuns,
      coach,
      mode: helmsman.mode,
      triggerSource: helmsman.triggerSource,
      helmsmanLifecycle: helmsman.lifecycle,
    });

    const nextTimeDerivedChangeAt = deriveNextTimeDerivedChangeAt({
      rows: runRowsRaw,
      coachStalledExpiresAt: coachLifecycle.stalledExpiresAt ?? null,
      // A live run's task statuses, a resolved Helmsman session, and the
      // attention counts all reach the surface through reads that publish
      // nothing. While any of them is present the surface cannot be told it
      // changed, so it re-derives instead.
      hasUnannouncedInputs:
        runRowsRaw.some((row) => !TERMINAL_RUN_STATUSES.has(row.status)) ||
        helmsman.lifecycle !== 'unknown' ||
        coach.pendingProposals > 0 ||
        coach.pendingPlatformIssues > 0 ||
        coach.pendingAnomalies > 0,
      now: Date.now(),
    });

    return {
      spaceId,
      capturedAt: startedAt.toISOString(),
      activeSurfaceVersion,
      capturedFrom,
      ...(freshnessReason ? { freshnessReason } : {}),
      helmsman,
      surfacedRuns,
      coach,
      recentTransitions,
      ...(nextTimeDerivedChangeAt ? { nextTimeDerivedChangeAt } : {}),
    };
  } catch (err) {
    getCyberneticLogger().warn('activeSurface: build failed; returning fallback', {
      error: err instanceof Error ? err.message : String(err),
      tenantId,
      spaceId,
    });

    return {
      spaceId,
      capturedAt: startedAt.toISOString(),
      activeSurfaceVersion: 'fallback',
      capturedFrom: 'fallback-static',
      freshnessReason: err instanceof Error ? err.message : 'aggregator failed',
      helmsman: {
        sessionId: null,
        lifecycle: 'unknown',
        mode: null,
        triggerSource: null,
        lastInteractionAt: null,
      },
      surfacedRuns: [],
      coach: {
        lifecycle: 'idle',
        pendingProposals: 0,
        pendingPlatformIssues: 0,
        pendingAnomalies: 0,
      },
      recentTransitions: [],
    };
  }
}

// ============================================================================
// Internal — per-run enrichment
// ============================================================================

interface SkillSummary {
  skillId: string;
  name: string;
}

async function enrichRun(
  db: PostgresJsDatabase,
  redis: Redis,
  repo: ReturnType<typeof createMemoryDocRepository>,
  tenantId: string,
  spaceId: string,
  raw: ActiveRunWithTaskCounts,
  slugToSkill: Map<string, SkillSummary>,
): Promise<ActiveSurfaceRun | null> {
  const detail = await loadRunById(db, tenantId, spaceId, raw.runId);
  if (!detail) return null;

  // Read the owning session's hot state for delegation/interrupt signals.
  const { hotState, partialSignalRead } = await readRunHotStateSignals(
    redis,
    tenantId,
    raw.sessionId,
  );

  const skill = slugToSkill.get(raw.workflowSlug) ?? null;

  // Load current Workflow JSON for fidelity check.
  const currentWf = await resolveCurrentWorkflow(repo, raw.workflowSlug, spaceId);

  const recordedTaskIds = detail.tasks.map((t) => t.taskId);
  const currentTaskIds = currentWf?.tasks.map((t) => t.taskId) ?? [];
  const currentTaskIdSet = new Set(currentTaskIds);

  const graphFidelity = classifyGraphFidelity(recordedTaskIds, currentTaskIds);

  let workflowGraph: ActiveSurfaceWorkflowGraph | undefined;
  if (graphFidelity === 'full' && currentWf) {
    workflowGraph = {
      taskIds: currentTaskIds,
      edges: currentWf.tasks.flatMap((t) =>
        (t.dependsOn ?? []).map((from) => ({ from, to: t.taskId })),
      ),
    };
  }

  // Build dependsOn per task.
  const recordedTaskIdSet = new Set(recordedTaskIds);
  const depsByTaskId = new Map<string, string[]>();
  if (currentWf) {
    for (const t of currentWf.tasks) {
      const deps = (t.dependsOn ?? []).filter((from) => {
        if (graphFidelity === 'full') return currentTaskIdSet.has(from);
        return recordedTaskIdSet.has(from) && recordedTaskIdSet.has(t.taskId);
      });
      depsByTaskId.set(t.taskId, deps);
    }
  }

  const tasks: ActiveSurfaceTask[] = detail.tasks.map((t) => ({
    taskId: t.taskId,
    status: normalizeTaskStatus(t.status),
    dependsOn: depsByTaskId.get(t.taskId) ?? [],
    startedAt: t.startedAt ? t.startedAt.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
  }));

  const lifecycleResult = deriveRunLifecycle(raw, hotState, partialSignalRead);

  return {
    runId: raw.runId,
    sessionId: raw.sessionId,
    skillId: skill?.skillId ?? null,
    skillName: skill?.name ?? null,
    workflowSlug: raw.workflowSlug,
    lifecycle: lifecycleResult.lifecycle,
    ...(lifecycleResult.reasonCode ? { lifecycleReasonCode: lifecycleResult.reasonCode } : {}),
    ...(lifecycleResult.lifecycle === 'unknown'
      ? {
          lifecycleReasonDetail: `runStatus=${raw.status}, liveTasks=${String(
            raw.liveTasks,
          )}, paused=${String(raw.pausedTasks)}`,
        }
      : {}),
    startedAt: raw.startedAt.toISOString(),
    endedAt: null,
    graphFidelity,
    ...(workflowGraph ? { workflowGraph } : {}),
    tasks,
  };
}

async function enrichTerminalRun(
  db: PostgresJsDatabase,
  repo: ReturnType<typeof createMemoryDocRepository>,
  tenantId: string,
  spaceId: string,
  summary: {
    runId: string;
    sessionId: string | null;
    workflowSlug: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
  },
  slugToSkill: Map<string, SkillSummary>,
): Promise<ActiveSurfaceRun | null> {
  const detail = await loadRunById(db, tenantId, spaceId, summary.runId);
  if (!detail) return null;

  const skill = slugToSkill.get(summary.workflowSlug) ?? null;
  const currentWf = await resolveCurrentWorkflow(repo, summary.workflowSlug, spaceId);

  const recordedTaskIds = detail.tasks.map((t) => t.taskId);
  const currentTaskIds = currentWf?.tasks.map((t) => t.taskId) ?? [];
  const graphFidelity = classifyGraphFidelity(recordedTaskIds, currentTaskIds);

  const tasks: ActiveSurfaceTask[] = detail.tasks.map((t) => ({
    taskId: t.taskId,
    status: normalizeTaskStatus(t.status),
    dependsOn: [],
    startedAt: t.startedAt ? t.startedAt.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
  }));

  const lifecycle: ActiveSurfaceRunLifecycle =
    summary.status === 'completed'
      ? 'completed'
      : summary.status === 'failed'
        ? 'failed'
        : summary.status === 'cancelled'
          ? 'cancelled'
          : 'unknown';

  return {
    runId: summary.runId,
    sessionId: summary.sessionId,
    skillId: skill?.skillId ?? null,
    skillName: skill?.name ?? null,
    workflowSlug: summary.workflowSlug,
    lifecycle,
    ...(lifecycle === 'unknown'
      ? { lifecycleReasonDetail: `terminal status=${summary.status}` }
      : {}),
    startedAt: summary.startedAt.toISOString(),
    endedAt: summary.completedAt ? summary.completedAt.toISOString() : null,
    graphFidelity,
    tasks,
  };
}

function deriveRunLifecycle(
  raw: ActiveRunWithTaskCounts,
  hotState: SessionHotState | null,
  partialSignalRead: boolean,
): { lifecycle: ActiveSurfaceRunLifecycle; reasonCode?: ActiveSurfaceLifecycleReasonCode } {
  // Terminal runs are surfaced via `enrichTerminalRun`; this path only sees
  // running/paused. Defensive coverage in case the ledger query widens.
  const terminal: 'completed' | 'failed' | 'cancelled' | null =
    raw.status === 'completed' || raw.status === 'failed' || raw.status === 'cancelled'
      ? raw.status
      : null;

  const liveTasks = raw.liveTasks;
  const scheduledTasks = raw.scheduledTasks;
  const pausedTasks = raw.pausedTasks;

  const interruptRequested = hotState?.interruptRequested === true;
  const delegationPauseSource = hotState?.delegationPauseSource ?? null;
  const waitingChildren = hotState?.waitingForChildSessionIds ?? [];
  const sessionStatus = hotState?.status;
  const sessionIsPausedLike = sessionStatus === 'PAUSED' || sessionStatus === 'WAITING_ON_CHILD';

  const sessionPauseType = hotState?.pauseType ?? null;
  const directUserInputPause =
    sessionIsPausedLike && (sessionPauseType === 'user_input' || sessionPauseType === 'approval');

  const awaitingUserInput =
    (sessionIsPausedLike && delegationPauseSource === 'child_input') || directUserInputPause;

  const awaitingChild =
    (sessionIsPausedLike && delegationPauseSource === 'child_running') ||
    (waitingChildren.length > 0 && liveTasks === 0 && !awaitingUserInput);

  const paused =
    raw.status === 'paused' || (pausedTasks > 0 && !awaitingUserInput && !awaitingChild);

  const hasLiveWork = liveTasks + scheduledTasks > 0;
  const hasOnlyScheduledWork = liveTasks === 0 && scheduledTasks > 0;

  const referenceTime = raw.schedulerCursorAt ?? raw.startedAt;
  const schedulerStallAgeMs = Date.now() - referenceTime.getTime();

  const signals: LifecycleSignals = {
    terminal,
    interruptRequested,
    awaitingUserInput,
    awaitingChild,
    paused,
    hasLiveWork,
    hasOnlyScheduledWork,
    schedulerStallAgeMs,
    staleThresholdMs: LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS,
    partialSignalRead,
  };

  return applyPartialSignalAnnotation(deriveLifecycleFromSignals(signals), partialSignalRead);
}

// ============================================================================
// Internal — Redis hot-state signal reader
// ============================================================================

async function readRunHotStateSignals(
  redis: Redis,
  tenantId: string,
  sessionId: string | null,
): Promise<{ hotState: SessionHotState | null; partialSignalRead: boolean }> {
  if (!sessionId) {
    // No session linkage. Treat as no signals — not an error.
    return { hotState: null, partialSignalRead: false };
  }
  try {
    const state = await getSessionState(redis, tenantId, sessionId);
    // `null` here means the hot state genuinely doesn't exist (e.g. TTL
    // expired or session never had hot state) — treat as best-effort
    // empty-signals, NOT a partial read. partialSignalRead is for
    // unexpected read failures (Redis blip, schema mismatch via
    // quarantine), where we want to surface degraded confidence.
    return { hotState: state, partialSignalRead: false };
  } catch (err) {
    getCyberneticLogger().warn('activeSurface: hot state read failed', {
      tenantId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hotState: null, partialSignalRead: true };
  }
}

export function classifyGraphFidelity(
  recordedTaskIds: string[],
  currentTaskIds: string[],
): 'full' | 'degraded' {
  if (currentTaskIds.length === 0) return 'degraded';
  if (recordedTaskIds.length === 0) {
    // No execution recorded yet (run just started, no tasks materialized).
    // Treat as `full` so the forward DAG renders cleanly.
    return 'full';
  }
  const currentSet = new Set(currentTaskIds);
  return recordedTaskIds.every((id) => currentSet.has(id)) ? 'full' : 'degraded';
}

function parseWorkflow(
  content: string | null,
): { tasks: Array<{ taskId: string; dependsOn?: string[] }> } | null {
  if (!content) return null;
  try {
    const raw = JSON.parse(content) as unknown;
    const parsed = WorkflowSchema.safeParse(raw);
    if (parsed.success) {
      return {
        tasks: parsed.data.tasks.map((t) => ({
          taskId: t.taskId,
          ...(t.dependsOn ? { dependsOn: t.dependsOn } : {}),
        })),
      };
    }
    // Schema-invalid current workflow → treat as no current shape; the run
    // will be classified `degraded` so the recorded ledger drives rendering.
    return null;
  } catch {
    return null;
  }
}

async function resolveCurrentWorkflow(
  repo: ReturnType<typeof createMemoryDocRepository>,
  workflowSlug: string,
  spaceId: string,
): Promise<{ tasks: Array<{ taskId: string; dependsOn?: string[] }> } | null> {
  const wfDoc = await repo
    .getByPath(`/workflows/${workflowSlug}/workflow.json`, spaceId)
    .catch(() => null);
  const fromMemory = parseWorkflow(wfDoc?.inlineContent ?? null);
  if (fromMemory) return fromMemory;

  const platformBundle = listPlatformSkillBundles().find((b) => b.workflow.slug === workflowSlug);
  if (platformBundle) {
    // PlatformWorkflowDef.tasks is typed loosely (`Record<string, unknown>[]`),
    // so narrow each task to the shape we need at the boundary.
    const tasks: Array<{ taskId: string; dependsOn?: string[] }> = [];
    for (const t of platformBundle.workflow.tasks) {
      const taskId = t['taskId'];
      if (typeof taskId !== 'string') continue;
      const depsRaw = t['dependsOn'];
      const dependsOn = Array.isArray(depsRaw)
        ? depsRaw.filter((d): d is string => typeof d === 'string')
        : undefined;
      tasks.push({ taskId, ...(dependsOn ? { dependsOn } : {}) });
    }
    return { tasks };
  }
  return null;
}

/**
 * Normalize a `workflow_run_tasks.status` value to the wire vocabulary.
 * Unknown statuses surface as `unknown` so the operator sees the gap
 * instead of having a novel status silently masquerade as `scheduled`.
 */
export function normalizeTaskStatus(status: string): ActiveSurfaceTaskStatus {
  switch (status) {
    case 'scheduled':
    case 'claimed':
    case 'in_flight':
    case 'running':
    case 'paused':
    case 'blocked':
    case 'failed':
    case 'succeeded':
    case 'skipped':
      return status;
    default:
      return 'unknown';
  }
}

// ============================================================================
// Internal — slug → skill lookup
// ============================================================================

async function buildSlugToSkillMap(
  db: PostgresJsDatabase,
  tenantCtx: ReturnType<typeof createTenantContext>,
  spaceId: string,
): Promise<Map<string, SkillSummary>> {
  const map = new Map<string, SkillSummary>();

  // Platform skill bundles first — code-defined, identical for every tenant
  for (const bundle of listPlatformSkillBundles()) {
    const slug = bundle.workflow.slug;
    if (!slug) continue;
    map.set(slug, { skillId: bundle.skillId, name: bundle.manifest.name });
  }

  // Space-local manifests override platform entries when the slug collides
  // (matches the resolution order used elsewhere — see `loadSkill`).
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ path: memoryDocs.path, inlineContent: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(and(eq(memoryDocs.spaceId, spaceId), eq(memoryDocs.docType, 'skill_manifest'))),
  );

  for (const row of rows) {
    if (!row.inlineContent) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.inlineContent);
    } catch {
      continue;
    }
    const parsed = SkillManifestSchema.safeParse(raw);
    if (!parsed.success) continue;
    const m: SkillManifest = parsed.data;
    if (!m.workflowSlug) continue;
    map.set(m.workflowSlug, { skillId: m.skillId, name: m.name });
  }

  return map;
}

// ============================================================================
// Internal — Helmsman + Coach session lookups
// ============================================================================

const LIVE_SESSION_STATUSES = ['QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ON_CHILD', 'CANCELLING'];

async function findLiveSessionByPlatformRole(
  db: PostgresJsDatabase,
  tenantCtx: ReturnType<typeof createTenantContext>,
  spaceId: string,
  systemRole: string,
): Promise<{ sessionId: string; status: string } | null> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ sessionId: sessions.sessionId, status: sessions.status })
      .from(sessions)
      .where(
        and(
          eq(sessions.spaceId, spaceId),
          eq(sessions.targetKind, 'platform-role'),
          eq(sessions.targetSystemRole, systemRole),
          inArray(sessions.status, LIVE_SESSION_STATUSES),
        ),
      )
      .orderBy(desc(sessions.startedAt))
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;
  return { sessionId: row.sessionId, status: row.status };
}

const STALLED_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Earliest instant at which the surface changes with nothing else happening.
 *
 * Three of its inputs are windows measured against `Date.now()`, so no
 * producer can announce them. A subscriber that only reacts to writes needs
 * the crossing time; computing it here keeps the thresholds in one place.
 *
 * A fourth category has no crossing time and no producer either: per-task
 * progress within a run, the Helmsman's lifecycle, and the attention counts all
 * come from reads whose sources emit nothing on this channel — `entity.task.*`,
 * `entity.mode.transition` and `entity.interaction.started` are declared and
 * never published, and the attention cache has no invalidation subscriber
 * running. While the surface holds any of them, it needs a bounded re-derive or
 * it silently freezes. That is the floor below: not a poll over subscribers, but
 * one timer per space, only while a space has something in flight.
 */
function deriveNextTimeDerivedChangeAt(args: {
  rows: readonly ActiveRunWithTaskCounts[];
  coachStalledExpiresAt: Date | null;
  /** The surface holds a value whose source publishes no event for it. */
  hasUnannouncedInputs: boolean;
  now: number;
}): string | undefined {
  const { rows, coachStalledExpiresAt, now } = args;
  const candidates: number[] = [];

  // Clamped to the same clock the caller filters against, so a crossing that
  // lands inside the build window is not discarded as already past.
  if (args.hasUnannouncedInputs) candidates.push(now + UNANNOUNCED_INPUT_RECHECK_MS);

  for (const row of rows) {
    if (TERMINAL_RUN_STATUSES.has(row.status)) {
      const endedAt = row.completedAt?.getTime();
      if (endedAt !== undefined) candidates.push(endedAt + RECENTLY_TERMINAL_WINDOW_MS);
      continue;
    }
    const reference = row.schedulerCursorAt ?? row.startedAt;
    candidates.push(reference.getTime() + LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS);
  }
  if (coachStalledExpiresAt) candidates.push(coachStalledExpiresAt.getTime());

  let earliest: number | null = null;
  for (const at of candidates) {
    if (at <= now) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest === null ? undefined : new Date(earliest).toISOString();
}

async function buildCoachLifecycle(
  db: PostgresJsDatabase,
  tenantCtx: ReturnType<typeof createTenantContext>,
  spaceId: string,
): Promise<{
  lifecycle: 'idle' | 'reviewing' | 'stalled';
  coachSessionId?: string;
  stalledExpiresAt?: Date;
}> {
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        sessionId: sessions.sessionId,
        status: sessions.status,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.spaceId, spaceId),
          eq(sessions.targetKind, 'platform-role'),
          eq(sessions.targetSystemRole, 'cybernetic-coach'),
          inArray(sessions.status, ['RUNNING', 'PAUSED']),
        ),
      )
      .orderBy(desc(sessions.startedAt))
      .limit(10),
  );

  const running = rows.find((r) => r.status === 'RUNNING');
  if (running) {
    return { lifecycle: 'reviewing', coachSessionId: running.sessionId };
  }

  const cutoff = Date.now() - STALLED_WINDOW_MS;
  const recentPaused = rows.find((r) => r.status === 'PAUSED' && r.startedAt.getTime() >= cutoff);
  if (recentPaused) {
    return {
      lifecycle: 'stalled',
      coachSessionId: recentPaused.sessionId,
      stalledExpiresAt: new Date(recentPaused.startedAt.getTime() + STALLED_WINDOW_MS),
    };
  }

  return { lifecycle: 'idle' };
}

// ============================================================================
// Internal — Helmsman summary derivation
// ============================================================================

async function buildHelmsmanSummary(
  redis: Redis,
  tenantId: string,
  session: { sessionId: string; status: string } | null,
  recentEvents: EntityEventEnvelope[],
): Promise<ActiveSurfaceSnapshot['helmsman']> {
  const lifecycle = await deriveHelmsmanLifecycle(redis, tenantId, session);

  // Find most recent mode + interaction events. recentEvents is newest-first.
  let mode: EntityOperatingMode | null = null;
  let lastInteractionAt: string | null = null;
  let triggerSource: 'user' | 'schedule' | 'webhook' | 'internal' | null = null;

  for (const ev of recentEvents) {
    if (mode === null && ev.eventType === 'entity.mode.transition' && ev.operatingMode) {
      mode = ev.operatingMode;
    }
    if (lastInteractionAt === null && ev.eventType === 'entity.interaction.started') {
      lastInteractionAt = new Date(ev.timestamp).toISOString();
      triggerSource = extractTriggerSource(ev);
    }
    if (mode !== null && lastInteractionAt !== null) break;
  }

  return {
    sessionId: session?.sessionId ?? null,
    lifecycle,
    mode,
    triggerSource,
    lastInteractionAt,
  };
}

/**
 * Helmsman-side lifecycle adapter. Maps session.status + Redis hot-state
 * signals into `LifecycleSignals` and calls the shared core.
 *
 * Helmsman has no per-task counts — it is a conversational session, not a
 * workflow run. We treat `RUNNING` as `hasLiveWork: true` and `PAUSED`
 * as `paused: true` (unless a more specific awaiting-user/awaiting-child
 * signal applies).
 */
async function deriveHelmsmanLifecycle(
  redis: Redis,
  tenantId: string,
  session: { sessionId: string; status: string } | null,
): Promise<ActiveSurfaceRunLifecycle> {
  if (!session) return 'unknown';

  const { hotState, partialSignalRead } = await readRunHotStateSignals(
    redis,
    tenantId,
    session.sessionId,
  );

  const status = hotState?.status ?? session.status;

  const terminal: 'completed' | 'failed' | 'cancelled' | null =
    status === 'SUCCEEDED'
      ? 'completed'
      : status === 'FAILED'
        ? 'failed'
        : status === 'CANCELLED'
          ? 'cancelled'
          : null;

  const isRunning = status === 'RUNNING' || status === 'QUEUED';
  const isPaused = status === 'PAUSED';
  const isWaitingChild = status === 'WAITING_ON_CHILD';
  const isCancelling = status === 'CANCELLING';

  const isPausedLike = isPaused || isWaitingChild;

  const sessionPauseType = hotState?.pauseType ?? null;
  const directUserInputPause =
    isPausedLike && (sessionPauseType === 'user_input' || sessionPauseType === 'approval');

  const awaitingUserInput =
    (isPausedLike && hotState?.delegationPauseSource === 'child_input') || directUserInputPause;

  const awaitingChild =
    isWaitingChild ||
    (isPausedLike && hotState?.delegationPauseSource === 'child_running') ||
    ((hotState?.waitingForChildSessionIds?.length ?? 0) > 0 && !isRunning && !awaitingUserInput);

  // CANCELLING surfaces as `interrupting` until the cancel completes.
  const interruptRequested = hotState?.interruptRequested === true || isCancelling;

  const signals: LifecycleSignals = {
    terminal,
    interruptRequested,
    awaitingUserInput,
    awaitingChild,
    paused: isPaused && !awaitingUserInput && !awaitingChild,
    hasLiveWork: isRunning,
    hasOnlyScheduledWork: false,
    schedulerStallAgeMs: 0,
    staleThresholdMs: LIFECYCLE_DEFAULT_STALE_THRESHOLD_MS,
    partialSignalRead,
  };

  const result = applyPartialSignalAnnotation(
    deriveLifecycleFromSignals(signals),
    partialSignalRead,
  );
  return result.lifecycle;
}

export function extractTriggerSource(
  ev: EntityEventEnvelope,
): 'user' | 'schedule' | 'webhook' | 'internal' | null {
  for (const key of TRIGGER_SOURCE_FIELDS) {
    const value = ev.payload[key];
    if (typeof value === 'string' && VALID_TRIGGER_SOURCES.has(value)) {
      return value as 'user' | 'schedule' | 'webhook' | 'internal';
    }
  }
  return null;
}

// ============================================================================
// Internal — recent transitions breadcrumb
// ============================================================================

export function buildRecentTransitions(events: EntityEventEnvelope[]): ActiveSurfaceTransition[] {
  const out: ActiveSurfaceTransition[] = [];
  for (const ev of events) {
    if (out.length >= RECENT_TRANSITIONS_LIMIT) break;

    let kind: ActiveSurfaceTransition['kind'] | null = null;
    let label: string | null = null;

    const t = ev.eventType;
    if (t === 'entity.mode.transition') {
      kind = 'mode';
      label = ev.operatingMode ?? ev.summary;
    } else if (t === 'entity.procedure.activated') {
      kind = 'skill_activation';
      label = ev.workflowSlug ?? ev.summary;
    } else if (t === 'entity.procedure.completed') {
      kind = 'skill_completion';
      label = ev.workflowSlug ?? ev.summary;
    } else if (t === 'entity.coach.activated') {
      kind = 'coach_review';
      label = ev.summary || 'coach review';
    }

    if (kind && label) {
      out.push({
        at: new Date(ev.timestamp).toISOString(),
        kind,
        label: label.slice(0, 200),
      });
    }
  }
  return out;
}

// ============================================================================
// Internal — entity event stream read (XREVRANGE)
// ============================================================================

async function readRecentEntityEvents(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  count: number,
): Promise<EntityEventEnvelope[]> {
  try {
    const streamKey = ENTITY_EVENTS_STREAM_KEY(tenantId, spaceId);
    const result = await redis.xrevrange(streamKey, '+', '-', 'COUNT', count);
    const out: EntityEventEnvelope[] = [];
    for (const [, fields] of result) {
      const env = parseEnvelopeFromFields(fields);
      if (env) out.push(env);
    }
    return out;
  } catch (err) {
    getCyberneticLogger().warn('activeSurface: entity event read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function parseEnvelopeFromFields(fields: string[]): EntityEventEnvelope | null {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key === undefined || value === undefined) continue;
    obj[key] = decodeFieldValue(key, value);
  }
  // EntityEventEnvelopeSchema is permissive on payload shape (z.record(z.unknown())).
  // We don't strictly parse here — the aggregator only reads a small set of
  // top-level fields. Returning the loose object keeps this helper independent
  // of the serializer in @aflow/redis without re-importing it.
  if (typeof obj['eventType'] !== 'string') return null;
  if (typeof obj['timestamp'] !== 'number') return null;
  if (typeof obj['summary'] !== 'string') return null;
  return obj as unknown as EntityEventEnvelope;
}

const NUMERIC_FIELDS = new Set(['timestamp']);

function decodeFieldValue(key: string, value: string): unknown {
  if (value === 'null') return null;
  if (NUMERIC_FIELDS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Try JSON-parse for objects/arrays; fall back to string.
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

// ============================================================================
// Internal — version hash
// ============================================================================

interface VersionInput {
  surfacedRuns: ActiveSurfaceRun[];
  coach: ActiveSurfaceSnapshot['coach'];
  mode: ActiveSurfaceSnapshot['helmsman']['mode'];
  triggerSource: ActiveSurfaceSnapshot['helmsman']['triggerSource'];
  helmsmanLifecycle: ActiveSurfaceSnapshot['helmsman']['lifecycle'];
}

export function computeActiveSurfaceVersion(input: VersionInput): string {
  return computeVersion(input);
}

function computeVersion(input: VersionInput): string {
  const canonical = {
    runs: input.surfacedRuns
      .map((r) => ({
        id: r.runId,
        lifecycle: r.lifecycle,
        reason: r.lifecycleReasonCode ?? null,
        ended: r.endedAt,
        graphFidelity: r.graphFidelity,
        tasks: r.tasks.map((t) => `${t.taskId}:${t.status}`).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    coach: input.coach,
    mode: input.mode,
    triggerSource: input.triggerSource,
    helmsmanLifecycle: input.helmsmanLifecycle,
  };
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}
