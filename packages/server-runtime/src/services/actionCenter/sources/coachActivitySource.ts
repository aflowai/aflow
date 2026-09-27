import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  coachActivity,
  type CoachActivityRow,
} from '@aflow/database';
import { type TenantId } from '@aflow/schemas';
import {
  type ActionCenterContext,
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceItem,
  type ActionCenterSourceDeps,
  ActionCenterResolveError,
} from '../types.js';

const ITEM_ID_PREFIX = 'coach-activity:';
const LIST_LIMIT = 50;

/**
 * Outcomes that should appear in the Action Center. `with_proposals`
 * is intentionally excluded — those flow through `coachProposalSource`
 * as ratifiable items.
 */
const VISIBLE_OUTCOMES: readonly string[] = [
  'silent',
  'observation_only',
  'learning_only',
  'preview_failed',
  'suppressed',
  'error',
];

export function createCoachActivitySource(deps: ActionCenterSourceDeps): ActionCenterSource {
  return {
    name: 'coachActivity',
    rowScope: 'space',
    handlesOriginTypes: ['coach_activity'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const rows = await loadActivityRows(deps, scope, LIST_LIMIT);
      return rows.map((row) => toActionCenterItem(row));
    },

    async getById(
      ctx: ActionCenterContext,
      itemId: string,
    ): Promise<ActionCenterSourceItem | null> {
      if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
      const activityId = itemId.slice(ITEM_ID_PREFIX.length);
      const tenantCtx = createTenantContext(ctx.tenantId);
      const rows = await withTenantSchema(deps.db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(coachActivity)
          .where(and(eq(coachActivity.id, activityId), eq(coachActivity.spaceId, ctx.spaceId)))
          .limit(1),
      );
      const row = rows[0];
      if (!row) return null;
      if (!VISIBLE_OUTCOMES.includes(row.outcome)) return null;
      return toActionCenterItem(row);
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by the source contract; we always reject.
    async resolve(
      _ctx: ActionCenterContext,
      _item: ActionCenterSourceItem,
      _resolution,
    ): Promise<ActionCenterResolveOutcome> {
      throw new ActionCenterResolveError(
        'INVALID_RESOLUTION',
        'Coach activity items are visibility-only and cannot be resolved through the Action Center.',
        'permanent',
      );
    },
  };
}

async function loadActivityRows(
  deps: ActionCenterSourceDeps,
  scope: ActionCenterScope,
  limit: number,
): Promise<CoachActivityRow[]> {
  const tenantCtx = createTenantContext(scope.tenantId);
  return withTenantSchema(deps.db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(coachActivity)
      .where(
        and(
          eq(coachActivity.spaceId, scope.spaceId),
          inArray(coachActivity.outcome, VISIBLE_OUTCOMES as string[]),
        ),
      )
      .orderBy(desc(coachActivity.createdAt))
      .limit(limit),
  );
}

function toActionCenterItem(row: CoachActivityRow): ActionCenterSourceItem {
  const createdAt = row.createdAt.toISOString();
  const skillLabel = row.skillSlug ? ` for "${row.skillSlug}"` : '';
  return {
    id: `${ITEM_ID_PREFIX}${row.id}`,
    spaceId: row.spaceId,
    kind: 'coach_activity',
    origin: {
      type: 'coach_activity',
      activityId: row.id,
      outcome: row.outcome,
      createdAt,
    },
    title: `Coach ${row.outcome.replace(/_/g, ' ')}${skillLabel}`,
    summary: summarizeRow(row),
    requestedAt: createdAt,
    requestedBy: {
      kind: 'coach',
      label: 'Coach',
      ...(row.coachSessionId ? { sessionId: row.coachSessionId } : {}),
    },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'view_only' },
    status: 'open',
  };
}

function summarizeRow(row: CoachActivityRow): string {
  const parts: string[] = [];
  parts.push(`trigger=${row.triggerKind}`);
  if (row.outcome === 'suppressed') parts.push(`status=${row.status}`);
  if (row.previewFailedCount > 0) parts.push(`previewFailed=${String(row.previewFailedCount)}`);
  if (row.learningCount > 0) parts.push(`learnings=${String(row.learningCount)}`);
  if (row.observationCount > 0) parts.push(`observations=${String(row.observationCount)}`);
  if (row.rationale) parts.push(`rationale=${row.rationale.slice(0, 200)}`);
  return parts.join(' · ');
}

/**
 * Pure list helper for the standalone activity timeline endpoint
 * (`GET /v1/spaces/:spaceId/coach-activity`). Distinct from the AC
 * list — the endpoint surfaces ALL outcomes including
 * `with_proposals` so the timeline UI can show a unified review log.
 */
export async function listCoachActivityForTimeline(
  deps: ActionCenterSourceDeps,
  ctx: { tenantId: TenantId; spaceId: string },
  options: {
    limit?: number;
    skillSlug?: string;
    outcome?: string;
  } = {},
): Promise<CoachActivityRow[]> {
  const tenantCtx = createTenantContext(ctx.tenantId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return withTenantSchema(deps.db, tenantCtx, async (tx) => {
    const filters = [eq(coachActivity.spaceId, ctx.spaceId)];
    if (options.skillSlug) filters.push(eq(coachActivity.skillSlug, options.skillSlug));
    if (options.outcome) filters.push(eq(coachActivity.outcome, options.outcome));
    return tx
      .select()
      .from(coachActivity)
      .where(filters.length > 1 ? and(...filters) : filters[0])
      .orderBy(desc(coachActivity.createdAt))
      .limit(limit);
  });
}
