import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, or, desc, inArray, isNull, sql } from 'drizzle-orm';
import type { CoachLearning, LearnerConsolidationAction, TenantId } from '@aflow/schemas';
import { COACH_LEARNING_SUPERSEDES_MAX } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, coachLearnings } from '@aflow/database';
import type { CoachLearningRow } from '@aflow/database';

const DURABLE_STATUSES: ReadonlyArray<CoachLearning['status']> = ['auto_recorded', 'ratified'];

function rowToCoachLearning(row: CoachLearningRow): CoachLearning {
  const scope: CoachLearning['scope'] =
    row.scopeKind === 'campaign'
      ? { kind: 'campaign', campaignId: row.campaignId ?? '', skillSlug: row.skillSlug ?? '' }
      : row.scopeKind === 'skill'
        ? { kind: 'skill', skillSlug: row.skillSlug ?? '' }
        : { kind: 'space', spaceId: row.spaceId };
  return {
    learningId: row.id,
    coachSessionId: row.coachSessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    scope,
    kind: row.kind as CoachLearning['kind'],
    ...(row.appliesTo
      ? { appliesTo: row.appliesTo as NonNullable<CoachLearning['appliesTo']> }
      : {}),
    statement: row.statement,
    ...(row.detailRef ? { detailRef: row.detailRef } : {}),
    evidence: row.evidence as CoachLearning['evidence'],
    confidence: row.confidence as CoachLearning['confidence'],
    supersedes: Array.isArray(row.supersedes) ? (row.supersedes as string[]) : [],
    authorityLevel: row.authorityLevel as CoachLearning['authorityLevel'],
    status: row.status as CoachLearning['status'],
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    ...(row.resolvedBy ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.resolutionNote ? { resolutionNote: row.resolutionNote } : {}),
    ...(row.promotedFrom
      ? { promotedFrom: row.promotedFrom as NonNullable<CoachLearning['promotedFrom']> }
      : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertCoachLearning(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; learning: CoachLearning },
): Promise<void> {
  const { spaceId, learning } = params;
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx.insert(coachLearnings).values({
      id: learning.learningId,
      coachSessionId: learning.coachSessionId,
      runId: learning.runId ?? null,
      spaceId,
      scopeKind: learning.scope.kind,
      campaignId: learning.scope.kind === 'campaign' ? learning.scope.campaignId : null,
      skillSlug: learning.scope.kind !== 'space' ? learning.scope.skillSlug : null,
      kind: learning.kind,
      appliesTo: learning.appliesTo ?? null,
      statement: learning.statement,
      detailRef: learning.detailRef ?? null,
      evidence: learning.evidence,
      confidence: learning.confidence,
      supersedes: learning.supersedes,
      authorityLevel: learning.authorityLevel,
      status: learning.status,
      resolvedAt: learning.resolvedAt ? new Date(learning.resolvedAt) : null,
      resolvedBy: learning.resolvedBy ?? null,
      resolutionNote: learning.resolutionNote ?? null,
      promotedFrom: learning.promotedFrom ?? null,
      createdAt: new Date(learning.createdAt),
    });
  });
}

export async function findCoachLearningByPromotedFromEntry(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; candidateLedgerEntryId: string },
): Promise<CoachLearning | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(coachLearnings)
      .where(
        and(
          eq(coachLearnings.spaceId, params.spaceId),
          sql`${coachLearnings.promotedFrom}->>'candidateLedgerEntryId' = ${params.candidateLedgerEntryId}`,
        ),
      )
      .limit(1);
    return rows[0] ? rowToCoachLearning(rows[0]) : null;
  });
}

export async function getCoachLearningById(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  learningId: string,
): Promise<CoachLearning | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(coachLearnings)
      .where(and(eq(coachLearnings.spaceId, spaceId), eq(coachLearnings.id, learningId)))
      .limit(1);
    return rows[0] ? rowToCoachLearning(rows[0]) : null;
  });
}

/**
 * How campaign-scope learnings are admitted into a durable read:
 * - `skill-campaigns` — any campaign of the skill (Coach brief: everything
 *   the skill has learned so far).
 * - `campaign` — one specific campaign (Runner injection: the campaign the
 *   run belongs to).
 * - `campaign-only` — one campaign's rows WITHOUT the skill/space umbrella,
 *   so `limit` bounds that campaign's partition alone (campaign-end
 *   synthesis).
 * - `exclude` — none (non-campaign injection).
 */
