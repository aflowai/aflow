import { and, desc, eq, gte, isNotNull, ne } from 'drizzle-orm';
import { agentSchedules, createTenantContext, withTenantSchema } from '@aflow/database';

import {
  ActionCenterResolveError,
  type ActionCenterContext,
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceDeps,
  type ActionCenterSourceItem,
} from '../types.js';

const ITEM_ID_PREFIX = 'trigger-armed:';
const LIST_LIMIT = 20;

/**
 * How long an arming stays news.
 *
 * A schedule is durable, unlike the coach activity this borrows its shape from,
 * so "most recent N" would leave a job armed months ago sitting here forever.
 * The standing answer to "what runs here" is the Triggers page; this is only the
 * moment it appeared.
 */
const NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A trigger an agent armed, surfaced once so the operator learns it exists.
 *
 * Nothing announced this before. A schedule set up in conversation is a durable
 * thing that will act on its own, and the operator may never have watched it
 * being made — the authority is ordinary, so there is nothing to approve, but
 * "ordinary" is not the same as "worth not mentioning".
 *
 * View-only for the same reason: the decision was already the operator's when
 * they connected the folders and set the space's capabilities. Stopping one is a
 * button on the Triggers page, not an approval gate here.
 *
 * Only agent-armed ones. A schedule the operator created themselves needs no
 * telling; announcing it would train them to dismiss the notice that matters.
 */
export function createTriggerArmedSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  return {
    name: 'triggerArmed',
    rowScope: 'space',
    handlesOriginTypes: ['trigger_armed'],

    async listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]> {
      const rows = await withTenantSchema(
        deps.db,
        createTenantContext(scope.tenantId),
        async (tx) =>
          tx
            .select()
            .from(agentSchedules)
            .where(
              and(
                eq(agentSchedules.spaceId, scope.spaceId),
                // A session id is the record that an agent armed it in
                // conversation; an operator acting through the API leaves none.
                isNotNull(agentSchedules.createdBySessionId),
                ne(agentSchedules.status, 'deleted'),
                gte(agentSchedules.createdAt, new Date(Date.now() - NEWS_WINDOW_MS)),
              ),
            )
            .orderBy(desc(agentSchedules.createdAt))
            .limit(LIST_LIMIT),
      );
      return rows.map((row) => toItem(row));
    },

    async getById(
      ctx: ActionCenterContext,
      itemId: string,
    ): Promise<ActionCenterSourceItem | null> {
      if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
      const scheduleId = itemId.slice(ITEM_ID_PREFIX.length);
      const rows = await withTenantSchema(deps.db, createTenantContext(ctx.tenantId), async (tx) =>
        tx
          .select()
          .from(agentSchedules)
          .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.spaceId, ctx.spaceId)))
          .limit(1),
      );
      const row = rows[0];
      if (row?.createdBySessionId == null) return null;
      return toItem(row);
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- the source contract is async; this always rejects.
    async resolve(
      _ctx: ActionCenterContext,
      _item: ActionCenterSourceItem,
      _resolution,
    ): Promise<ActionCenterResolveOutcome> {
      throw new ActionCenterResolveError(
        'INVALID_RESOLUTION',
        'An armed trigger is shown so it is known about, not so it can be approved. Pause or ' +
          'delete it on the Triggers page.',
        'permanent',
      );
    },
  };
}

function toItem(row: typeof agentSchedules.$inferSelect): ActionCenterSourceItem {
  const createdAt = row.createdAt.toISOString();
  const when =
    row.kind === 'cron' && row.cronExpression !== null
      ? `${row.cronExpression} (${row.timezone})`
      : 'once';
  return {
    id: `${ITEM_ID_PREFIX}${row.id}`,
    spaceId: row.spaceId,
    kind: 'trigger_armed',
    origin: { type: 'trigger_armed', scheduleId: row.id, createdAt },
    title: `Scheduled: ${row.name}`,
    summary: `Set up in chat, and will run on its own — ${when}.`,
    requestedAt: createdAt,
    requestedBy: {
      kind: 'agent',
      label: 'Assistant',
      ...(row.createdBySessionId ? { sessionId: row.createdBySessionId } : {}),
    },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'view_only' },
    status: 'open',
  };
}
