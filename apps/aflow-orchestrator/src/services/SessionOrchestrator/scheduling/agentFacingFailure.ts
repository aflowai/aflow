import type { StepDefinition } from '@aflow/schemas';

/**
 * Does a failed step's result belong in front of the agent?
 *
 * Yes exactly when the step's `onFailure` edge routes to an agent turn. That
 * edge is the declaration: it exists so the agent can see what went wrong and
 * choose differently.
 *
 * This used to be decided by `shouldPassResultToAgent`, which asks a different
 * question — was this step SPAWNED by an agent tool call (`dynamic` + a
 * `parent:` tag, or a child execution). A static graph tool is agent-INVOKED
 * but not agent-spawned, so it answered no, and two things followed from the
 * same branch:
 *
 *   - the agent never saw the error, so it re-decided on identical information
 *     and re-issued the identical call;
 *   - the per-tool failure counters never incremented, so `TOOL_FAILURE_LIMIT`
 *     could never trip.
 *
 * A graph tool could therefore fail forever. Observed at 8,344 iterations on
 * `run-coach`, whose input validation rejected every attempt.
 *
 * Deliberately narrow: this governs the FAILURE path only. The success path
 * keeps its own predicate, because a successful graph step raises no question
 * about whether the agent can make progress.
 */
export function failureIsAgentFacing(
  nextStepDef: StepDefinition | undefined,
): nextStepDef is StepDefinition {
  return nextStepDef?.operation === 'ai.agent.turn';
}
