import type { Session } from './types.js';

/**
 * How long after its last activity the chat still lands on a conversation
 * (Plan 338 D4). Past it, `/chat` opens a new one.
 */
export const CHAT_RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/** A conversation in one of these states has ended, and the landing never resumes it. */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALLED',
]);

/**
 * Every query parameter the chat page reads. Each one carries an intent the
 * arrival names: a conversation, an agent, a rehearsal pin, a composer draft
 * or an open Workbench.
 */
export const CHAT_INTENT_PARAMS = [
  'session',
  'agentId',
  'sim',
  'persona',
  'baseline',
  'draft',
  'workbench',
] as const;

/**
 * True when the arrival URL carries no intent the chat reads (Plan 338 D4).
 * Only such an arrival lands on the reader's last conversation. Any other
 * opens what it names, so the landing never overrides it.
 */
export function isBareChatArrival(params: { has(name: string): boolean }): boolean {
  return CHAT_INTENT_PARAMS.every((name) => !params.has(name));
}

/**
 * The conversation `/chat` lands on when the URL names none (Plan 338 D4):
 * the reader's newest conversation that has not ended and was active within
 * {@link CHAT_RESUME_WINDOW_MS}. `null` lands on a new chat.
 *
 * It reads the session list the chat already holds for the selected agent,
 * so the landing costs no request of its own. That list holds that agent's
 * newest `SESSION_LIST_LIMIT` conversations in the space, so a reader whose conversation
 * others' newer ones have pushed out of it lands on a new chat.
 */
export function pickLandingConversation(
  sessions: readonly Session[],
  readerId: string | null,
  now: number,
): Session | null {
  if (!readerId) return null;
  let best: { session: Session; at: number } | null = null;
  for (const session of sessions) {
    if (session.createdBy !== readerId) continue;
    if (ENDED_STATUSES.has(session.status)) continue;
    const at = Date.parse(session.lastActivityAt ?? session.updatedAt ?? session.createdAt);
    if (!Number.isFinite(at) || now - at > CHAT_RESUME_WINDOW_MS) continue;
    if (!best || at > best.at) best = { session, at };
  }
  return best?.session ?? null;
}
