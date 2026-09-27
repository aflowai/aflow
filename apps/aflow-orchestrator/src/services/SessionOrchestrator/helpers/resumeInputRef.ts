export interface ResumeInputRefDecisionInput {
  /** Operation id of the resumed step. */
  operation: string | undefined;
  /** Step status before resume — relevant only when `'PAUSED'`. */
  stepStatus: string;
  /** Original input ref the step was dispatched with (only set when paused). */
  stepInputRef: string | null | undefined;
  /** Resume-time input ref from the user's resume call (typically `{ prompt: ... }`). */
  paramsInputRef: string;
  /** Run-state's `requestedInputRef` (set when a step PAUSES with a handoff payload). */
  runRequestedInputRef: string | null | undefined;
}

const RUNNER_STYLE_OPERATIONS = new Set(['ai.agent.turn', 'agent.control.delegate']);

/**
 * Decide which input ref the resumed step should be scheduled with.
 *
 * - Runner-style operations always receive the resume's `paramsInputRef`
 *   (the new user message).
 * - Paused operation steps with a `requestedInputRef` on run state receive
 *   their original `stepInputRef`.
 * - All other cases fall back to `paramsInputRef` (preserves prior behavior).
 */
export function chooseResumeInputRef(input: ResumeInputRefDecisionInput): string {
  const isRunnerStyle = !!input.operation && RUNNER_STYLE_OPERATIONS.has(input.operation);
  const wasOperationPause =
    input.stepStatus === 'PAUSED' && !!input.runRequestedInputRef && !isRunnerStyle;
  if (wasOperationPause && input.stepInputRef) {
    return input.stepInputRef;
  }
  return input.paramsInputRef;
}
