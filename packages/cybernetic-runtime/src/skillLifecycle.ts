import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, sql, isNull, isNotNull, like, inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  SkillManifestSchema,
  SkillTombstoneSchema,
  type SkillManifest,
  type SkillTombstone,
  SKILL_TOMBSTONE_DOC_TYPE,
  skillTombstonePath,
} from '@aflow/schemas';
import {
  createTenantContext,
  createMemoryDocRepository,
  withTenantSchema,
  memoryDocs,
  workflowRuns,
  workflowRunTasks,
  userFeedback,
  causalMeasurements,
  tenantAuditLog,
} from '@aflow/database';
import { isPlatformSkillId } from '@aflow/platform-artifacts';
import { getCyberneticLogger } from './logger.js';
import { deriveRunLiveness, type RunLiveness } from './scheduling/runLiveness.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from './scheduling/types.js';
import { toTaskRow } from './ledger/queries.js';

// ============================================================================
// Errors
// ============================================================================

export type SkillLifecycleErrorCode =
  | 'SKILL_NOT_FOUND'
  | 'SKILL_NOT_ARCHIVED'
  | 'SKILL_HAS_ACTIVE_RUNS'
  | 'SKILL_HAS_LIVE_RUNS'
  | 'SKILL_HAS_HISTORICAL_RUNS'
  | 'PLATFORM_ARTIFACT_READ_ONLY'
  | 'WORKFLOW_DOC_MISSING';

