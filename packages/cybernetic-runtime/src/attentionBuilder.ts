import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, sql, and, isNull } from 'drizzle-orm';
import type {
  AppletActor,
  AppletAttention,
  AppletInstanceStatus,
  AppletStateVersion,
  TenantId,
  SkillDiagnostic,
} from '@aflow/schemas';
import {
  createAppletPersistence,
  createTenantContext,
  withTenantSchema,
  memoryDocs,
} from '@aflow/database';
import { projectAppletAttention, type AppletInstanceListItem } from '@aflow/applet-runtime';
import { isPlatformSkillId } from '@aflow/platform-artifacts';
import type { Redis } from 'ioredis';
import { getCyberneticLogger } from './logger.js';
import { listSkillsForSpace, type ResolvedSkill } from './skill.js';
import { resolveUserLabels } from './userLabels.js';
import {
  cachedOrRecomputeValidity,
  renderSkillDiagnostics,
} from './skillValidity/skillValidity.js';
import { listActiveRunsWithLiveness } from './ledger.js';
import { getAttentionCache, setAttentionCache } from './attentionCache.js';
import { cyberneticHookSafe } from './hookSafe.js';
import { deriveRunLivenessFromCounts } from './scheduling/runLiveness.js';
import {
  loadActivePlanTree,
  type PlanAttention,
  type PlanAttentionNode,
} from './plan/attention.js';
import { createPlanNodeStore } from './plan/store.js';

// ============================================================================
// Types
// ============================================================================

export interface ActiveWorkflowRunSummary {
  slug: string;
  runId: string;
  status: 'running' | 'paused';
  /** 104d Phase 0: derived liveness (executing, waiting_for_input, stalled, idle). */
  liveness: string;
  startedAt: string;
  tasksSummary: string;
}

export interface ActiveAppletLastAction {
  name: string;
  actorDisplay: string;
  at: string;
}

/** §4.13 tier 2 — one active instance, one line. Fields are declared, never inferred. */
export interface ActiveAppletSummary {
  appletKey: string;
  instanceId: string;
  status: AppletInstanceStatus;
  stateVersion: AppletStateVersion;
  updatedAt: string;
  /** Reads of the declared attentionProjection pointers; absent → the generic line. */
  attention?: AppletAttention;
  lastAction?: ActiveAppletLastAction;
}

export interface RecentEvalResult {
  procedureSlug: string;
  verdict: string;
  overall: number;
}

export interface PendingProposalDetail {
  id: string;
  kind: string;
  summary: string;
  confidence: string;
  targetWorkflowSlug?: string;
  proposedAt: string;
  resolutionRoute: 'tenant_ratification' | 'platform_issue';
  authorityLevel: 'auto_apply' | 'stage_for_review' | 'require_operator';
  issueCategory?: string;
  lastRatificationError?: {
    reason: string;
    op: string;
    detail: string;
    at: string;
  };
}

export interface PendingAnomalyDetail {
  id: string;
  kind: string;
  severity: string;
  summary: string;
  reportedAt: string;
}

export interface SkillAttentionEntry {
  /** Skill slug — joins with `SpaceContext.skills[*].slug`. */
  slug: string;
  /** Total recorded runs in this space. Only emitted when > 0. */
  usageCount: number;
}

/**
 * Quality flag on a schema-valid skill that the Coach should consider
 * refining. Distinct from `DegradedSkillEntry` — these skills *run*, but
 * their workflow JSON is underspecified relative to current authoring
 * standards (e.g. tasks reference external APIs in goal prose but declare
 * no `context.capabilities`).
 *
 *   - `no_capability_declarations`: no task in the workflow has a
 *     `context.capabilities` block. Strong signal of a pre-cybernetic
 *     skill that hasn't been compiled to the structured surface yet.
 *     Coach can propose `update_task_context_spec` ops to add grants.
 */
export interface SkillQualityFlag {
  slug: string;
  issue: 'no_capability_declarations';
  /** Task IDs implicated by the issue (often "all"), capped for readability. */
  taskIds: string[];
}

export interface DegradedSkillEntry {
  slug: string;
  /** Rendered headline of the blocking diagnostics (the full set is on the verdict). */
  validationError: string;
}

