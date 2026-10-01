import { WaiterNotifiedOutcomeSchema } from '@aflow/schemas';
import type { Message, RunWakeupPayload, SessionEvent } from '../../types.js';
import type { RunViewState } from '../state.js';
import { toISOTimestamp } from '../helpers.js';

/**
 * A run this session started without waiting reported in. It becomes a card
 * where it landed in the conversation: it is why the agent speaks next with
 * nobody having said anything, so it sits before that turn's message.
 */
export function applyRunWakeupEvent(state: RunViewState, event: SessionEvent): RunViewState {
  if (event.eventType !== 'WorkflowRunWakeup') return state;
  const runId = event.metadata?.runId;
  const outcome = WaiterNotifiedOutcomeSchema.safeParse(event.metadata?.outcome);
  if (typeof runId !== 'string' || !outcome.success) return state;

  const id = `run-wakeup-${event.eventId}`;
  if (state.messages.some((m) => m.id === id)) return state;
  const payload: RunWakeupPayload = {
    runId,
    outcome: outcome.data,
    ...(event.data.payloadRef ? { envelopeRef: event.data.payloadRef } : {}),
  };
  const message: Message = {
    id,
    role: 'system',
    content: '',
    semanticType: 'run_wakeup',
    richContent: payload,
    timestamp: toISOTimestamp(event.timestamp),
  };
  return { ...state, messages: [...state.messages, message] };
}
