import { createHash } from 'node:crypto';

/**
 * Identity of one pause instance, for compare-and-set on resolution.
 *
 * A session's step-execution id alone does not identify a pause: a run can
 * park twice on the same step asking different things, and an answer to the
 * first would silently apply to the second.
 *
 * Derived rather than counted. Sessions pause from many places in the
 * orchestrator, so a counter would depend on every one of them remembering to
 * bump it; this changes exactly when the question changes, because it is made
 * of the question. (Workflow runs keep their own `pause_version` column — they
 * have a single ledger function that owns pausing.)
 */
export function derivePauseToken(pause: {
  stepExecutionId: string;
  requestedInputRef?: string | null;
}): string {
  const requestedInputRef = pause.requestedInputRef ?? '';
  // Length-prefixed so the parts cannot be re-split: a plain separator lets
  // ("a", "b:c") and ("a:b", "c") hash to the same value.
  const encoded =
    `${String(pause.stepExecutionId.length)}:${pause.stepExecutionId}` +
    `${String(requestedInputRef.length)}:${requestedInputRef}`;

  return createHash('sha256').update(encoded).digest('hex').slice(0, 16);
}
