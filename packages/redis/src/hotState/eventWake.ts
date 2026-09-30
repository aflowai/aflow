import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import type { SessionHotState } from './schemas.js';

/** The only pause a wake may advance: the agent waiting for what to do next. */
const AGENT_TURN_OPERATION_ID = 'ai.agent.turn';

/**
 * Whether a wake may advance this run.
 *
 * A wake carries no answer — the message is in the room, and the agent reads
 * the room. That is only true when the thing the run is waiting for IS the
 * agent's next turn. Every other pause is waiting for a specific answer from a
 * specific person: an approval, a sub-agent's question, a credential. Resuming
 * one of those with an empty payload does not decline to answer it, it answers
 * it emptily — a decision-less resume of an approval step reads as approved,
 * so "hmm, not sure about this" would ship the thing it doubted. Those pauses
 * keep their own rails; a wake leaves them exactly as it found them.
 */
export function mayWake(
  runState: Pick<SessionHotState, 'status' | 'delegationPauseSource' | 'currentStepExecutionId'>,
  pausedStep: { operationId: string } | null,
): boolean {
  if (runState.status !== 'PAUSED') return false;
  // Waiting on a child's question: the resume is forwarded to the child, whose
  // room is not this one, so the answer would never reach whoever asked.
  if (runState.delegationPauseSource) return false;
  if (!runState.currentStepExecutionId) return false;
  return pausedStep?.operationId === AGENT_TURN_OPERATION_ID;
}

const EVENT_DRIVEN_TURN_WINDOW_SECONDS = 60;

export type EventDrivenTurnClaim = { taken: true } | { taken: false; nextSlotAtMs: number };

function eventDrivenTurnsKey(tenantId: string, sessionId: string): string {
  return `${StreamKeys.sessionStateKey(tenantId, sessionId)}:eventTurns`;
}

/**
 * Take one of a session's event-driven turns for the current minute.
 *
 * A fixed window that opens with the first wake and expires on its own, so an
 * idle session holds nothing and nothing has to sweep it. A refusal says when
 * the window closes, which is the earliest a deferred wake can be granted.
 */
export async function claimEventDrivenTurn(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  turnsPerMinute: number,
  nowMs: number = Date.now(),
): Promise<EventDrivenTurnClaim> {
  const key = eventDrivenTurnsKey(tenantId, sessionId);
  const results = await redis
    .multi()
    .set(key, '0', 'EX', EVENT_DRIVEN_TURN_WINDOW_SECONDS, 'NX')
    .incr(key)
    .pttl(key)
    .exec();
  const taken = results?.[1]?.[1];
  if (typeof taken === 'number' && taken <= turnsPerMinute) return { taken: true };
  const remainingMs = results?.[2]?.[1];
  return {
    taken: false,
    nextSlotAtMs:
      nowMs +
      (typeof remainingMs === 'number' && remainingMs > 0
        ? remainingMs
        : EVENT_DRIVEN_TURN_WINDOW_SECONDS * 1000),
  };
}

// Only while the window is open: a DECR on an expired key would create one
// with no expiry, holding a count for a session nothing will ever sweep.
const RETURN_EVENT_DRIVEN_TURN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/** Give back a turn taken for a wake that another wake had already started. */
export async function returnEventDrivenTurn(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.eval(RETURN_EVENT_DRIVEN_TURN_LUA, 1, eventDrivenTurnsKey(tenantId, sessionId));
}
