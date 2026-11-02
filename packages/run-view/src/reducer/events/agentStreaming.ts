import type { LiveDeltaChannel } from '@aflow/schemas';
import type { Message } from '../../types.js';
import type { LiveDeltaAction, RunViewState } from '../state.js';
import { applyActivityDelta } from './harnessActivity.js';

/**
 * One message per (step, channel) — which is exactly what the live buffer on
 * the server holds, so the two never have to be reconciled. The ids and
 * semantic types are read by the promotion branches on `StepSucceeded`,
 * `SessionPaused` and `SessionCompleted`: the durable event replaces this
 * message in place, which is what keeps the React key stable and stops the
 * final answer from appearing twice.
 *
 * Only the channels that carry what a step is *saying* are here. A channel
 * that carries what it is *doing* — `activity` — belongs under the step, not
 * in the conversation, so it has no message and folds into its own state.
 * `status` has no message either: it is the label of the step's spinner,
 * which the client reads from the frame with `latestStatusLine`.
 */
const CHANNEL_MESSAGE: Partial<
  Record<LiveDeltaChannel, { idPrefix: string; semanticType: string }>
> = {
  thinking: { idPrefix: 'thinking-', semanticType: 'streaming_thinking' },
  text: { idPrefix: 'streaming-', semanticType: 'streaming_text' },
};

export function applyLiveDelta(state: RunViewState, action: LiveDeltaAction): RunViewState {
  const { stepExecutionId, channel, delta, offset } = action;
  if (!delta || !stepExecutionId) return state;

  if (channel === 'activity') return applyActivityDelta(state, action);

  const mapping = CHANNEL_MESSAGE[channel];
  if (mapping === undefined) return state;
  // Live frames travel apart from the durable stream and can land after the
  // step's terminal event — folding one would turn the step's settled message
  // back into a streaming one, or mount a thinking box under a finished turn.
  if (state.endedSteps[stepExecutionId] === true) return state;
  const { idPrefix, semanticType } = mapping;
  const messageId = `${idPrefix}${stepExecutionId}`;
  const existingIdx = state.messages.findIndex((m) => m.id === messageId);
  const existing = existingIdx >= 0 ? state.messages[existingIdx] : undefined;
  const senderName = action.senderName ?? existing?.senderName;
  const priorContent = offset === 0 ? '' : (existing?.content ?? '');

  const message: Message = {
    id: messageId,
    role: 'assistant',
    content: priorContent + delta,
    timestamp: action.timestamp,
    ...(senderName ? { senderName } : {}),
    semanticType,
    stepExecutionId,
  };

  const messages = [...state.messages];
  if (existingIdx >= 0) {
    messages[existingIdx] = message;
  } else {
    messages.push(message);
  }

  return channel === 'text'
    ? { ...state, messages, streamingStepExecutionId: stepExecutionId }
    : { ...state, messages };
}

/**
 * The status a `status` frame leaves the step in: its last whole line. A frame
 * carrying no whole line — a chunk cut mid-line — says nothing new, and the
 * status before it stands.
 */
export function latestStatusLine(delta: string): string | undefined {
  const lines = delta.split('\n').slice(0, -1);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return undefined;
}