export class SkillLifecycleError extends Error {
  readonly code: SkillLifecycleErrorCode;
  readonly details: Record<string, unknown>;
  constructor(
    code: SkillLifecycleErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SkillLifecycleError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Context
// ============================================================================

export interface SkillLifecycleContext {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  /** Actor who initiated the op. Recorded in audit-log entries when written. */
  actorUserId?: string | null;
}

// ============================================================================
// Path helpers
//
// Eval-related paths follow the existing layout used by `skillComposeApply.ts`
// and `evalRunner.ts`: `/evals/{slug}/suite.json`, `/evals/{slug}/baseline.json`,
// and `/evals/{slug}/results/{runId}.json`. Earlier drafts of this file
// incorrectly placed the eval suite under `/workflows/{slug}/eval-suite.json`
// — that path is never written by any code today.
// ============================================================================

const manifestPath = (skillId: string): string => `/skills/${skillId}/manifest.json`;
const projectionPath = (skillId: string): string => `/skills/${skillId}/projection.json`;
const workflowDocPath = (slug: string): string => `/workflows/${slug}/workflow.json`;
const evalSuitePath = (slug: string): string => `/evals/${slug}/suite.json`;
const evalBaselinePath = (slug: string): string => `/evals/${slug}/baseline.json`;
const activationPath = (slug: string): string => `/workflows/${slug}/activation.json`;
const revisionsPrefix = (slug: string): string => `/workflows/${slug}/revisions/`;

/** Tag we attach to every Coach proposal that archive soft-closes, so unarchive
 * restores ONLY those proposals — not unrelated soft-deleted proposed docs.
 * Stored on `memory_docs.tags` (jsonb array of strings). The skill-id suffix
 * makes the tag specific so two concurrent archives in the same space don't
 * collide. */
const archiveCloseTag = (skillId: string): string => `lifecycle:closed-by-archive:${skillId}`;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Read a manifest doc directly via Drizzle (so we can include soft-deleted
 * rows when needed). The repo's `getByPath` filters `deleted_at IS NULL`
 * unconditionally; for unarchive/purge we need to find soft-deleted rows.
 */
async function readManifestRaw(
  tx: PostgresJsDatabase,
  spaceId: string,
  skillId: string,
  opts: { includeDeleted: boolean },
): Promise<{ id: string; inlineContent: string | null; deletedAt: Date | null } | null> {
  const path = manifestPath(skillId);
  const conds = [eq(memoryDocs.path, path), eq(memoryDocs.spaceId, spaceId)];
  if (!opts.includeDeleted) conds.push(isNull(memoryDocs.deletedAt));
  const [row] = await tx
    .select({
      id: memoryDocs.id,
      inlineContent: memoryDocs.inlineContent,
      deletedAt: memoryDocs.deletedAt,
    })
    .from(memoryDocs)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

function parseManifest(inlineContent: string | null): SkillManifest | null {
  if (!inlineContent) return null;
  try {
    const raw: unknown = JSON.parse(inlineContent);
    const parsed = SkillManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Acquire a row-level FOR UPDATE lock on the workflow doc — the §4.4
 * sentinel that `recordRunStart` also takes. If the doc is missing, the
 * caller decides whether to fail (archive, purge) or treat as no-op.
 *
 * Includes soft-deleted rows so unarchive/purge can lock them too.
 */
async function lockWorkflowDoc(
  tx: PostgresJsDatabase,
  spaceId: string,
  workflowSlug: string,
): Promise<{ id: string; deletedAt: Date | null } | null> {
  const path = workflowDocPath(workflowSlug);
  const [row] = await tx
    .select({ id: memoryDocs.id, deletedAt: memoryDocs.deletedAt })
    .from(memoryDocs)
    .where(and(eq(memoryDocs.path, path), eq(memoryDocs.spaceId, spaceId)))
    .for('update')
    .limit(1);
  return row ?? null;
}

async function countActiveRuns(
  tx: PostgresJsDatabase,
  spaceId: string,
  workflowSlug: string,
): Promise<{ count: number; runIds: string[] }> {
  const rows = await tx
    .select({ runId: workflowRuns.runId })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.spaceId, spaceId),
        eq(workflowRuns.workflowSlug, workflowSlug),
        inArray(workflowRuns.status, ['running', 'paused']),
      ),
    );
  return { count: rows.length, runIds: rows.map((r) => r.runId) };
}

/**
 * Tx-scoped variant of `loadRunById` for use inside `archiveSkill`'s
 * transaction. We can't call the public `loadRunById` because it opens its
 * own `withTenantSchema` block; nesting would deadlock. The data needed
 * for `deriveRunLiveness` is the run row + task rows.
 */
async function loadRunForLiveness(
  tx: PostgresJsDatabase,
  spaceId: string,
  runId: string,
): Promise<WorkflowRunDetail | null> {
  const [runRow] = await tx
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.spaceId, spaceId), eq(workflowRuns.runId, runId)))
    .limit(1);
  if (!runRow) return null;

  const taskRows = await tx
    .select()
    .from(workflowRunTasks)
    .where(eq(workflowRunTasks.runId, runId));

  const tasks: WorkflowTaskRow[] = taskRows.map(toTaskRow);

  return {
    id: runRow.id,
    spaceId: runRow.spaceId,
    workflowSlug: runRow.workflowSlug,
    runId: runRow.runId,
    sessionId: runRow.sessionId,
    status: runRow.status,
    workflowRevision: runRow.workflowRevision,
    startedAt: runRow.startedAt,
    completedAt: runRow.completedAt,
    totalCostCents: runRow.totalCostCents,
    totalTokens: runRow.totalTokens,
    pausedReason: runRow.pausedReason,
    pausedPayloadRef: runRow.pausedPayloadRef,
    pauseVersion: runRow.pauseVersion,
    resumeAttemptCount: runRow.resumeAttemptCount,
    cancelledBy: runRow.cancelledBy,
    cancelReason: runRow.cancelReason,
    learningCount: Array.isArray(runRow.learningsJson) ? runRow.learningsJson.length : 0,
    score: runRow.score,
    evalBatchId: runRow.evalBatchId,
    evaluationJson: runRow.evaluationJson,
    failureJson: runRow.failureJson,
    learningsJson: runRow.learningsJson,
    schedulerCursorAt: runRow.schedulerCursorAt,
    metadata: runRow.metadata,
    tasks,
  };
}

export interface ActiveRunClassification {
  runId: string;
  liveness: RunLiveness;
  reason: string;
}

export function classifyRunsByLiveness(
  details: WorkflowRunDetail[],
  opts?: { now?: Date; staleThresholdMs?: number },
): { stalled: ActiveRunClassification[]; live: ActiveRunClassification[] } {
  const stalled: ActiveRunClassification[] = [];
  const live: ActiveRunClassification[] = [];
  for (const detail of details) {
    const result = deriveRunLiveness(detail, opts);
    const entry: ActiveRunClassification = {
      runId: detail.runId,
      liveness: result.liveness,
      reason: result.reason,
    };
    if (result.liveness === 'stalled') {
      stalled.push(entry);
    } else {
      // 'executing', 'waiting_for_input', 'idle' — all NOT force-cancellable.
      // 'idle' is the subtle case: transient pre-dispatch state. Don't gamble.
      live.push(entry);
    }
  }
  return { stalled, live };
}

/**
 * DB-bound wrapper used inside `archiveSkill`'s tx. Loads each run's detail
 * and delegates to `classifyRunsByLiveness` for the pure classification.
 */
