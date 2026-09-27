import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import {
  createMemoryDocRepository,
  createTenantContext,
  spaces,
  withTenantSchema,
} from '@aflow/database';
import { appendEntityEvent, publishActionCenterWake } from '@aflow/redis';
import { recordCoachRatificationApplyError } from '@aflow/observability';
import {
  applyRatifiedOps,
  computeProposalFingerprint,
  onProposalRatified,
  persistRatificationError,
  proactiveStalenessSweep,
  PROPOSAL_DIRS,
  proposalPath,
  RatificationApplyError,
  recordRejectedFingerprint,
  tryParseStagedChangeDoc,
  type ApplyResult,
} from '@aflow/cybernetic-runtime';
import {
  EntityDirectivesSchema,
  type EntityEventType,
  type PostInstallTask,
  type StagedChange,
  type TenantId,
} from '@aflow/schemas';

// ============================================================================
// Public surface
// ============================================================================

export interface ProposalResolutionDeps {
  db: PostgresJsDatabase;
  /** Optional — when null, event emission + fingerprint writes are skipped (best-effort). */
  redis: Redis | null;
  /** Persists an over-inline-cap artifact source when a ratified op installs one. */
  payloadStore?: PayloadStore | undefined;
}

export interface ProposalResolutionCtx {
  tenantId: TenantId;
  spaceId: string;
  /** Acting user (or 'operator' string when the surface lacks an auth user). */
  resolvedBy: string;
}

export type ProposalResolutionResult<S extends 'ratified' | 'rejected' | 'dismissed'> =
  | {
      ok: true;
      status: S;
      stagedChangeId: string;
      /** Post-install setup tasks from a store_install apply — render on the ratifying surface. */
      setupChecklist?: PostInstallTask[];
    }
  | ProposalResolutionFailure;

export type ProposalResolutionFailure =
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'ALREADY_RESOLVED'; status: string }
  | { ok: false; code: 'PROPOSAL_NOT_RATIFIABLE'; detail: string }
  | { ok: false; code: 'PROPOSAL_NOT_DISMISSIBLE'; detail: string }
  | { ok: false; code: 'USE_DISMISS_FOR_PLATFORM_ISSUE'; detail: string }
  | { ok: false; code: 'STALE'; stale: NonNullable<ApplyResult['stale']> }
  | { ok: false; code: 'RATIFICATION_APPLY_FAILED'; error: RatificationApplyError }
  | { ok: false; code: 'APPLY_FAILED'; detail: string };

export interface RatifyOptions {
  /**
   * When true, strip preconditions before applyRatifiedOps so the apply
   * proceeds even on stale preconditions (operator has reviewed the
   * Apply-anyway confirmation). Defaults to false.
   */
  force?: boolean;
}

export interface RejectOptions {
  reason?: string;
}

export interface DismissOptions {
  dismissReason?: string;
}

// ============================================================================
// Doc helpers (canonical home — replaces the local copies in routes &
// the Action Center source)
// ============================================================================

export async function loadProposal(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  proposalId: string,
): Promise<StagedChange | null> {
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  for (const dir of PROPOSAL_DIRS) {
    const path = `${dir}/${proposalId}.json`;
    const doc = await docRepo.getByPath(path, spaceId);
    if (!doc?.inlineContent) continue;
    const parsed = tryParseStagedChangeDoc(doc.inlineContent, {
      tenantId,
      spaceId,
      docPath: path,
      reader: 'proposalResolution.loadProposal',
    });
    if (parsed.ok) return parsed.staged;
    // fall through to the other dir (matches prior catch behaviour) — the
    // helper has already emitted the warn+counter.
  }
  return null;
}

export async function persistProposal(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  proposalId: string,
  updated: StagedChange,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const path = proposalPath(updated.resolutionRoute, proposalId);
  const content = JSON.stringify(updated, null, 2);
  await docRepo.put({
    path,
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: content,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    contentHash: '',
    preview: content.substring(0, 200),
    tags:
      updated.resolutionRoute === 'platform_issue'
        ? ['coach', 'platform-issue']
        : ['coach', 'staged'],
    summary: updated.proposal.summary,
    semanticType: 'staged_change',
    indexing: 'disabled',
    scope: { spaceId },
    provenance: { actor: 'system:proposal-resolution' },
  });
}

// ============================================================================
// Ratify
// ============================================================================

