/**
 * Build the SessionHotState patch fields for an interrupted-session transition.
 *
 * Used by `forceCompleteInFlightStep` when the user interrupts a session.
 * Pulled into a pure helper so the post-interrupt hot-state shape can be
 * unit-tested directly — in particular the cases where `currentStepId` must
 * be redirected to the parent `ai.agent.turn` step (not the now-FAILED child)
 * so resumeRun schedules the agent on resume: PAUSED `agent.control.delegate`
 * waits AND STARTED native-FC tool steps invoked by the agent.
 */
import { getClearedDelegationStatePatch } from './delegationState.js';

export interface InterruptedSessionPatchInput {
  /** Step exec id of the in-flight (or PAUSED delegate) step being interrupted. */
  stepExecId: string;
  /** True when interrupting a PAUSED `agent.control.delegate` step (delegation-wait). */
  isPausedDelegate: boolean;
  /**
   * True when the failed step is a CHILD of an `ai.agent.turn` (a PAUSED
   * delegate or a STARTED native-FC tool step). In that case resumeRun must
   * re-target the parent agent step on resume — otherwise it would re-schedule
   * the now-FAILED child. Leave false when the failed step IS the agent.turn:
   * resume's fallback to `stepState.stepId` already lands on the right step.
   */
  failedStepIsAgentChild: boolean;
  /**
   * stepId for the chat-input variable in the resumeContract.
   *   - For an interrupted `ai.agent.turn`, this is the agent step's own stepId.
   *   - For an interrupted PAUSED delegate, this is the parent agent step's stepId.
   *   - For an interrupted STARTED native-FC tool child, this is the parent
   *     agent step's stepId.
   *   - null when no agent step could be resolved (e.g. a standalone compute
   *     step in a non-agent flow); no resumeContract is built and no
   *     currentStepId override.
   */
  chatInputStepId: string | null;
}

export interface InterruptedSessionPatch {
  pauseReason: 'interrupted';
  interruptRequested: false;
  pauseType: 'interrupted';
  pauseMetadataJson: string;
  currentStepExecutionId: string;
  /**
   * Set whenever the failed step is a CHILD of an `ai.agent.turn` (a PAUSED
   * delegate or a STARTED native-FC tool step). resumeRun() reads
   * `currentStepId` for interrupted runs (index.ts:
   * `runState.pauseType === 'interrupted' && runState.currentStepId`), so
   * without this override resume would re-schedule the now-FAILED child step.
   * When the failed step IS the agent.turn, this is left undefined — resume's
   * fallback to `stepState.stepId` already points at the right step.
   */
  currentStepId?: string;
  requestedInputRef?: string;
  // Cleared delegation fields are spread into the patch when isPausedDelegate.
  // Typed loosely here because callers spread this into a wider partial.
  [k: string]: unknown;
}

export function buildInterruptedSessionPatch(
  input: InterruptedSessionPatchInput,
): InterruptedSessionPatch {
  const { stepExecId, isPausedDelegate, failedStepIsAgentChild, chatInputStepId } = input;

  // Order matters: getClearedDelegationStatePatch() sets pauseReason/pauseType
  // to `undefined` (it's also used for non-interrupt "leave delegation" paths
  // where those fields must clear). Apply it FIRST, then overwrite with the
  // interrupt markers so they survive.
  const patch: InterruptedSessionPatch = {} as InterruptedSessionPatch;

  if (isPausedDelegate) {
    Object.assign(patch, getClearedDelegationStatePatch());
  }

  if (failedStepIsAgentChild && chatInputStepId) {
    patch.currentStepId = chatInputStepId;
  }

  patch.pauseReason = 'interrupted';
  patch.interruptRequested = false;
  patch.pauseType = 'interrupted';
  patch.pauseMetadataJson = JSON.stringify({ pauseType: 'interrupted' });
  patch.currentStepExecutionId = stepExecId;

  if (chatInputStepId) {
    const chatVarId = `ai.agent.chatInput.${chatInputStepId}`;
    const payload = {
      reason: 'input_required' as const,
      stepId: chatInputStepId,
      missingVariables: [{ variableId: chatVarId, name: 'Message', required: true }],
      resumeContract: {
        reason: 'input_required' as const,
        mode: 'primary' as const,
        stepId: chatInputStepId,
        targetVariableId: chatVarId,
        requiredFields: [{ variableId: chatVarId, name: 'Message', required: true }],
        prompt: 'Flow was interrupted. Send a message to continue.',
      },
      prompt: 'Flow was interrupted. Send a message to continue.',
    };
    patch.requestedInputRef = `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  }

  return patch;
}