async function classifyActiveRuns(
  tx: PostgresJsDatabase,
  spaceId: string,
  runIds: string[],
): Promise<{ stalled: ActiveRunClassification[]; live: ActiveRunClassification[] }> {
  const details: WorkflowRunDetail[] = [];
  for (const runId of runIds) {
    const detail = await loadRunForLiveness(tx, spaceId, runId);
    if (detail) details.push(detail);
    // else: vanished mid-tx (very unlikely under our lock); skip.
  }
  return classifyRunsByLiveness(details);
}

/**
 * Cancel a stale workflow run as part of archive's transaction. Sets
 * status='cancelled', completed_at=NOW(), and marks the cancellation
 * provenance in metadata so future audits can attribute the cancel to
 * archive (not operator-initiated). Same tx as the rest of archive — if
 * archive rolls back, the cancel rolls back too.
 */
async function forceCancelRunInTx(
  tx: PostgresJsDatabase,
  spaceId: string,
  runId: string,
  skillId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE ${workflowRuns}
      SET status = 'cancelled',
          completed_at = NOW(),
          metadata = COALESCE(metadata, '{}'::jsonb) ||
            ${JSON.stringify({ cancelledByArchive: true, archivedSkillId: skillId, cancelledAt: new Date().toISOString() })}::jsonb
      WHERE space_id = ${spaceId}
        AND run_id = ${runId}
        AND status IN ('running', 'paused')
  `);
}

async function writeAuditLog(
  tx: PostgresJsDatabase,
  params: {
    spaceId: string;
    skillId: string;
    actorUserId: string | null | undefined;
    action: 'skill.archived' | 'skill.unarchived' | 'skill.purged';
    details: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(tenantAuditLog).values({
    actorId: params.actorUserId ?? null,
    actorKind: params.actorUserId ? 'human' : 'system',
    category: 'admin',
    action: params.action,
    outcome: 'success',
    resourceType: 'skill',
    resourceId: params.skillId,
    spaceId: params.spaceId,
    details: params.details,
  });
}

async function countHistoricalRuns(
  tx: PostgresJsDatabase,
  spaceId: string,
  workflowSlug: string,
): Promise<number> {
  const rows = await tx
    .select({ runId: workflowRuns.runId })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.spaceId, spaceId), eq(workflowRuns.workflowSlug, workflowSlug)));
  return rows.length;
}

// ============================================================================
// archiveSkill
// ============================================================================

export interface ArchiveSkillOptions {
  force?: boolean;
}

export interface ArchiveSkillResult {
  skillId: string;
  archivedAt: string;
  softDeletedDocPaths: string[];
  closedProposalCount: number;
  /** Run IDs that were force-cancelled by archive. Empty unless force=true. */
  forceCancelledRunIds: string[];
}

export async function archiveSkill(
  ctx: SkillLifecycleContext,
  skillId: string,
  opts: ArchiveSkillOptions = {},
): Promise<ArchiveSkillResult> {
  if (isPlatformSkillId(skillId)) {
    throw new SkillLifecycleError(
      'PLATFORM_ARTIFACT_READ_ONLY',
      `Platform skill '${skillId}' cannot be archived through this surface.`,
    );
  }

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    // 1. Read the manifest including soft-deleted (idempotency). If the
    //    manifest is already soft-deleted, return the existing archivedAt
    //    with empty counts — re-archive must be a no-op success.
    const manifestRow = await readManifestRaw(tx, ctx.spaceId, skillId, { includeDeleted: true });
    if (!manifestRow) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' not found in space '${ctx.spaceId}'.`,
      );
    }
    const manifest = parseManifest(manifestRow.inlineContent);
    if (!manifest) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' manifest is unparseable.`,
      );
    }
    if (manifestRow.deletedAt) {
      // Already archived — idempotent no-op (registered as `idempotency: 'idempotent'`).
      return {
        skillId,
        archivedAt: manifestRow.deletedAt.toISOString(),
        softDeletedDocPaths: [],
        closedProposalCount: 0,
        forceCancelledRunIds: [],
      };
    }
    const slug = manifest.workflowSlug;

    // 2. Take FOR UPDATE lock on the workflow doc. recordRunStart takes the
    //    same lock, so this serializes against new run starts.
    const wfRow = await lockWorkflowDoc(tx, ctx.spaceId, slug);
    if (!wfRow) {
      throw new SkillLifecycleError(
        'WORKFLOW_DOC_MISSING',
        `Workflow doc '/workflows/${slug}/workflow.json' missing — skill is in an inconsistent state.`,
      );
    }

    // 3. Re-check active runs while holding the lock.
    const active = await countActiveRuns(tx, ctx.spaceId, slug);
    const forceCancelledRunIds: string[] = [];
    if (active.count > 0) {
      if (!opts.force) {
        throw new SkillLifecycleError(
          'SKILL_HAS_ACTIVE_RUNS',
          `Skill '${skillId}' has ${String(active.count)} active workflow run(s). ` +
            `Cancel them via workflow.run.cancel, or call archive ` +
            `with force=true to cancel STALLED runs only (refuses if any are still live).`,
          { runIds: active.runIds },
        );
      }

      // force=true — classify each active run by liveness. Only stalled
      // runs are eligible for force-cancel; executing/waiting/idle runs
      // refuse and the operator must cancel them deliberately.
      const { stalled, live } = await classifyActiveRuns(tx, ctx.spaceId, active.runIds);
      if (live.length > 0) {
        throw new SkillLifecycleError(
          'SKILL_HAS_LIVE_RUNS',
          `Skill '${skillId}' has ${String(live.length)} live workflow run(s) that ` +
            `force-archive cannot cancel: ${live.map((r) => `${r.runId} (${r.liveness})`).join(', ')}. ` +
            `Cancel them deliberately via workflow.run.cancel before archiving.`,
          {
            liveRuns: live.map((r) => ({
              runId: r.runId,
              liveness: r.liveness,
              reason: r.reason,
            })),
            stalledRuns: stalled.map((r) => r.runId),
          },
        );
      }

      // All active runs are stalled — cancel them in this tx.
      for (const s of stalled) {
        await forceCancelRunInTx(tx, ctx.spaceId, s.runId, skillId);
        forceCancelledRunIds.push(s.runId);
      }
      getCyberneticLogger().info('skill: force-cancelled stalled runs for archive', {
        skillId,
        workflowSlug: slug,
        cancelledRunIds: forceCancelledRunIds,
      });
    }

    const now = new Date();

    // 4. Update projection JSON in-place (status='archived', activationStatus='archived').
    await tx.execute(sql`
      UPDATE ${memoryDocs}
        SET inline_content = jsonb_set(
            jsonb_set(inline_content::jsonb, '{status}', '"archived"'),
            '{activationStatus}', '"archived"'
          )::text,
            updated_at = NOW()
        WHERE path = ${projectionPath(skillId)}
          AND space_id = ${ctx.spaceId}
          AND deleted_at IS NULL
    `);

    // 5. Soft-delete manifest + projection + workflow + eval suite + eval baseline +
    //    activation + all revisions. Eval suites live at /evals/{slug}/suite.json
    //    (not /workflows/{slug}/eval-suite.json which earlier drafts of this
    //    plan used by mistake — that path is never written by any caller).
    const exactPaths = [
      manifestPath(skillId),
      projectionPath(skillId),
      workflowDocPath(slug),
      evalSuitePath(slug),
      evalBaselinePath(slug),
      activationPath(slug),
    ];
    const softDeletedDocPaths: string[] = [];
    {
      const updated = await tx
        .update(memoryDocs)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(memoryDocs.spaceId, ctx.spaceId),
            isNull(memoryDocs.deletedAt),
            inArray(memoryDocs.path, exactPaths),
          ),
        )
        .returning({ path: memoryDocs.path });
      for (const r of updated) softDeletedDocPaths.push(r.path);

      const updatedRev = await tx
        .update(memoryDocs)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(memoryDocs.spaceId, ctx.spaceId),
            isNull(memoryDocs.deletedAt),
            like(memoryDocs.path, `${revisionsPrefix(slug)}%`),
          ),
        )
        .returning({ path: memoryDocs.path });
      for (const r of updatedRev) softDeletedDocPaths.push(r.path);
    }

    // 6. Soft-close staged proposals (status='proposed') targeting this slug.
    //    We tag each closed proposal with `archiveCloseTag(skillId)` so
    //    unarchive restores ONLY proposals archive itself closed — not
    //    unrelated soft-deleted proposed docs.
    const tag = archiveCloseTag(skillId);
    // Use server-side NOW() rather than ${now} — postgres-js can't infer the
    // type of a JS Date passed as an inline parameter via raw `sql` template
    // (no column metadata to cast against). The earlier soft-delete UPDATE
    // at step 5 uses Drizzle's typed `.update().set({deletedAt: now})`,
    // which handles the Date → timestamptz cast for us.
    const closedProposalsRows = await tx.execute<{ path: string }>(sql`
      UPDATE ${memoryDocs}
        SET deleted_at = NOW(),
            updated_at = NOW(),
            tags = COALESCE(tags, '[]'::jsonb) || ${JSON.stringify([tag])}::jsonb
        WHERE space_id = ${ctx.spaceId}
          AND deleted_at IS NULL
          AND (path LIKE '/coach/staged/%' OR path LIKE '/coach/platform-issues/%')
          AND inline_content::jsonb ->> 'targetWorkflowSlug' = ${slug}
          AND inline_content::jsonb ->> 'status' = 'proposed'
        RETURNING path
    `);
    const closedProposalCount = Array.isArray(closedProposalsRows) ? closedProposalsRows.length : 0;

    await writeAuditLog(tx, {
      spaceId: ctx.spaceId,
      skillId,
      actorUserId: ctx.actorUserId,
      action: 'skill.archived',
      details: {
        workflowSlug: slug,
        softDeletedDocPaths,
        closedProposalCount,
        ...(forceCancelledRunIds.length > 0 ? { forceCancelledRunIds, force: true } : {}),
      },
    });

    getCyberneticLogger().info('skill: archived', {
      skillId,
      workflowSlug: slug,
      softDeletedDocCount: softDeletedDocPaths.length,
      closedProposalCount,
      forceCancelledRunCount: forceCancelledRunIds.length,
      actorUserId: ctx.actorUserId ?? null,
    });

    return {
      skillId,
      archivedAt: now.toISOString(),
      softDeletedDocPaths,
      closedProposalCount,
      forceCancelledRunIds,
    };
  });
}