export interface HelmsmanAttentionContext {
  /** The space's open plan tree (Plan 322 D4) — read before anything else. */
  activePlan?: PlanAttention;
  activeWorkflowRuns: ActiveWorkflowRunSummary[];
  /** Active applet instances, last action first, capped; ended/archived never appear. */
  activeApplets?: ActiveAppletSummary[];
  /** Uncapped active count — drives the overflow pointer at `ui.applet.list`. */
  activeAppletsTotal?: number;
  /** Count of tenant-ratifiable pending proposals (excludes platform issues). */
  pendingProposals: number;
  pendingPlatformIssues: number;
  pendingAnomalies: number;
  pendingPatternFlags: number;
  recentEvalResults?: RecentEvalResult[];
  /** Pending tenant-ratifiable proposals with summaries (for supervisory mode review) */
  pendingProposalDetails?: PendingProposalDetail[];
  platformIssueDetails?: PendingProposalDetail[];
  /** Pending anomaly reports (for supervisory review) */
  pendingAnomalyDetails?: PendingAnomalyDetail[];
  /** 104b: skills in the space (from SkillManifest + SkillProjection). */
  skills?: SkillAttentionEntry[];
  degradedSkills?: DegradedSkillEntry[];
  /**
   * Schema-valid skills that fall short of current authoring standards
   * and could benefit from Coach review (e.g. tasks with no declared
   * `context.capabilities`). The Helmsman uses this to suggest "let's
   * have the Coach review this skill" when the operator activates or
   * asks about one of them.
   */
  skillQualityFlags?: SkillQualityFlag[];
}

// ============================================================================
// Internal query helpers
// ============================================================================

/**
 * Format an ISO timestamp as a human-readable relative time (e.g., "2h ago", "3d ago").
 */
