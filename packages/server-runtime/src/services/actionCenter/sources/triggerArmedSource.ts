import { and, desc, eq, gte } from 'drizzle-orm';
import { agentSchedules, createTenantContext, withTenantSchema } from '@aflow/database';
import {
  announcesScheduleArming,
  CHAT_SCHEDULE_NEWS_WINDOW_MS,
  selectChatScheduleNews,
  type ChatScheduleFacts,
} from '@aflow/schemas';

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

type ScheduleRow = typeof agentSchedules.$inferSelect;

/**
 * A session id is the record that an agent armed it in conversation; an
 * operator acting through the API leaves none.
 */
function chatScheduleFacts(row: ScheduleRow): ChatScheduleFacts {
  return {
    armedInChat: row.createdBySessionId !== null,
    renewsScheduleId: row.renewsScheduleId,
    status: row.status,
    createdAt: row.createdAt,
  };
}

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
      const now = Date.now();
      // The query bounds the read to the news window and nothing else. Which
      // rows are news is selectChatScheduleNews, the rule the Workbench's
      // Schedules section applies too. A filter repeated here could drift from it.
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
                gte(agentSchedules.createdAt, new Date(now - CHAT_SCHEDULE_NEWS_WINDOW_MS)),
              ),
            )
            .orderBy(desc(agentSchedules.createdAt)),
      );
      return selectChatScheduleNews(rows, chatScheduleFacts, now).map((row) => toItem(row));
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
      if (row === undefined || !announcesScheduleArming(chatScheduleFacts(row))) return null;
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

function toItem(row: ScheduleRow): ActionCenterSourceItem {
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