// ============================================================================
// unarchiveSkill
// ============================================================================

export interface UnarchiveSkillResult {
  skillId: string;
  restoredAt: string;
  restoredDocPaths: string[];
}

export async function unarchiveSkill(
  ctx: SkillLifecycleContext,
  skillId: string,
): Promise<UnarchiveSkillResult> {
  if (isPlatformSkillId(skillId)) {
    throw new SkillLifecycleError(
      'PLATFORM_ARTIFACT_READ_ONLY',
      `Platform skill '${skillId}' cannot be unarchived through this surface.`,
    );
  }

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    const manifestRow = await readManifestRaw(tx, ctx.spaceId, skillId, { includeDeleted: true });
    if (!manifestRow) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' not found (manifest missing — possibly purged).`,
      );
    }
    const manifest = parseManifest(manifestRow.inlineContent);
    if (!manifest) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' manifest is unparseable.`,
      );
    }
    if (!manifestRow.deletedAt) {
      // Already active — idempotent no-op (registered as `idempotency: 'idempotent'`).
      return {
        skillId,
        restoredAt: new Date().toISOString(),
        restoredDocPaths: [],
      };
    }
    const slug = manifest.workflowSlug;

    const wfRow = await lockWorkflowDoc(tx, ctx.spaceId, slug);
    if (!wfRow) {
      throw new SkillLifecycleError(
        'WORKFLOW_DOC_MISSING',
        `Workflow doc '/workflows/${slug}/workflow.json' missing — cannot unarchive.`,
      );
    }

    const now = new Date();
    const restoredDocPaths: string[] = [];

    // Clear deleted_at on manifest/projection/workflow/eval-suite/baseline/activation.
    const exactPaths = [
      manifestPath(skillId),
      projectionPath(skillId),
      workflowDocPath(slug),
      evalSuitePath(slug),
      evalBaselinePath(slug),
      activationPath(slug),
    ];
    {
      const updated = await tx
        .update(memoryDocs)
        .set({ deletedAt: null, updatedAt: now })
        .where(
          and(
            eq(memoryDocs.spaceId, ctx.spaceId),
            isNotNull(memoryDocs.deletedAt),
            inArray(memoryDocs.path, exactPaths),
          ),
        )
        .returning({ path: memoryDocs.path });
      for (const r of updated) restoredDocPaths.push(r.path);

      const updatedRev = await tx
        .update(memoryDocs)
        .set({ deletedAt: null, updatedAt: now })
        .where(
          and(
            eq(memoryDocs.spaceId, ctx.spaceId),
            isNotNull(memoryDocs.deletedAt),
            like(memoryDocs.path, `${revisionsPrefix(slug)}%`),
          ),
        )
        .returning({ path: memoryDocs.path });
      for (const r of updatedRev) restoredDocPaths.push(r.path);
    }

    // Reset projection status to 'dormant' (NOT 'active' — let the reconciler
    // re-evaluate on its next pass).
    await tx.execute(sql`
      UPDATE ${memoryDocs}
        SET inline_content = jsonb_set(inline_content::jsonb, '{status}', '"dormant"')::text,
            updated_at = NOW()
        WHERE path = ${projectionPath(skillId)}
          AND space_id = ${ctx.spaceId}
          AND deleted_at IS NULL
    `);

    // Restore staged proposals that THIS archive soft-closed. We scope by
    // the archive-close tag so we don't accidentally resurrect unrelated
    // soft-deleted proposed docs that happened to target the same slug.
    // The tag is also stripped on restore so a future re-archive starts clean.
    const tag = archiveCloseTag(skillId);
    await tx.execute(sql`
      UPDATE ${memoryDocs}
        SET deleted_at = NULL,
            updated_at = NOW(),
            tags = COALESCE(
              (SELECT jsonb_agg(t) FROM jsonb_array_elements(tags) t WHERE t::text != ${JSON.stringify(tag)}::text),
              '[]'::jsonb
            )
        WHERE space_id = ${ctx.spaceId}
          AND deleted_at IS NOT NULL
          AND tags @> ${JSON.stringify([tag])}::jsonb
    `);

    await writeAuditLog(tx, {
      spaceId: ctx.spaceId,
      skillId,
      actorUserId: ctx.actorUserId,
      action: 'skill.unarchived',
      details: {
        workflowSlug: slug,
        restoredDocPaths,
      },
    });

    getCyberneticLogger().info('skill: unarchived', {
      skillId,
      workflowSlug: slug,
      restoredDocCount: restoredDocPaths.length,
      actorUserId: ctx.actorUserId ?? null,
    });

    return {
      skillId,
      restoredAt: now.toISOString(),
      restoredDocPaths,
    };
  });
}