function formatTimeAgo(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

interface StagedChangeDoc {
  kind?: string;
  id?: string;
  status?: string;
  summary?: string;
  confidence?: string;
  targetWorkflowSlug?: string;
  proposedAt?: string;
  resolutionRoute?: 'tenant_ratification' | 'platform_issue';
  authorityLevel?: 'auto_apply' | 'stage_for_review' | 'require_operator';
  proposal?: { summary?: string; confidence?: string };
  evidence?: { diagnosis?: { issueCategory?: string } };
  lastRatificationError?: { reason?: string; op?: string; detail?: string; at?: string };
}

interface AnomalyDoc {
  id?: string;
  kind?: string;
  severity?: string;
  summary?: string;
  reportedAt?: string;
  acknowledged?: boolean;
}

/**
 * Query active workflow runs with liveness from the relational tables.
 *
 * 104d Phase 1a: single bounded query replaces the Phase 0 N+1 pattern
 * that called `loadRunById()` per active run.
 */
async function queryActiveWorkflowRuns(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<ActiveWorkflowRunSummary[]> {
  const runs = await listActiveRunsWithLiveness(db, tenantId, spaceId, { limit: 50 });

  return runs.map((run) => {
    const liveness = deriveRunLivenessFromCounts({
      status: run.status,
      startedAt: run.startedAt,
      schedulerCursorAt: run.schedulerCursorAt,
      liveTasks: run.liveTasks,
      scheduledTasks: run.scheduledTasks,
      pausedTasks: run.pausedTasks,
      succeededTasks: run.succeededTasks,
      totalTasks: run.totalTasks,
    });

    return {
      slug: run.workflowSlug,
      runId: run.runId,
      status: run.status as 'running' | 'paused',
      liveness,
      startedAt: run.startedAt.toISOString(),
      tasksSummary:
        run.totalTasks > 0
          ? `${String(run.succeededTasks)}/${String(run.totalTasks)} tasks complete`
          : 'in progress',
    };
  });
}

/**
 * Hard cap on the Active-applets attention section — one line each plus an
 * overflow pointer, so a space full of live instances never floods the turn.
 */
const ACTIVE_APPLET_SURFACE_LIMIT = 8;

/**
 * The active-run list is deliberately NOT capped.
 *
 * Capping it looked right — every sibling list here caps, and 50 rows is ~1,500
 * tokens in the uncached block. It is wrong because the overflow pointer has
 * nowhere to point: `workflow.run.list_attention` returns only
 * completed/paused/failed/cancelled events, a RUNNING run has no such row, and
 * no operation lists them. Hiding rows past a cap would lose those run ids for
 * good rather than deferring them. It can cap when an active-run listing op
 * exists.
 */

function appletActorDisplay(actor: AppletActor, labels: ReadonlyMap<string, string>): string {
  if (actor.kind === 'agent') return actor.displayName ?? actor.agentRole;
  if (actor.userId === null) return actor.displayName ?? 'unknown';
  return labels.get(actor.userId) ?? actor.displayName ?? actor.userId;
}

/**
 * Map list items onto attention summaries. Re-applies the active-only filter
 * and the cap even though the query already bounds both — a line about an
 * ended game reads as authoritative (§4.13), so the invariant is enforced at
 * the derivation too, where it is unit-testable.
 */
export function deriveActiveAppletSummaries(
  items: readonly AppletInstanceListItem[],
  labels: ReadonlyMap<string, string>,
): ActiveAppletSummary[] {
  return items
    .filter((item) => item.instance.status === 'active')
    .slice(0, ACTIVE_APPLET_SURFACE_LIMIT)
    .map((item) => {
      const attention = projectAppletAttention(item.state, item.definition.attentionProjection);
      const receipt = item.lastReceipt;
      return {
        appletKey: item.instance.appletKey,
        instanceId: item.instance.instanceId,
        status: item.instance.status,
        stateVersion: item.stateVersion,
        updatedAt: item.instance.updatedAt,
        ...(attention !== undefined ? { attention } : {}),
        ...(receipt !== undefined
          ? {
              lastAction: {
                name: receipt.name,
                actorDisplay: appletActorDisplay(receipt.actor, labels),
                at: receipt.at,
              },
            }
          : {}),
      };
    });
}

async function queryActiveApplets(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<{ applets: ActiveAppletSummary[]; total: number }> {
  const persistence = createAppletPersistence(db, createTenantContext(tenantId as TenantId));
  // listInstances orders by most recently touched, and every committed action
  // touches the instance row — so this is already last-action-desc.
  const { items, total } = await persistence.transact(async (tx) =>
    tx.listInstances({
      spaceId,
      status: 'active',
      limit: ACTIVE_APPLET_SURFACE_LIMIT,
      offset: 0,
    }),
  );
  const userIds = items.flatMap((item) => {
    const actor = item.lastReceipt?.actor;
    return actor?.kind === 'user' && actor.userId !== null ? [actor.userId] : [];
  });
  const labels = await resolveUserLabels(db, userIds);
  return { applets: deriveActiveAppletSummaries(items, labels), total };
}

/**
 * Count staged changes filtered by kind (e.g., 'pattern_flag').
 * Reads inline content of staged docs and filters by the `kind` field.
 * Only counts proposals still in `proposed` status — ratified/rejected/expired
 * proposals remain in /coach/staged/ as historical records and must not be
 * counted as pending.
 */
async function countStagedByKind(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  kind: string,
): Promise<number> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const stagedRows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ inlineContent: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`${memoryDocs.path} LIKE '/coach/staged/%'`,
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(200),
  );

  let count = 0;
  for (const row of stagedRows) {
    if (!row.inlineContent) continue;
    try {
      const doc = JSON.parse(row.inlineContent) as StagedChangeDoc;
      if (doc.status !== 'proposed') continue;
      if (doc.kind === kind) count++;
    } catch {
      // Skip malformed docs
    }
  }

  return count;
}

async function countPendingProposalsByRoute(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<{ tenant: number; platform: number }> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const stagedRows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ path: memoryDocs.path, inlineContent: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`(${memoryDocs.path} LIKE '/coach/staged/%' OR ${memoryDocs.path} LIKE '/coach/platform-issues/%')`,
          isNull(memoryDocs.deletedAt),
        ),
      )
      .limit(500),
  );

  let tenant = 0;
  let platform = 0;
  for (const row of stagedRows) {
    if (!row.inlineContent) continue;
    try {
      const doc = JSON.parse(row.inlineContent) as StagedChangeDoc;
      if (doc.status !== 'proposed') continue;
      const route =
        doc.resolutionRoute ??
        (row.path.startsWith('/coach/platform-issues/') ? 'platform_issue' : 'tenant_ratification');
      if (route === 'platform_issue') platform++;
      else tenant++;
    } catch {
      // Skip malformed docs
    }
  }

  return { tenant, platform };
}