export async function ratifyProposal(
  deps: ProposalResolutionDeps,
  ctx: ProposalResolutionCtx,
  proposalId: string,
  options: RatifyOptions = {},
): Promise<ProposalResolutionResult<'ratified'>> {
  const sc = await loadProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId);
  if (!sc) return { ok: false, code: 'NOT_FOUND' };
  if (sc.status !== 'proposed') {
    return { ok: false, code: 'ALREADY_RESOLVED', status: sc.status };
  }
  if (sc.resolutionRoute !== 'tenant_ratification') {
    return {
      ok: false,
      code: 'PROPOSAL_NOT_RATIFIABLE',
      detail:
        `Proposal targets a platform-origin workflow ` +
        `(${sc.targetWorkflowSlug ?? 'unknown'}). Platform issues are tracked under ` +
        `/coach/platform-issues/ and require code changes — they cannot be ratified ` +
        `from a tenant space.`,
    };
  }

  const now = new Date();

  // Apply ops — all-or-nothing. force=true strips preconditions for
  // operator-confirmed "Apply anyway" flows.
  let applyResult: ApplyResult;
  try {
    const forApply = options.force ? { ...sc, preconditions: undefined } : sc;
    applyResult = await applyRatifiedOps(
      {
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        db: deps.db,
        ...(deps.redis ? { redis: deps.redis } : {}),
        actorUserId: ctx.resolvedBy,
        payloadStore: deps.payloadStore,
      },
      forApply,
    );
  } catch (err) {
    if (err instanceof RatificationApplyError) {
      try {
        await persistRatificationError(
          { tenantId: ctx.tenantId, spaceId: ctx.spaceId, db: deps.db },
          sc,
          err,
        );
      } catch {
        /* best-effort */
      }
      if (deps.redis) {
        await safeAppendEntityEvent(deps.redis, {
          tenantId: ctx.tenantId,
          spaceId: ctx.spaceId,
          eventType: 'entity.coach.ratification_failed',
          payload: {
            stagedChangeId: proposalId,
            kind: sc.kind,
            reason: err.reason,
            op: err.op,
          },
          summary: `Ratification apply failed: ${err.op} (${err.reason})`,
        });
        await safeAppendEntityEvent(deps.redis, {
          tenantId: ctx.tenantId,
          spaceId: ctx.spaceId,
          eventType: 'entity.coach.apply_failed',
          payload: {
            stagedChangeId: proposalId,
            kind: sc.kind,
            targetSlug: sc.targetWorkflowSlug ?? null,
            reason: err.reason,
            op: err.op,
            detail: err.detail,
          },
          summary:
            `Apply failed after ratification: ${err.op} (${err.reason}) — ${err.detail}`.slice(
              0,
              500,
            ),
        });
      }
      try {
        recordCoachRatificationApplyError({
          tenant_id: ctx.tenantId,
          space_id: ctx.spaceId,
          error_code: err.reason,
        });
      } catch {
        /* metrics emit must not abort */
      }
      return { ok: false, code: 'RATIFICATION_APPLY_FAILED', error: err };
    }
    // Generic apply failure — also worth a counter bump under a
    // distinct `error_code` so a spike here is visible without
    // hiding behind the structured-error bucket.
    try {
      recordCoachRatificationApplyError({
        tenant_id: ctx.tenantId,
        space_id: ctx.spaceId,
        error_code: 'apply_failed_generic',
      });
    } catch {
      /* metrics emit must not abort */
    }
    return {
      ok: false,
      code: 'APPLY_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (applyResult.stale) {
    // Persist staleness; status stays 'proposed'. Operator can Regenerate
    // or Apply-anyway via force=true.
    const stalePatched: StagedChange = {
      ...sc,
      rebaseState: 'stale',
      staleDetails: {
        detectedAt: now.toISOString(),
        conflictingOpIndices: applyResult.stale.conflicts.map((c) => c.opIndex),
        conflicts: applyResult.stale.conflicts,
      },
    };
    await persistProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId, stalePatched);
    if (deps.redis) {
      await safeAppendEntityEvent(deps.redis, {
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        eventType: 'entity.coach.ratification_failed',
        payload: {
          stagedChangeId: proposalId,
          kind: sc.kind,
          reason: 'stale',
          op: applyResult.stale.conflicts[0]?.opKind ?? 'unknown',
        },
        summary: 'Ratification skipped: proposal is stale (preconditions failed).',
      });
    }
    return { ok: false, code: 'STALE', stale: applyResult.stale };
  }

  // Emit ratified event + binding event + causal hook BEFORE persisting
  // status — this preserves the existing route's ordering invariant
  // (events fire even on apply success; persist is the commit point).
  const resolvedSubjectId = resolveSubjectId(sc, proposalId);
  if (deps.redis) {
    await safeAppendEntityEvent(deps.redis, {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      eventType: 'entity.coach.ratified',
      payload: {
        stagedChangeId: proposalId,
        kind: sc.kind,
        resolvedBy: ctx.resolvedBy,
        targetWorkflowSlug: sc.targetWorkflowSlug ?? resolvedSubjectId,
        ...(sc.source ? { source: sc.source } : {}),
        ...(sc.evidence.diagnosis?.issueCategory
          ? { issueCategory: sc.evidence.diagnosis.issueCategory }
          : {}),
      },
      summary: `Proposal ratified: ${sc.proposal.summary}`,
    });

    if (sc.kind === 'capability_binding') {
      const bindingOp = sc.proposal.ops[0];
      await safeAppendEntityEvent(deps.redis, {
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        eventType: 'entity.binding.ratified',
        payload: {
          kind: 'api',
          apiId: bindingOp && 'apiId' in bindingOp ? bindingOp.apiId : resolvedSubjectId,
          phase: 'definition_only',
        },
        summary: `API definition ratified: ${sc.proposal.summary}`,
      });
    }

    try {
      const directives = await loadDirectives(deps.db, ctx.tenantId, ctx.spaceId);
      const causalWindow = directives
        ? directives.learningPolicy.causalWindow
        : 7 * 24 * 60 * 60 * 1000;
      const measurementWindow = sc.evidence.warrant?.evaluationWindowMs ?? causalWindow;
      const subjectKind = sc.kind === 'eval_criterion_change' ? 'eval' : 'skill';
      await onProposalRatified(
        { tenantId: ctx.tenantId, spaceId: ctx.spaceId, db: deps.db, redis: deps.redis },
        {
          proposalId,
          subjectKind,
          subjectId: resolvedSubjectId,
          ratifiedAt: now,
          windowMs: measurementWindow,
          ...(sc.evidence.diagnosis?.issueCategory
            ? { issueCategory: sc.evidence.diagnosis.issueCategory }
            : {}),
        },
      );
    } catch {
      /* best-effort */
    }
  }

  // Persist ratified status last.
  const updated: StagedChange = {
    ...sc,
    status: 'ratified',
    resolvedAt: now.toISOString(),
    resolvedBy: ctx.resolvedBy,
  };
  await persistProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId, updated);

  // The ratified entity event deliberately fires before this commit point, so
  // a rebuild it triggers can still read status='proposed'. This wake is the
  // post-commit signal that the card is really gone.
  if (deps.redis) {
    publishActionCenterWake(deps.redis, {
      source: 'proposal_ratified',
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
    });
  }

  // Proactive staleness sweep on sibling proposals — best-effort.
  if (sc.targetWorkflowSlug) {
    try {
      await proactiveStalenessSweep(
        { tenantId: ctx.tenantId, spaceId: ctx.spaceId, db: deps.db },
        { slug: sc.targetWorkflowSlug, excludeProposalId: proposalId },
      );
    } catch {
      /* best-effort */
    }
  }

  return {
    ok: true,
    status: 'ratified',
    stagedChangeId: proposalId,
    ...(applyResult.setupChecklist !== undefined
      ? { setupChecklist: applyResult.setupChecklist }
      : {}),
  };
}

