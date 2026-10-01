import type { WorkflowRunWakeupEntry } from '@aflow/schemas';
import type { ConversationStateStore } from './conversationStateStore.js';

/**
 * Append what runs the session started without waiting have reported — as
 * data, keyed by the event that carried each, so the recent window can be
 * handed over every turn and each outcome still lands exactly once.
 */
export function appendRunWakeups(
  store: Pick<ConversationStateStore, 'appendUserInput'>,
  entries: readonly WorkflowRunWakeupEntry[],
): void {
  for (const entry of entries) {
    store.appendUserInput({
      userInputId: `run-wakeup:${entry.eventId}`,
      text: JSON.stringify({ workflowRunWakeup: entry.envelope }),
      createdAtMs: Date.now(),
    });
  }
}