async function loadProposalDetailsByRoute(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  limitPerRoute: number,
): Promise<{ tenant: PendingProposalDetail[]; platform: PendingProposalDetail[] }> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        path: memoryDocs.path,
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`(${memoryDocs.path} LIKE '/coach/staged/%' OR ${memoryDocs.path} LIKE '/coach/platform-issues/%')`,
          isNull(memoryDocs.deletedAt),
        ),
      )
      .orderBy(sql`${memoryDocs.createdAt} DESC`)
      .limit(limitPerRoute * 2),
  );

  const tenant: PendingProposalDetail[] = [];
  const platform: PendingProposalDetail[] = [];
  for (const row of rows) {
    if (!row.inlineContent) continue;
    try {
      const doc = JSON.parse(row.inlineContent) as StagedChangeDoc;
      if (doc.status !== 'proposed') continue;

      // Read proposal nested fields (newer doc shape) with top-level fallback
      // for forward compatibility with the legacy flat shape.
      const summary = doc.proposal?.summary ?? doc.summary ?? '(no summary)';
      const confidence = doc.proposal?.confidence ?? doc.confidence ?? 'unknown';
      const issueCategory = doc.evidence?.diagnosis?.issueCategory;

      const pathMatch = /\/coach\/(?:staged|platform-issues)\/([^/]+)\.json$/.exec(row.path);
      const id = doc.id ?? pathMatch?.[1] ?? 'unknown';
      const route =
        doc.resolutionRoute ??
        (row.path.startsWith('/coach/platform-issues/') ? 'platform_issue' : 'tenant_ratification');
      const authorityLevel = doc.authorityLevel ?? 'stage_for_review';

      const lastErr = doc.lastRatificationError;
      const detail: PendingProposalDetail = {
        id,
        kind: doc.kind ?? 'unknown',
        summary,
        confidence,
        ...(doc.targetWorkflowSlug != null ? { targetWorkflowSlug: doc.targetWorkflowSlug } : {}),
        proposedAt: doc.proposedAt ?? new Date().toISOString(),
        resolutionRoute: route,
        authorityLevel,
        ...(issueCategory ? { issueCategory } : {}),
        ...(lastErr?.reason && lastErr.op && lastErr.detail && lastErr.at
          ? {
              lastRatificationError: {
                reason: lastErr.reason,
                op: lastErr.op,
                detail: lastErr.detail,
                at: lastErr.at,
              },
            }
          : {}),
      };

      const bucket = route === 'platform_issue' ? platform : tenant;
      if (bucket.length < limitPerRoute) bucket.push(detail);
    } catch {
      // Skip malformed docs
    }
  }

  return { tenant, platform };
}

/**
 * Bounded so the inbox never becomes a wall of broken skills; if a space has
 * more than the cap, that's a separate structural problem worth flagging on
 * its own.
 */
const DEGRADED_SKILL_SURFACE_LIMIT = 10;
const QUALITY_FLAG_SURFACE_LIMIT = 20;
const QUALITY_FLAG_TASK_ID_CAP = 8;

interface SkillSurfaceResult {
  degraded: DegradedSkillEntry[];
  qualityFlags: SkillQualityFlag[];
}

/** Compact one-line headline for a degraded skill (full set lives on the verdict). */
function degradedHeadline(diagnostics: readonly SkillDiagnostic[]): string {
  const first = diagnostics[0];
  if (!first) return renderSkillDiagnostics(diagnostics) || 'Contract invalid.';
  const extra = diagnostics.length > 1 ? ` (+${String(diagnostics.length - 1)} more)` : '';
  return `[${first.code}] ${first.detail}${extra}`;
}

function deriveSkillValiditySurfaces(resolvedSkills: ResolvedSkill[]): SkillSurfaceResult {
  const degraded: DegradedSkillEntry[] = [];
  const qualityFlags: SkillQualityFlag[] = [];

  for (const skill of resolvedSkills) {
    const slug = skill.manifest.skillId;
    if (isPlatformSkillId(slug)) continue;

    const validity = cachedOrRecomputeValidity(skill.workflow, skill.projection);

    if (validity.status === 'invalid') {
      if (degraded.length < DEGRADED_SKILL_SURFACE_LIMIT) {
        degraded.push({ slug, validationError: degradedHeadline(validity.diagnostics) });
      }
      continue; // an invalid skill is not also quality-flagged
    }

    if (
      qualityFlags.length < QUALITY_FLAG_SURFACE_LIMIT &&
      validity.advisories.some((a) => a.code === 'no_capability_declarations')
    ) {
      qualityFlags.push({
        slug,
        issue: 'no_capability_declarations',
        taskIds: (skill.workflow?.tasks ?? [])
          .slice(0, QUALITY_FLAG_TASK_ID_CAP)
          .map((t) => t.taskId),
      });
    }
  }

  return { degraded, qualityFlags };
}

