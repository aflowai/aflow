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

/**
 * Take one of a session's event-driven turns for the current minute.
 *
 * A fixed window that opens with the first wake and expires on its own, so an
 * idle session holds nothing and nothing has to sweep it.
 */
export async function claimEventDrivenTurn(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  turnsPerMinute: number,
): Promise<boolean> {
  const key = `${StreamKeys.sessionStateKey(tenantId, sessionId)}:eventTurns`;
  const results = await redis
    .multi()
    .set(key, '0', 'EX', EVENT_DRIVEN_TURN_WINDOW_SECONDS, 'NX')
    .incr(key)
    .exec();
  const taken = results?.[1]?.[1];
  return typeof taken === 'number' && taken <= turnsPerMinute;
}