export type CampaignScopeFilter =
  | { mode: 'skill-campaigns' }
  | { mode: 'campaign'; campaignId: string }
  | { mode: 'campaign-only'; campaignId: string }
  | { mode: 'exclude' };

export interface DurableCoachLearningsFilter {
  spaceId: string;
  skillSlug: string;
  campaignScope: CampaignScopeFilter;
  /** Task targeting is applied in SQL so `limit` and counts see only rows
   *  applicable to the task — learnings targeted at other tasks never occupy
   *  fetch-window or budget slots. Omitted = unfiltered. */
  taskId?: string;
  /** Admit `proposed` rows alongside the durable statuses — dedupe
   *  visibility for the synthesis-evidence read only. The Runner-facing
   *  active set must never set this: operator ratification is the
   *  injection gate. */
  includeProposed?: boolean;
}

function durableWhere(filter: DurableCoachLearningsFilter) {
  const scopeConditions =
    filter.campaignScope.mode === 'campaign-only'
      ? []
      : [
          eq(coachLearnings.scopeKind, 'space'),
          and(
            eq(coachLearnings.scopeKind, 'skill'),
            eq(coachLearnings.skillSlug, filter.skillSlug),
          ),
        ];
  if (filter.campaignScope.mode === 'skill-campaigns') {
    scopeConditions.push(
      and(eq(coachLearnings.scopeKind, 'campaign'), eq(coachLearnings.skillSlug, filter.skillSlug)),
    );
  } else if (
    filter.campaignScope.mode === 'campaign' ||
    filter.campaignScope.mode === 'campaign-only'
  ) {
    scopeConditions.push(
      and(
        eq(coachLearnings.scopeKind, 'campaign'),
        eq(coachLearnings.campaignId, filter.campaignScope.campaignId),
      ),
    );
  }
  const admittedStatuses: Array<CoachLearning['status']> = filter.includeProposed
    ? [...DURABLE_STATUSES, 'proposed']
    : [...DURABLE_STATUSES];
  const conditions = [
    eq(coachLearnings.spaceId, filter.spaceId),
    inArray(coachLearnings.status, admittedStatuses),
    or(...scopeConditions),
  ];
  if (filter.taskId !== undefined) {
    conditions.push(
      or(
        isNull(coachLearnings.appliesTo),
        sql`${coachLearnings.appliesTo}->>'kind' = 'skill'`,
        sql`${coachLearnings.appliesTo}->'taskIds' @> ${JSON.stringify([filter.taskId])}::jsonb`,
      ),
    );
  }
  return and(...conditions);
}

export async function listDurableCoachLearnings(
  db: PostgresJsDatabase,
  tenantId: string,
  filter: DurableCoachLearningsFilter & { limit: number },
): Promise<CoachLearning[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(coachLearnings)
      .where(durableWhere(filter))
      .orderBy(desc(coachLearnings.createdAt), desc(coachLearnings.id))
      .limit(filter.limit);
    return rows.map(rowToCoachLearning);
  });
}

export async function countDurableCoachLearnings(
  db: PostgresJsDatabase,
  tenantId: string,
  filter: DurableCoachLearningsFilter,
): Promise<number> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(coachLearnings)
      .where(durableWhere(filter));
    return rows[0]?.count ?? 0;
  });
}

/**
 * Operator surface: every learning attached to a skill (any status — the
 * ratify/reject panel needs `proposed` ones too). Space-scope learnings are
 * excluded; they are not resolvable through a skill.
 */
export async function listCoachLearningsForSkill(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; skillSlug: string; limit: number },
): Promise<CoachLearning[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select()
      .from(coachLearnings)
      .where(
        and(
          eq(coachLearnings.spaceId, params.spaceId),
          inArray(coachLearnings.scopeKind, ['campaign', 'skill']),
          eq(coachLearnings.skillSlug, params.skillSlug),
        ),
      )
      .orderBy(desc(coachLearnings.createdAt), desc(coachLearnings.id))
      .limit(params.limit);
    return rows.map(rowToCoachLearning);
  });
}

export interface ConsolidationActionResult {
  action: LearnerConsolidationAction['action'];
  learningIds: string[];
  ok: boolean;
  error?: string;
}