// ============================================================================
// purgeSkill
// ============================================================================

export interface PurgeSkillOptions {
  confirmRunHistoryDangling?: boolean;
}

export interface PurgeSkillResult {
  skillId: string;
  purgedAt: string;
  tombstonePath: string;
  deletedDocPaths: string[];
  deletedFeedbackCount: number;
  deletedCausalMeasurementCount: number;
  danglingRunCount: number;
}

export async function purgeSkill(
  ctx: SkillLifecycleContext,
  skillId: string,
  opts: PurgeSkillOptions = {},
): Promise<PurgeSkillResult> {
  if (isPlatformSkillId(skillId)) {
    throw new SkillLifecycleError(
      'PLATFORM_ARTIFACT_READ_ONLY',
      `Platform skill '${skillId}' cannot be purged through this surface.`,
    );
  }

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    const manifestRow = await readManifestRaw(tx, ctx.spaceId, skillId, { includeDeleted: true });
    if (!manifestRow) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' not found (manifest missing — possibly already purged).`,
      );
    }
    if (!manifestRow.deletedAt) {
      throw new SkillLifecycleError(
        'SKILL_NOT_ARCHIVED',
        `Skill '${skillId}' is not archived. Archive it first before purging.`,
      );
    }
    const manifest = parseManifest(manifestRow.inlineContent);
    if (!manifest) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' manifest is unparseable.`,
      );
    }
    const slug = manifest.workflowSlug;

    const wfRow = await lockWorkflowDoc(tx, ctx.spaceId, slug);
    if (!wfRow) {
      // Workflow doc missing — proceed with purge anyway, since we're
      // tearing everything down. There's nothing to lock.
    }

    // Historical-run gate.
    const historicalRunCount = await countHistoricalRuns(tx, ctx.spaceId, slug);
    if (historicalRunCount > 0 && !opts.confirmRunHistoryDangling) {
      throw new SkillLifecycleError(
        'SKILL_HAS_HISTORICAL_RUNS',
        `Skill '${skillId}' has ${String(historicalRunCount)} historical workflow run(s). ` +
          `Set confirmRunHistoryDangling=true to purge anyway and leave runs dangling.`,
        { historicalRunCount },
      );
    }

    const now = new Date();
    const tombstonePathStr = skillTombstonePath(skillId);

    // 1. Write tombstone FIRST so it survives the hard-delete sweep below.
    //    Using repo.put (constructed in-tx) instead of raw SQL — the
    //    earlier draft's INSERT referenced a nonexistent `scope_kind`
    //    column and miscast the tags array. The repo handles upsert
    //    against the real (path, space_id) uniqueness, soft-delete
    //    revival, and tag JSONB serialization correctly.
    const tombstone: SkillTombstone = {
      skillId,
      workflowSlug: slug,
      name: manifest.name,
      origin: manifest.origin,
      archivedAt: manifestRow.deletedAt.toISOString(),
      purgedAt: now.toISOString(),
      purgedByUserId: ctx.actorUserId ?? null,
      workflowRevision: 0, // best-effort; revision tracking is per-doc, not per-skill
      danglingRunCount: historicalRunCount,
    };
    SkillTombstoneSchema.parse(tombstone);
    const tombstoneJson = JSON.stringify(tombstone);
    const repo = createMemoryDocRepository(tx, tenantCtx, { inTransaction: true });
    await repo.put({
      path: tombstonePathStr,
      docType: SKILL_TOMBSTONE_DOC_TYPE,
      mimeType: 'application/json',
      inlineContent: tombstoneJson,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(tombstoneJson, 'utf8'),
      contentHash: '',
      preview: tombstoneJson.slice(0, 200),
      tags: ['skill', 'tombstone'],
      summary: null,
      scope: { spaceId: ctx.spaceId },
      writeMode: 'upsert',
      indexing: 'disabled',
    });

    // 2. Collect doc IDs to hard-delete: /skills/{skillId}/*,
    //    /workflows/{slug}/*, /evals/{slug}/* (suite, baseline, results),
    //    and /coach/staged or /coach/platform-issues docs targeting this
    //    slug. Exclude the tombstone we just wrote.
    const skillIdRows = await tx
      .select({ id: memoryDocs.id, path: memoryDocs.path })
      .from(memoryDocs)
      .where(
        and(eq(memoryDocs.spaceId, ctx.spaceId), like(memoryDocs.path, `/skills/${skillId}/%`)),
      );
    const wfRows = await tx
      .select({ id: memoryDocs.id, path: memoryDocs.path })
      .from(memoryDocs)
      .where(
        and(eq(memoryDocs.spaceId, ctx.spaceId), like(memoryDocs.path, `/workflows/${slug}/%`)),
      );
    // Eval *definition* docs only — `/evals/{slug}/suite.json` and
    // `/evals/{slug}/baseline.json`. We deliberately do NOT sweep
    // `/evals/{slug}/results/*`: those are per-run telemetry, owned by
    // historical run rows we preserve under §3 non-goal "preserving
    // historical workflow_runs". Wiping them here would lose data the
    // evals/run inspector still needs to render for surviving runs.
    const evalRows = await tx
      .select({ id: memoryDocs.id, path: memoryDocs.path })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, ctx.spaceId),
          inArray(memoryDocs.path, [evalSuitePath(slug), evalBaselinePath(slug)]),
        ),
      );
    const proposalRows = await tx
      .select({ id: memoryDocs.id, path: memoryDocs.path })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, ctx.spaceId),
          sql`(path LIKE '/coach/staged/%' OR path LIKE '/coach/platform-issues/%')`,
          sql`inline_content::jsonb ->> 'targetWorkflowSlug' = ${slug}`,
        ),
      );

    const collected = [...skillIdRows, ...wfRows, ...evalRows, ...proposalRows].filter(
      (r) => r.path !== tombstonePathStr,
    );

    // 3. Per-doc hardDelete via the existing repository helper (correct FK
    //    cascade: chunks → versions → doc). Reuses the tx via inTransaction.
    const deletedDocPaths: string[] = [];
    for (const r of collected) {
      const ok = await repo.hardDelete(r.id, ctx.spaceId);
      if (ok) deletedDocPaths.push(r.path);
    }

    // 4. Hard-delete telemetry rows (moved here from archive).
    const deletedFeedback = await tx
      .delete(userFeedback)
      .where(
        and(
          eq(userFeedback.spaceId, ctx.spaceId),
          eq(userFeedback.subjectKind, 'skill'),
          eq(userFeedback.subjectId, skillId),
        ),
      )
      .returning({ id: userFeedback.id });
    const deletedCausal = await tx
      .delete(causalMeasurements)
      .where(
        and(
          eq(causalMeasurements.spaceId, ctx.spaceId),
          eq(causalMeasurements.subjectKind, 'skill'),
          eq(causalMeasurements.subjectId, skillId),
        ),
      )
      .returning({ id: causalMeasurements.id });

    await writeAuditLog(tx, {
      spaceId: ctx.spaceId,
      skillId,
      actorUserId: ctx.actorUserId,
      action: 'skill.purged',
      details: {
        workflowSlug: slug,
        tombstonePath: tombstonePathStr,
        deletedDocPaths,
        deletedFeedbackCount: deletedFeedback.length,
        deletedCausalMeasurementCount: deletedCausal.length,
        danglingRunCount: historicalRunCount,
      },
    });

    getCyberneticLogger().info('skill: purged', {
      skillId,
      workflowSlug: slug,
      tombstonePath: tombstonePathStr,
      deletedDocCount: deletedDocPaths.length,
      deletedFeedbackCount: deletedFeedback.length,
      deletedCausalMeasurementCount: deletedCausal.length,
      danglingRunCount: historicalRunCount,
      actorUserId: ctx.actorUserId ?? null,
    });

    return {
      skillId,
      purgedAt: now.toISOString(),
      tombstonePath: tombstonePathStr,
      deletedDocPaths,
      deletedFeedbackCount: deletedFeedback.length,
      deletedCausalMeasurementCount: deletedCausal.length,
      danglingRunCount: historicalRunCount,
    };
  });
}

