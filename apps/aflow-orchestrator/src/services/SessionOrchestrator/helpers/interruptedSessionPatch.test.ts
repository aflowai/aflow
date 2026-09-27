import { describe, expect, it } from 'vitest';

import { buildInterruptedSessionPatch } from './interruptedSessionPatch.js';

const STEP_EXEC_ID = 'step-exec-aaa';
const PARENT_AGENT_STEP_ID = 'agent';

function decodeRequestedInputRef(ref: string): unknown {
  expect(ref.startsWith('inline:')).toBe(true);
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf-8'));
}

describe('buildInterruptedSessionPatch', () => {
  describe('PAUSED delegate interrupt (WAITING_ON_CHILD case)', () => {
    it('sets currentStepId to the parent agent step (not the delegate)', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: true,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch.currentStepId).toBe(PARENT_AGENT_STEP_ID);
      expect(patch.currentStepExecutionId).toBe(STEP_EXEC_ID);
    });

    it('clears all delegation fields so the parent is not stuck waiting', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: true,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch['waitingForChildSessionIds']).toEqual([]);
      expect(patch['delegationPauseSource']).toBeUndefined();
      expect(patch['delegationWaitMode']).toBeUndefined();
      expect(patch['pausedChildSessionId']).toBeUndefined();
      expect(patch['childPausedStepExecutionId']).toBeUndefined();
    });

    it('marks the session interrupted and clears interruptRequested', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: true,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch.pauseReason).toBe('interrupted');
      expect(patch.pauseType).toBe('interrupted');
      expect(patch.interruptRequested).toBe(false);
      expect(patch.pauseMetadataJson).toBe(JSON.stringify({ pauseType: 'interrupted' }));
    });

    it('builds a resumeContract targeting the parent agent step', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: true,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch.requestedInputRef).toBeDefined();
      const decoded = decodeRequestedInputRef(patch.requestedInputRef!) as {
        stepId: string;
        resumeContract: { stepId: string; targetVariableId: string };
        missingVariables: { variableId: string }[];
      };
      const expectedVarId = `ai.agent.chatInput.${PARENT_AGENT_STEP_ID}`;
      expect(decoded.stepId).toBe(PARENT_AGENT_STEP_ID);
      expect(decoded.resumeContract.stepId).toBe(PARENT_AGENT_STEP_ID);
      expect(decoded.resumeContract.targetVariableId).toBe(expectedVarId);
      expect(decoded.missingVariables[0]!.variableId).toBe(expectedVarId);
    });
  });

  describe('PAUSED delegate interrupt with no resolvable parent agent', () => {
    it('clears delegation fields but does NOT set currentStepId or build resumeContract', () => {
      // Parent agent step couldn't be resolved (e.g. step state lookup failed).
      // We still clear delegation fields, but we leave currentStepId/contract
      // untouched so resume falls back to the existing currentStepId.
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: true,
        failedStepIsAgentChild: false,
        chatInputStepId: null,
      });

      expect(patch.currentStepId).toBeUndefined();
      expect(patch.requestedInputRef).toBeUndefined();
      expect(patch['waitingForChildSessionIds']).toEqual([]);
      expect(patch.pauseReason).toBe('interrupted');
    });
  });

  describe('STARTED tool-step child of ai.agent.turn interrupt (native-FC tool call)', () => {
    // Regression: when the user interrupts mid tool-call (e.g. memory.store.query
    // dispatched by Helmsman native function calling), the failed step is a
    // CHILD of the parent ai.agent.turn — not the agent.turn itself, not a
    // PAUSED delegate. Without the parent-agent resolution + currentStepId
    // override, resumeRun's legacy fallback can't map `{ input: <text> }` onto
    // any state variable so the user's resume message never reaches the next
    // agent.turn and silently disappears from conversation history.
    it('retargets currentStepId to the parent agent step', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: false,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch.currentStepId).toBe(PARENT_AGENT_STEP_ID);
      expect(patch.currentStepExecutionId).toBe(STEP_EXEC_ID);
    });

    it('builds a resumeContract targeting the parent agent step', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: false,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch.requestedInputRef).toBeDefined();
      const decoded = decodeRequestedInputRef(patch.requestedInputRef!) as {
        stepId: string;
        resumeContract: { stepId: string; targetVariableId: string };
      };
      const expectedVarId = `ai.agent.chatInput.${PARENT_AGENT_STEP_ID}`;
      expect(decoded.stepId).toBe(PARENT_AGENT_STEP_ID);
      expect(decoded.resumeContract.targetVariableId).toBe(expectedVarId);
    });

    it('does NOT clear delegation fields (the session was not in delegation-wait)', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: false,
        failedStepIsAgentChild: true,
        chatInputStepId: PARENT_AGENT_STEP_ID,
      });

      expect(patch['waitingForChildSessionIds']).toBeUndefined();
      expect(patch['delegationPauseSource']).toBeUndefined();
    });
  });

  describe('non-delegate interrupt (RUNNING ai.agent.turn case)', () => {
    it('does NOT clear delegation fields and does NOT override currentStepId', () => {
      // Interrupt of a STARTED ai.agent.turn step. currentStepId should be left
      // untouched (it already points to the right agent step), and delegation
      // fields are not touched (the session wasn't in delegation-wait).
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: false,
        failedStepIsAgentChild: false,
        chatInputStepId: 'agent',
      });

      expect(patch.currentStepId).toBeUndefined();
      expect(patch['waitingForChildSessionIds']).toBeUndefined();
      expect(patch['delegationPauseSource']).toBeUndefined();
    });

    it('still builds a resumeContract for the agent step', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: false,
        failedStepIsAgentChild: false,
        chatInputStepId: 'agent',
      });

      expect(patch.requestedInputRef).toBeDefined();
      const decoded = decodeRequestedInputRef(patch.requestedInputRef!) as { stepId: string };
      expect(decoded.stepId).toBe('agent');
    });
  });

  describe('non-delegate interrupt with no agent step (e.g. compute step in a non-agent flow)', () => {
    it('does not build a resumeContract', () => {
      const patch = buildInterruptedSessionPatch({
        stepExecId: STEP_EXEC_ID,
        isPausedDelegate: false,
        failedStepIsAgentChild: false,
        chatInputStepId: null,
      });

      expect(patch.requestedInputRef).toBeUndefined();
      expect(patch.currentStepId).toBeUndefined();
      expect(patch.pauseReason).toBe('interrupted');
    });
  });
});
