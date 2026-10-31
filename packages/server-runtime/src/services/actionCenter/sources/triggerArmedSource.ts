import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { agentSchedules, createTenantContext, withTenantSchema } from '@aflow/database';
import {
  announcesScheduleArming,
  CHAT_SCHEDULE_LIST_LIMIT,
  CHAT_SCHEDULE_NEWS_WINDOW_MS,
  selectChatScheduleNews,
  type ChatScheduleFacts,
  type TenantId,
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
 * A schedule an agent set up in chat, and the schedule that now carries its
 * trigger: the newest renewal in its chain, or the arrival itself where nothing
 * has renewed it.
 */
export interface ChatScheduleChain {
  arrival: ScheduleRow;
  current: ScheduleRow;
}

/**
 * The chat schedules that are news, newest first, each with its newest renewal.
 *
 * The Action Center's trigger_armed notices and the Workbench's Schedules
 * section both read through this, so a card cannot vanish while its notice
 * stays. A renewing schedule writes a renewal every few dozen firings, so a
 * read that visits every renewal grows with each one. The query keeps to
 * arrivals and stops at the lane's limit. It then reads each arrival's newest
 * renewal through `original_schedule_id` and its index, one probe per arrival,
 * however long the chain. The probe passes over deleted renewals, as the
 * schedules list does, so a live renewal after a deleted one is still found.
 * selectChatScheduleNews still decides which arrivals are news.
 */
export async function readChatScheduleChains(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  now: number = Date.now(),
): Promise<ChatScheduleChain[]> {
  const since = new Date(now - CHAT_SCHEDULE_NEWS_WINDOW_MS).toISOString();
  return withTenantSchema(db, createTenantContext(tenantId), async (tx) => {
    const picked = (await tx.execute(sql`
      WITH arrivals AS (
        SELECT id, created_at
        FROM agent_schedules
        WHERE space_id = ${spaceId}::uuid
          AND created_by_session_id IS NOT NULL
          AND renews_schedule_id IS NULL
          AND status <> 'deleted'
          AND created_at >= ${since}::timestamptz
        ORDER BY created_at DESC
        LIMIT ${CHAT_SCHEDULE_LIST_LIMIT}
      )
      SELECT arrivals.id AS arrival_id, COALESCE(newest.id, arrivals.id) AS current_id
      FROM arrivals
      LEFT JOIN LATERAL (
        SELECT renewal.id
        FROM agent_schedules renewal
        WHERE renewal.original_schedule_id = arrivals.id
          AND renewal.space_id = ${spaceId}::uuid
          AND renewal.status <> 'deleted'
        ORDER BY renewal.created_at DESC
        LIMIT 1
      ) newest ON true
      ORDER BY arrivals.created_at DESC
    `)) as unknown as ReadonlyArray<{ arrival_id: string; current_id: string }>;
    if (picked.length === 0) return [];

    const ids = [...new Set(picked.flatMap((pair) => [pair.arrival_id, pair.current_id]))];
    const rows = await tx
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.spaceId, spaceId), inArray(agentSchedules.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));

    const chains: ChatScheduleChain[] = [];
    for (const pair of picked) {
      const arrival = byId.get(pair.arrival_id);
      const current = byId.get(pair.current_id);
      if (arrival !== undefined && current !== undefined) chains.push({ arrival, current });
    }
    return selectChatScheduleNews(chains, (chain) => chatScheduleFacts(chain.arrival), now);
  });
}

/** Active, not past its end, and with a next firing still ahead of `now`. */
function firesAgain(row: ScheduleRow, now: number): boolean {
  return (
    row.status === 'active' &&
    row.nextFireAt !== null &&
    row.nextFireAt.getTime() > now &&
    (row.expiresAt === null || row.expiresAt.getTime() > now)
  );
}

/**
 * The Workbench's Schedules section: of the chains the notices announce, the
 * ones whose newest renewal will fire again, as that renewal. A one-shot that
 * has run, a chain at its end and a superseded renewal are left out. The
 * notices keep the whole news window, and only this section narrows.
 */
export async function readActiveChatSchedules(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  now: number = Date.now(),
): Promise<ScheduleRow[]> {
  const chains = await readChatScheduleChains(db, tenantId, spaceId, now);
  return chains.map((chain) => chain.current).filter((row) => firesAgain(row, now));
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
      const chains = await readChatScheduleChains(deps.db, scope.tenantId, scope.spaceId);
      return chains.map((chain) => toItem(chain.arrival));
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