// ============================================================================
// previewSkill — read-only dry-run
// ============================================================================

export type PreviewKind = 'archive' | 'purge';

export interface PreviewSkillResult {
  skillId: string;
  kind: PreviewKind;
  isPlatformSkill: boolean;
  affectedDocPaths: string[];
  proposalsToClose: number;
  feedbackRowsToDelete: number;
  causalMeasurementsToDelete: number;
  historicalRunCount: number;
  activeRunCount: number;
}

export async function previewSkill(
  ctx: SkillLifecycleContext,
  skillId: string,
  kind: PreviewKind,
): Promise<PreviewSkillResult> {
  const isPlatform = isPlatformSkillId(skillId);
  if (isPlatform) {
    return {
      skillId,
      kind,
      isPlatformSkill: true,
      affectedDocPaths: [],
      proposalsToClose: 0,
      feedbackRowsToDelete: 0,
      causalMeasurementsToDelete: 0,
      historicalRunCount: 0,
      activeRunCount: 0,
    };
  }

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  return withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    const manifestRow = await readManifestRaw(tx, ctx.spaceId, skillId, { includeDeleted: true });
    if (!manifestRow) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' not found in space '${ctx.spaceId}'.`,
      );
    }
    const manifest = parseManifest(manifestRow.inlineContent);
    if (!manifest) {
      throw new SkillLifecycleError(
        'SKILL_NOT_FOUND',
        `Skill '${skillId}' manifest is unparseable.`,
      );
    }
    const slug = manifest.workflowSlug;

    // Affected docs: /skills/{id}/* and /workflows/{slug}/* prefixes plus
    // ONLY the eval definition docs (suite + baseline). Per §3 non-goal,
    // /evals/{slug}/results/* are run telemetry; archive doesn't touch
    // them and purge doesn't sweep them.
    const includeDeleted = kind === 'purge';
    const docConds = [
      eq(memoryDocs.spaceId, ctx.spaceId),
      sql`(${memoryDocs.path} LIKE ${'/skills/' + skillId + '/%'} OR ${memoryDocs.path} LIKE ${'/workflows/' + slug + '/%'} OR ${memoryDocs.path} = ${evalSuitePath(slug)} OR ${memoryDocs.path} = ${evalBaselinePath(slug)})`,
    ];
    if (!includeDeleted) docConds.push(isNull(memoryDocs.deletedAt));
    const affected = await tx
      .select({ path: memoryDocs.path })
      .from(memoryDocs)
      .where(and(...docConds));

    // Proposals to close (archive) or to also-delete (purge).
    const proposalConds = [
      eq(memoryDocs.spaceId, ctx.spaceId),
      sql`(${memoryDocs.path} LIKE '/coach/staged/%' OR ${memoryDocs.path} LIKE '/coach/platform-issues/%')`,
      sql`${memoryDocs.inlineContent}::jsonb ->> 'targetWorkflowSlug' = ${slug}`,
      sql`${memoryDocs.inlineContent}::jsonb ->> 'status' = 'proposed'`,
    ];
    if (!includeDeleted) proposalConds.push(isNull(memoryDocs.deletedAt));
    const proposals = await tx
      .select({ id: memoryDocs.id })
      .from(memoryDocs)
      .where(and(...proposalConds));

    const feedback = await tx
      .select({ id: userFeedback.id })
      .from(userFeedback)
      .where(
        and(
          eq(userFeedback.spaceId, ctx.spaceId),
          eq(userFeedback.subjectKind, 'skill'),
          eq(userFeedback.subjectId, skillId),
        ),
      );
    const causal = await tx
      .select({ id: causalMeasurements.id })
      .from(causalMeasurements)
      .where(
        and(
          eq(causalMeasurements.spaceId, ctx.spaceId),
          eq(causalMeasurements.subjectKind, 'skill'),
          eq(causalMeasurements.subjectId, skillId),
        ),
      );

    const historicalRunCount = await countHistoricalRuns(tx, ctx.spaceId, slug);
    const active = await countActiveRuns(tx, ctx.spaceId, slug);

    return {
      skillId,
      kind,
      isPlatformSkill: false,
      affectedDocPaths: affected.map((r) => r.path),
      proposalsToClose: proposals.length,
      feedbackRowsToDelete: feedback.length,
      causalMeasurementsToDelete: causal.length,
      historicalRunCount,
      activeRunCount: active.count,
    };
  });
}