async function countPendingAnomalies(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<number> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ inlineContent: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`${memoryDocs.path} LIKE '/coach/anomalies/%'`,
          isNull(memoryDocs.deletedAt),
        ),
      ),
  );

  let pending = 0;
  for (const row of rows) {
    if (!row.inlineContent) {
      // Missing body — count conservatively as pending so the operator
      // still sees something. Better than silently dropping.
      pending += 1;
      continue;
    }
    try {
      const doc = JSON.parse(row.inlineContent) as { acknowledged?: boolean };
      if (doc.acknowledged !== true) pending += 1;
    } catch {
      // Malformed — count as pending so the operator sees it and can
      // either fix or remove it.
      pending += 1;
    }
  }

  return pending;
}

async function loadAnomalyDetails(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  limit: number,
): Promise<PendingAnomalyDetail[]> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        path: memoryDocs.path,
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`${memoryDocs.path} LIKE '/coach/anomalies/%'`,
          isNull(memoryDocs.deletedAt),
        ),
      )
      .orderBy(sql`${memoryDocs.createdAt} DESC`)
      .limit(limit),
  );

  const details: PendingAnomalyDetail[] = [];
  for (const row of rows) {
    if (!row.inlineContent) continue;
    try {
      const doc = JSON.parse(row.inlineContent) as AnomalyDoc;
      if (doc.acknowledged === true) continue;
      const pathMatch = /\/coach\/anomalies\/([^/]+)\.json$/.exec(row.path);
      const id = doc.id ?? pathMatch?.[1] ?? 'unknown';

      details.push({
        id,
        kind: doc.kind ?? 'unknown',
        severity: doc.severity ?? 'unknown',
        summary: doc.summary ?? '(no summary)',
        reportedAt: doc.reportedAt ?? new Date().toISOString(),
      });
    } catch {
      // Skip malformed docs
    }
  }

  return details;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build the Helmsman attention context for the current turn.
 *
 * This is injected as a volatile context block into the Helmsman's agent turn.
 * It gives the Helmsman awareness of active work, pending proposals, and
 * anomalies without baking it into the system prompt.
 *
 * @param params.tenantId - Tenant ID
 * @param params.spaceId - Space ID the Helmsman operates in
 * @param params.db - Drizzle database instance
 * @param params.redis - Redis instance (reserved for future hot-state queries)
 */