// ============================================================================
// Reject
// ============================================================================

export async function rejectProposal(
  deps: ProposalResolutionDeps,
  ctx: ProposalResolutionCtx,
  proposalId: string,
  options: RejectOptions = {},
): Promise<ProposalResolutionResult<'rejected'>> {
  const sc = await loadProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId);
  if (!sc) return { ok: false, code: 'NOT_FOUND' };
  if (sc.status !== 'proposed') {
    return { ok: false, code: 'ALREADY_RESOLVED', status: sc.status };
  }
  if (sc.resolutionRoute === 'platform_issue') {
    return {
      ok: false,
      code: 'USE_DISMISS_FOR_PLATFORM_ISSUE',
      detail:
        `Proposal has resolutionRoute='platform_issue'. Use dismiss — reject would record a ` +
        `fingerprint and suppress future similar diagnostics, which is wrong for unpatched ` +
        `platform defects.`,
    };
  }

  const now = new Date();
  const updated: StagedChange = {
    ...sc,
    status: 'rejected',
    resolvedAt: now.toISOString(),
    resolvedBy: ctx.resolvedBy,
  };
  await persistProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId, updated);

  if (deps.redis) {
    await safeAppendEntityEvent(deps.redis, {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      eventType: 'entity.coach.rejected',
      payload: {
        stagedChangeId: proposalId,
        kind: sc.kind,
        resolvedBy: ctx.resolvedBy,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        targetWorkflowSlug: sc.targetWorkflowSlug,
        ...(sc.source ? { source: sc.source } : {}),
        ...(sc.evidence.diagnosis?.issueCategory
          ? { issueCategory: sc.evidence.diagnosis.issueCategory }
          : {}),
      },
      summary: `Proposal rejected: ${sc.proposal.summary}`,
    });

    try {
      const fp = computeProposalFingerprint(sc.proposal.ops, sc.targetWorkflowSlug);
      await recordRejectedFingerprint(
        deps.redis,
        ctx.spaceId,
        fp,
        now.getTime(),
        proposalId,
        7 * 24 * 60 * 60 * 1000,
      );
    } catch {
      /* best-effort */
    }
  }

  return { ok: true, status: 'rejected', stagedChangeId: proposalId };
}

