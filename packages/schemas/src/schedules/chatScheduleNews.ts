/**
 * How long a schedule an agent set up in chat stays news, for the Action
 * Center notice and the Workbench's Schedules section alike.
 *
 * A schedule is durable, so "most recent N" alone would leave one set up months
 * ago standing there forever. The standing answer to "what runs here" is the
 * Triggers page, and these surfaces show only the moment one appeared.
 */
export const CHAT_SCHEDULE_NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How many schedules set up in chat those surfaces list, newest first. */
export const CHAT_SCHEDULE_LIST_LIMIT = 20;

/**
 * What the rule reads from a schedule. The database row records the arming
 * session as `createdBySessionId` and the API row as `createdByRunId`, so each
 * caller says which it holds.
 */
export interface ChatScheduleFacts {
  /** Whether a session id records that an agent set it up in conversation. */
  armedInChat: boolean;
  renewsScheduleId: string | null;
  status: string;
  createdAt: Date | string;
}

/**
 * Whether a schedule announces an arming: an agent set it up in conversation,
 * and it is not a renewal. A renewal is the trigger already announced,
 * continuing, and announcing it again at every renewal is the noise the
 * operator-created exclusion avoids.
 */
export function announcesScheduleArming(
  facts: Pick<ChatScheduleFacts, 'armedInChat' | 'renewsScheduleId'>,
): boolean {
  return facts.armedInChat && facts.renewsScheduleId === null;
}

/** Whether a schedule is still news of an arming at `now`. */
export function isChatScheduleNews(facts: ChatScheduleFacts, now: number = Date.now()): boolean {
  return (
    announcesScheduleArming(facts) &&
    facts.status !== 'deleted' &&
    new Date(facts.createdAt).getTime() >= now - CHAT_SCHEDULE_NEWS_WINDOW_MS
  );
}

/**
 * The schedules set up in chat that are news, newest first and at most
 * {@link CHAT_SCHEDULE_LIST_LIMIT}. The Action Center's trigger_armed notices
 * and the Workbench's Schedules section both select through this one function,
 * so they cannot pick different arrivals.
 */
export function selectChatScheduleNews<T>(
  rows: readonly T[],
  facts: (row: T) => ChatScheduleFacts,
  now: number = Date.now(),
): T[] {
  return rows
    .map((row) => ({ row, facts: facts(row) }))
    .filter((entry) => isChatScheduleNews(entry.facts, now))
    .map((entry) => ({ row: entry.row, at: new Date(entry.facts.createdAt).getTime() }))
    .sort((a, b) => b.at - a.at)
    .slice(0, CHAT_SCHEDULE_LIST_LIMIT)
    .map((entry) => entry.row);
}