export async function buildHelmsmanAttention(params: {
  tenantId: string;
  spaceId: string;
  db: PostgresJsDatabase;
  redis: Redis;
}): Promise<HelmsmanAttentionContext> {
  const { tenantId, spaceId, db, redis } = params;

  // 104c Phase 3: Check cache first, capture generation for safe write-back
  let readGeneration: string | null = null;
  try {
    const cached = await getAttentionCache(redis, tenantId, spaceId);
    readGeneration = cached.generation;
    if (cached.value) {
      return JSON.parse(cached.value) as HelmsmanAttentionContext;
    }
  } catch {
    // Cache failure — fall through to direct compute
    const ctx = { redis, tenantId, spaceId };
    cyberneticHookSafe(
      'attention-cache-read',
      () => Promise.reject(new Error('attention cache read failed')),
      ctx,
    ).catch(() => {});
  }

  try {
    // Run all queries in parallel for performance
    const [
      activePlan,
      activeWorkflowRuns,
      activeAppletScan,
      proposalCounts,
      pendingAnomalies,
      pendingPatternFlags,
      proposalDetails,
      pendingAnomalyDetails,
      resolvedSkills,
    ] = await Promise.all([
      loadActivePlanTree(createPlanNodeStore(db, tenantId), spaceId).catch((err: unknown) => {
        getCyberneticLogger().warn('helmsmanAttention: plan-load failed', {
          error: err instanceof Error ? err.message : String(err),
          tenantId,
          spaceId,
        });
        return undefined;
      }),
      queryActiveWorkflowRuns(db, tenantId, spaceId),
      // One corrupt state snapshot throws inside listInstances; the applet
      // section degrades to empty rather than blanking the whole context.
      queryActiveApplets(db, tenantId, spaceId).catch((err: unknown) => {
        getCyberneticLogger().warn('helmsmanAttention: active-applet-load failed', {
          error: err instanceof Error ? err.message : String(err),
          tenantId,
          spaceId,
        });
        return { applets: [] as ActiveAppletSummary[], total: 0 };
      }),
      countPendingProposalsByRoute(db, tenantId, spaceId),
      countPendingAnomalies(db, tenantId, spaceId),
      countStagedByKind(db, tenantId, spaceId, 'pattern_flag'),
      loadProposalDetailsByRoute(db, tenantId, spaceId, 5),
      loadAnomalyDetails(db, tenantId, spaceId, 5),
      // 104b: populate from SkillManifest + SkillProjection
      listSkillsForSpace({ db, tenantId, spaceId }).catch((err: unknown) => {
        getCyberneticLogger().warn('helmsmanAttention: skill-attention-load failed', {
          error: err instanceof Error ? err.message : String(err),
          tenantId,
          spaceId,
        });
        return [] as ResolvedSkill[];
      }),
    ]);

    const skillScan = deriveSkillValiditySurfaces(resolvedSkills);

    const skills: SkillAttentionEntry[] = resolvedSkills
      .filter((s) => {
        const activationStatus = s.projection?.activationStatus ?? 'active';
        if (activationStatus !== 'active') return false;
        return (s.projection?.usageCount ?? 0) > 0;
      })
      .map((s) => ({
        slug: s.manifest.skillId,
        usageCount: s.projection?.usageCount ?? 0,
      }));

    const result: HelmsmanAttentionContext = {
      ...(activePlan !== undefined ? { activePlan } : {}),
      activeWorkflowRuns,
      ...(activeAppletScan.applets.length > 0
        ? { activeApplets: activeAppletScan.applets, activeAppletsTotal: activeAppletScan.total }
        : {}),
      pendingProposals: proposalCounts.tenant,
      pendingPlatformIssues: proposalCounts.platform,
      pendingAnomalies,
      pendingPatternFlags,
      // recentEvalResults: placeholder — will be populated when 102f eval storage is implemented
      ...(proposalDetails.tenant.length > 0
        ? { pendingProposalDetails: proposalDetails.tenant }
        : {}),
      ...(proposalDetails.platform.length > 0
        ? { platformIssueDetails: proposalDetails.platform }
        : {}),
      ...(pendingAnomalyDetails.length > 0 ? { pendingAnomalyDetails } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(skillScan.degraded.length > 0 ? { degradedSkills: skillScan.degraded } : {}),
      ...(skillScan.qualityFlags.length > 0 ? { skillQualityFlags: skillScan.qualityFlags } : {}),
    };

    // 104c Phase 3: Cache the computed result
    try {
      await setAttentionCache(redis, tenantId, spaceId, JSON.stringify(result), readGeneration);
    } catch {
      // Cache write failure is non-fatal
    }

    return result;
  } catch (error) {
    getCyberneticLogger().warn(
      `helmsmanAttention: failed to build for spaceId=${spaceId}, tenantId=${tenantId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    // Return empty attention context on failure — the Helmsman can still function
    return {
      activeWorkflowRuns: [],
      pendingProposals: 0,
      pendingPlatformIssues: 0,
      pendingAnomalies: 0,
      pendingPatternFlags: 0,
    };
  }
}

// Slow-moving fields only: this line renders into the cached prompt prefix,
// so anything that changes per action (version, waiting-on, last actor,
// time-ago) would re-read the whole conversation every applet move. The
// volatile facts ride ui.applet.get at the conversation tail instead.
function renderActiveAppletLine(applet: ActiveAppletSummary): string {
  const id = `[instanceId: ${applet.instanceId}]`;
  const declared = applet.attention;
  const title = declared?.title !== undefined ? ` "${declared.title}"` : '';
  const paren = [applet.status, ...(declared?.status !== undefined ? [declared.status] : [])].join(
    ', ',
  );
  return `- ${applet.appletKey}${title} (${paren}) — read with \`ui.applet.get\` ${id}`;
}

const PLAN_INDENT = '  ';

/** `[execute] 315 · Local first-run ergonomics — active — next: F114 … [nodeId: …]` (Plan 322 §3.3). */
function renderPlanNodeLine(node: PlanAttentionNode): string {
  const note = node.noteHead !== undefined ? ` — ${node.noteHead}` : '';
  return `${PLAN_INDENT.repeat(node.depth)}[${node.kind}] ${node.title} — ${node.status}${note} [nodeId: ${node.nodeId}]`;
}

/**
 * Render the attention context as a human-readable text block
 * suitable for injection into the Helmsman's agent turn context.
 */
export function renderAttentionContext(attention: HelmsmanAttentionContext): string {
  const lines: string[] = [];

  if (attention.activePlan && attention.activePlan.nodes.length > 0) {
    lines.push('Active plan — open a node with `plan.node.get`:');
    for (const node of attention.activePlan.nodes) {
      lines.push(renderPlanNodeLine(node));
    }
    const more = attention.activePlan.total - attention.activePlan.nodes.length;
    if (more > 0) {
      const count =
        attention.activePlan.truncated !== undefined ? `more than ${String(more)}` : String(more);
      lines.push(`   ... and ${count} more — use \`plan.node.list\``);
    }
    lines.push('');
  }

  // Active workflow runs
  if (attention.activeWorkflowRuns.length > 0) {
    lines.push('Active workflow runs:');
    for (const run of attention.activeWorkflowRuns) {
      lines.push(
        `- ${run.slug} (${run.status}, liveness: ${run.liveness}): ${run.tasksSummary} [runId: ${run.runId}]`,
      );
    }
  } else {
    lines.push('No active workflow runs.');
  }

  // Active applet instances (§4.13 tier 2) — same shape as workflow runs:
  // one line, an id, a status, an overflow pointer to the op listing the rest.
  if (attention.activeApplets && attention.activeApplets.length > 0) {
    lines.push('');
    lines.push('Active applets:');
    for (const applet of attention.activeApplets) {
      lines.push(renderActiveAppletLine(applet));
    }
    const total = attention.activeAppletsTotal ?? attention.activeApplets.length;
    if (total > attention.activeApplets.length) {
      lines.push(
        `   ... and ${String(total - attention.activeApplets.length)} more — use \`ui.applet.list\``,
      );
    }
  }

  // Pending proposals with details (tenant ratification surface)
  if (attention.pendingProposalDetails && attention.pendingProposalDetails.length > 0) {
    lines.push('');
    lines.push(`## Pending Proposals (${String(attention.pendingProposals)})`);
    lines.push(
      'Summarize each for the user. To let them ratify, point them at it with ' +
        '`human.action_center.focus` using the `id` below — the operator resolves it on the ' +
        "Action Center; you don't apply proposals yourself. `proposal.get` with the same id " +
        'fetches full detail if the summary here is not enough.',
    );
    for (let i = 0; i < attention.pendingProposalDetails.length; i++) {
      const p = attention.pendingProposalDetails[i]!;
      const ago = formatTimeAgo(p.proposedAt);
      const target = p.targetWorkflowSlug ? ` for ${p.targetWorkflowSlug}` : '';
      lines.push(
        `${String(i + 1)}. [${p.kind}] "${p.summary}"${target} (${p.confidence} confidence) — proposed ${ago} — id: ${p.id}`,
      );
    }
    if (attention.pendingProposals > attention.pendingProposalDetails.length) {
      lines.push(
        `   ... and ${String(attention.pendingProposals - attention.pendingProposalDetails.length)} more in /coach/staged/`,
      );
    }
  } else if (attention.pendingProposals > 0) {
    lines.push(
      `Pending Coach proposals: ${String(attention.pendingProposals)} (check /coach/staged/)`,
    );
  }

  if (attention.platformIssueDetails && attention.platformIssueDetails.length > 0) {
    lines.push('');
    lines.push(`## Platform Issues (${String(attention.pendingPlatformIssues)})`);
    lines.push(
      'These target platform-owned workflows (e.g. compose-skill, bind-capability). They are diagnostic reports for the platform team — do NOT offer ratification. Summarize the rationale + ops if the user asks.',
    );
    for (let i = 0; i < attention.platformIssueDetails.length; i++) {
      const p = attention.platformIssueDetails[i]!;
      const ago = formatTimeAgo(p.proposedAt);
      const target = p.targetWorkflowSlug ? ` for ${p.targetWorkflowSlug}` : '';
      const cat = p.issueCategory ? ` <${p.issueCategory}>` : '';
      lines.push(
        `${String(i + 1)}. [${p.kind}${cat}] "${p.summary}"${target} (${p.confidence} confidence) — reported ${ago} — id: ${p.id}`,
      );
    }
    if (attention.pendingPlatformIssues > attention.platformIssueDetails.length) {
      lines.push(
        `   ... and ${String(attention.pendingPlatformIssues - attention.platformIssueDetails.length)} more in /coach/platform-issues/`,
      );
    }
  } else if (attention.pendingPlatformIssues > 0) {
    lines.push(
      `Pending platform issues: ${String(attention.pendingPlatformIssues)} (check /coach/platform-issues/) — read-only from this space.`,
    );
  }

  // Pending anomalies with details
  if (attention.pendingAnomalyDetails && attention.pendingAnomalyDetails.length > 0) {
    lines.push('');
    lines.push(`## Anomalies (${String(attention.pendingAnomalies)})`);
    for (let i = 0; i < attention.pendingAnomalyDetails.length; i++) {
      const a = attention.pendingAnomalyDetails[i]!;
      const ago = formatTimeAgo(a.reportedAt);
      lines.push(
        `${String(i + 1)}. [${a.severity}] "${a.summary}" — reported ${ago} — id: ${a.id}`,
      );
    }
    if (attention.pendingAnomalies > attention.pendingAnomalyDetails.length) {
      lines.push(
        `   ... and ${String(attention.pendingAnomalies - attention.pendingAnomalyDetails.length)} more in /coach/anomalies/`,
      );
    }
  } else if (attention.pendingAnomalies > 0) {
    lines.push(
      `Pending anomalies: ${String(attention.pendingAnomalies)} (check /coach/anomalies/)`,
    );
  }

  if (attention.pendingPatternFlags > 0) {
    lines.push(
      `Pattern flags: ${String(attention.pendingPatternFlags)} (recurring patterns detected — consider creating a skill via compose-skill)`,
    );
  }

  // Recent eval results
  if (attention.recentEvalResults && attention.recentEvalResults.length > 0) {
    lines.push('');
    lines.push('Recent evaluation results:');
    for (const result of attention.recentEvalResults) {
      lines.push(`- ${result.procedureSlug}: ${result.verdict} (score: ${String(result.overall)})`);
    }
  }

  // Skills with quality flags — schema-valid but underspecified.
  // Surfaced so the Helmsman can offer Coach review when the operator
  // activates one or asks about it. Listed before degraded skills since
  // these still run; they're a soft signal, not a hard block.
  if (attention.skillQualityFlags && attention.skillQualityFlags.length > 0) {
    lines.push('');
    lines.push(
      `## Skills that may benefit from Coach review (${String(attention.skillQualityFlags.length)})`,
    );
    lines.push(
      'These skills are schema-valid but underspecified relative to current authoring standards. If the operator activates one or asks about it, you may suggest "let\'s have the Coach review this skill" — the Coach can propose update_task_context_spec ops to compile the goal prose into structured capability grants.',
    );
    for (const f of attention.skillQualityFlags) {
      lines.push(
        `- ${f.slug}: tasks have no \`context.capabilities\` declarations (${String(f.taskIds.length)} task${f.taskIds.length === 1 ? '' : 's'}). Tools/APIs are inferred from goal prose only.`,
      );
    }
  }

  // Skills needing repair — surfaced so the Helmsman doesn't activate
  // them and so it can suggest a repair path to the operator. Listed
  // before the Skills section so it's read as an exclusion filter.
  if (attention.degradedSkills && attention.degradedSkills.length > 0) {
    lines.push('');
    lines.push(`## Skills needing repair (${String(attention.degradedSkills.length)})`);
    lines.push(
      'Do NOT attempt to activate these — their contract is invalid against current rules. The fix is an in-place Coach patch (update_* ops against the skill), not a reinstall; the diagnostic names what broke.',
    );
    for (const d of attention.degradedSkills) {
      lines.push(`- ${d.slug}: ${d.validationError}`);
    }
  }

  if (attention.skills && attention.skills.length > 0) {
    lines.push('');
    lines.push(`## Skill usage (${String(attention.skills.length)})`);
    lines.push(
      'Skills with recent runs (full inventory + input contracts in SpaceContext.skills):',
    );
    for (const skill of attention.skills) {
      lines.push(`- ${skill.slug}: ${String(skill.usageCount)} runs`);
    }
  }

  return lines.join('\n');
}