// ============================================================================

export async function dismissProposal(
  deps: ProposalResolutionDeps,
  ctx: ProposalResolutionCtx,
  proposalId: string,
  options: DismissOptions = {},
): Promise<ProposalResolutionResult<'dismissed'>> {
  const sc = await loadProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId);
  if (!sc) return { ok: false, code: 'NOT_FOUND' };
  if (sc.status !== 'proposed') {
    return { ok: false, code: 'ALREADY_RESOLVED', status: sc.status };
  }
  if (sc.resolutionRoute !== 'platform_issue') {
    return {
      ok: false,
      code: 'PROPOSAL_NOT_DISMISSIBLE',
      detail:
        `Proposal has resolutionRoute='${sc.resolutionRoute}'. ` +
        `Only platform_issue diagnostics are dismissible — tenant_ratification ` +
        `proposals must use ratify or reject.`,
    };
  }

  const now = new Date();
  const updated: StagedChange = {
    ...sc,
    status: 'dismissed',
    resolvedAt: now.toISOString(),
    resolvedBy: ctx.resolvedBy,
  };
  await persistProposal(deps.db, ctx.tenantId, ctx.spaceId, proposalId, updated);

  if (deps.redis) {
    await safeAppendEntityEvent(deps.redis, {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      eventType: 'entity.coach.platform_issue_acknowledged',
      payload: {
        stagedChangeId: proposalId,
        kind: sc.kind,
        resolvedBy: ctx.resolvedBy,
        ...(options.dismissReason !== undefined ? { dismissReason: options.dismissReason } : {}),
        targetWorkflowSlug: sc.targetWorkflowSlug,
        ...(sc.source ? { source: sc.source } : {}),
        ...(sc.evidence.diagnosis?.issueCategory
          ? { issueCategory: sc.evidence.diagnosis.issueCategory }
          : {}),
      },
      summary: `Platform issue acknowledged: ${sc.proposal.summary}`,
    });
  }

  return { ok: true, status: 'dismissed', stagedChangeId: proposalId };
}

// ============================================================================
// Internal helpers
// ============================================================================

interface EntityEventBlock {
  tenantId: TenantId;
  spaceId: string;
  eventType: EntityEventType;
  payload: Record<string, unknown>;
  summary: string;
}

async function safeAppendEntityEvent(redis: Redis, block: EntityEventBlock): Promise<void> {
  try {
    await appendEntityEvent(redis, {
      tenantId: block.tenantId,
      spaceId: block.spaceId,
      event: {
        eventId: randomUUID(),
        eventType: block.eventType,
        spaceId: block.spaceId,
        tenantId: block.tenantId,
        timestamp: Date.now(),
        operatingMode: 'supervisory',
        payload: block.payload,
        summary: block.summary,
      },
    });
  } catch {
    /* best-effort — event misses are logged at a higher layer */
  }
}

/** Resolve the subject id used for causal measurement binding. */
function resolveSubjectId(sc: StagedChange, proposalId: string): string {
  if (sc.kind === 'skill_compose') {
    const op = sc.proposal.ops[0];
    if (op?.op === 'skill_compose') return op.bundle.workflow.slug;
  }
  return sc.targetWorkflowSlug ?? proposalId;
}

async function loadDirectives(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
): Promise<ReturnType<typeof EntityDirectivesSchema.parse> | undefined> {
  try {
    const tenantCtx = createTenantContext(tenantId);
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ directives: spaces.directives })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .limit(1),
    );
    const raw = rows[0]?.directives;
    if (!raw) return undefined;
    const parsed = EntityDirectivesSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