async function findMissingLearningIds(
  tx: PostgresJsDatabase,
  spaceId: string,
  ids: string[],
): Promise<string[]> {
  const rows = await tx
    .select({ id: coachLearnings.id })
    .from(coachLearnings)
    .where(and(eq(coachLearnings.spaceId, spaceId), inArray(coachLearnings.id, ids)));
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

async function applyConsolidationAction(
  tx: PostgresJsDatabase,
  params: { spaceId: string; resolvedBy: string },
  action: LearnerConsolidationAction,
): Promise<ConsolidationActionResult> {
  const { spaceId, resolvedBy } = params;
  const resolution = { resolvedAt: new Date(), resolvedBy };

  if (action.action === 'merge') {
    const learningIds = [action.survivorId, ...action.absorbedIds];
    if (action.absorbedIds.includes(action.survivorId)) {
      return {
        action: 'merge',
        learningIds,
        ok: false,
        error: 'survivorId must not appear in absorbedIds',
      };
    }
    const missing = await findMissingLearningIds(tx, spaceId, learningIds);
    if (missing.length > 0) {
      return {
        action: 'merge',
        learningIds,
        ok: false,
        error: `unknown learning id(s): ${missing.join(', ')}`,
      };
    }
    const survivorRows = await tx
      .select({ supersedes: coachLearnings.supersedes })
      .from(coachLearnings)
      .where(and(eq(coachLearnings.spaceId, spaceId), eq(coachLearnings.id, action.survivorId)))
      .limit(1);
    const existing = Array.isArray(survivorRows[0]?.supersedes)
      ? (survivorRows[0].supersedes as string[])
      : [];
    const supersedes = [...new Set([...existing, ...action.absorbedIds])];
    if (supersedes.length > COACH_LEARNING_SUPERSEDES_MAX) {
      return {
        action: 'merge',
        learningIds,
        ok: false,
        error: `merge would grow the survivor's supersedes to ${String(supersedes.length)} (max ${String(COACH_LEARNING_SUPERSEDES_MAX)}) — pick a fresher survivor or prune instead`,
      };
    }
    await tx
      .update(coachLearnings)
      .set({ supersedes })
      .where(and(eq(coachLearnings.spaceId, spaceId), eq(coachLearnings.id, action.survivorId)));
    await tx
      .update(coachLearnings)
      .set({ status: 'superseded', ...resolution })
      .where(
        and(eq(coachLearnings.spaceId, spaceId), inArray(coachLearnings.id, action.absorbedIds)),
      );
    return { action: 'merge', learningIds, ok: true };
  }

  const learningIds = [action.learningId];
  if (action.action === 'prune') {
    const deleted = await tx
      .delete(coachLearnings)
      .where(and(eq(coachLearnings.spaceId, spaceId), eq(coachLearnings.id, action.learningId)))
      .returning({ id: coachLearnings.id });
    return deleted.length > 0
      ? { action: 'prune', learningIds, ok: true }
      : {
          action: 'prune',
          learningIds,
          ok: false,
          error: `unknown learning id(s): ${action.learningId}`,
        };
  }

  const set =
    action.action === 'retire'
      ? { status: action.reason === 'internalized' ? 'internalized' : 'retired', ...resolution }
      : { status: 'disproven', resolutionNote: action.rationale, ...resolution };
  const updated = await tx
    .update(coachLearnings)
    .set(set)
    .where(and(eq(coachLearnings.spaceId, spaceId), eq(coachLearnings.id, action.learningId)))
    .returning({ id: coachLearnings.id });
  return updated.length > 0
    ? { action: action.action, learningIds, ok: true }
    : {
        action: action.action,
        learningIds,
        ok: false,
        error: `unknown learning id(s): ${action.learningId}`,
      };
}

/**
 * Applies a batch of consolidation actions in one transaction. Actions are
 * individually validated — an unknown id fails that action (reported with
 * `ok: false`, no partial mutation for it) while the rest still apply.
 */
export async function consolidateCoachLearnings(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string; resolvedBy: string; actions: LearnerConsolidationAction[] },
): Promise<ConsolidationActionResult[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const results: ConsolidationActionResult[] = [];
    for (const action of params.actions) {
      results.push(
        await applyConsolidationAction(
          tx,
          { spaceId: params.spaceId, resolvedBy: params.resolvedBy },
          action,
        ),
      );
    }
    return results;
  });
}

export async function updateCoachLearningResolution(
  db: PostgresJsDatabase,
  tenantId: string,
  params: {
    spaceId: string;
    learningId: string;
    status: 'ratified' | 'rejected';
    resolvedBy: string;
  },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(coachLearnings)
      .set({
        status: params.status,
        resolvedAt: new Date(),
        resolvedBy: params.resolvedBy,
      })
      .where(
        and(eq(coachLearnings.spaceId, params.spaceId), eq(coachLearnings.id, params.learningId)),
      )
      .returning({ id: coachLearnings.id });
    return updated.length > 0;
  });
}
