import { describe, it, expect } from 'vitest';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import type { RecoveryEventEnvelope, SystemRole } from '@aflow/schemas';
import { applyRecoveryEvent } from '../RecoveryService.js';

function makeRunState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: '00000000-0000-0000-0000-000000000001',
    tenantId: 'test-tenant',
    target: { kind: 'platform-role', systemRole: 'test-flow' as SystemRole },
    agentVersion: '1',
    status: 'QUEUED',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    ...overrides,
  };
}

function makeStepState(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: '00000000-0000-0000-0000-000000000010',
    tenantId: 'test-tenant',
    sessionId: '00000000-0000-0000-0000-000000000001',
    stepId: 'step-1',
    stepType: 'ai',
    operationId: 'ai.text.generate',
    attempt: 1,
    status: 'SCHEDULED',
    scheduledAt: 1000,
    inputRef: 'inline:test',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

function makeEvent(
  seq: number,
  type: RecoveryEventEnvelope['type'],
  data: Record<string, unknown>,
  stepExecutionId?: string,
): RecoveryEventEnvelope {
  return {
    version: 1,
    type,
    tenantId: 'test-tenant',
    runId: '00000000-0000-0000-0000-000000000001',
    seq,
    timestamp: 1000 + seq,
    ...(stepExecutionId !== undefined ? { stepExecutionId } : {}),
    data,
  };
}

describe('RecoveryService', () => {
  describe('applyRecoveryEvent', () => {
    it('applies run.created event with full state', () => {
      const runState = makeRunState();
      const stepState = makeStepState();
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(1, 'run.created', {
        runHotState: { ...runState, status: 'RUNNING' },
        stepHotState: stepState,
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('RUNNING');
      expect(result.stepStates.size).toBe(1);
      expect(result.stepStates.get(stepState.stepExecutionId)?.status).toBe('SCHEDULED');
    });

    it('applies run.status_changed event', () => {
      const runState = makeRunState({ status: 'RUNNING' });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(2, 'run.status_changed', {
        fromStatus: 'RUNNING',
        toStatus: 'PAUSED',
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('PAUSED');
    });

    it('applies run.completed event', () => {
      const runState = makeRunState({ status: 'RUNNING' });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(3, 'run.completed', {
        fromStatus: 'RUNNING',
        toStatus: 'SUCCEEDED',
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('SUCCEEDED');
    });

    it('applies step.scheduled event', () => {
      const runState = makeRunState({ status: 'RUNNING' });
      const stepStates = new Map<string, StepHotState>();
      const newStep = makeStepState({
        stepExecutionId: '00000000-0000-0000-0000-000000000020',
        stepId: 'step-2',
      });

      const event = makeEvent(
        4,
        'step.scheduled',
        { stepHotState: newStep },
        newStep.stepExecutionId,
      );

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.stepStates.size).toBe(1);
      expect(result.runState.currentStepId).toBe('step-2');
      expect(result.runState.currentStepExecutionId).toBe(newStep.stepExecutionId);
    });

    it('applies step.claimed event', () => {
      const stepState = makeStepState();
      const stepStates = new Map<string, StepHotState>([[stepState.stepExecutionId, stepState]]);
      const runState = makeRunState({ status: 'RUNNING' });

      const event = makeEvent(5, 'step.claimed', {}, stepState.stepExecutionId);

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.stepStates.get(stepState.stepExecutionId)?.status).toBe('STARTED');
    });

    it('applies step.succeeded event', () => {
      const stepState = makeStepState({ status: 'STARTED' });
      const stepStates = new Map<string, StepHotState>([[stepState.stepExecutionId, stepState]]);
      const runState = makeRunState({ status: 'RUNNING' });

      const event = makeEvent(
        6,
        'step.succeeded',
        { outputRef: 'gcs://bucket/output' },
        stepState.stepExecutionId,
      );

      const result = applyRecoveryEvent(runState, stepStates, event);
      const updated = result.stepStates.get(stepState.stepExecutionId);
      expect(updated?.status).toBe('SUCCEEDED');
      expect(updated?.outputRef).toBe('gcs://bucket/output');
    });

    it('applies step.failed event', () => {
      const stepState = makeStepState({ status: 'STARTED' });
      const stepStates = new Map<string, StepHotState>([[stepState.stepExecutionId, stepState]]);
      const runState = makeRunState({ status: 'RUNNING' });

      const event = makeEvent(
        7,
        'step.failed',
        { errorRef: 'gcs://bucket/error' },
        stepState.stepExecutionId,
      );

      const result = applyRecoveryEvent(runState, stepStates, event);
      const updated = result.stepStates.get(stepState.stepExecutionId);
      expect(updated?.status).toBe('FAILED');
      expect(updated?.errorRef).toBe('gcs://bucket/error');
    });

    it('applies step.paused event and updates run status', () => {
      const stepState = makeStepState({ status: 'STARTED' });
      const stepStates = new Map<string, StepHotState>([[stepState.stepExecutionId, stepState]]);
      const runState = makeRunState({ status: 'RUNNING' });

      const event = makeEvent(
        8,
        'step.paused',
        { pauseReason: 'user_input', requestedInputRef: 'ref-123' },
        stepState.stepExecutionId,
      );

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.stepStates.get(stepState.stepExecutionId)?.status).toBe('PAUSED');
      expect(result.runState.status).toBe('PAUSED');
      expect(result.runState.pauseReason).toBe('user_input');
      expect(result.runState.requestedInputRef).toBe('ref-123');
    });

    it('applies state.variable_patch event', () => {
      const runState = makeRunState({
        status: 'RUNNING',
        runtimeState: {
          schemaVersion: 1,
          variables: { x: 1 },
          version: 0,
          updatedAtMs: 1000,
        },
      });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(9, 'state.variable_patch', {
        variables: { y: 2 },
        version: 1,
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.runtimeState?.variables).toEqual({ x: 1, y: 2 });
      expect(result.runState.runtimeState?.version).toBe(1);
    });

    it('applies run.status_changed.runStatePatch fields (Plan 145)', () => {
      const runState = makeRunState({ status: 'RUNNING' });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(2, 'run.status_changed', {
        fromStatus: 'RUNNING',
        toStatus: 'PAUSED',
        runStatePatch: {
          pauseReason: 'input_required',
          pauseType: 'user_input',
          requestedInputRef: 'inline:eyJ4Ijoxfg==',
        },
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('PAUSED');
      expect(result.runState.pauseReason).toBe('input_required');
      expect(result.runState.pauseType).toBe('user_input');
      expect(result.runState.requestedInputRef).toBe('inline:eyJ4Ijoxfg==');
    });

    it('applies run.status_changed.clearedRunStateFields (Plan 145)', () => {
      const runState = makeRunState({
        status: 'WAITING_ON_CHILD',
        delegationPauseSource: 'child_running',
        delegationWaitMode: 'until_pause',
        pauseType: 'subflow_waiting',
        waitingForChildSessionIds: ['child-1'],
      });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(3, 'run.status_changed', {
        fromStatus: 'WAITING_ON_CHILD',
        toStatus: 'RUNNING',
        runStatePatch: { status: 'RUNNING' },
        clearedRunStateFields: [
          'delegationPauseSource',
          'delegationWaitMode',
          'pauseType',
          'waitingForChildSessionIds',
        ],
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('RUNNING');
      expect(result.runState.delegationPauseSource).toBeUndefined();
      expect(result.runState.delegationWaitMode).toBeUndefined();
      expect(result.runState.pauseType).toBeUndefined();
      expect(result.runState.waitingForChildSessionIds).toBeUndefined();
    });

    it('runStatePatch overrides legacy toStatus when both set (Plan 145)', () => {
      // Replay applies toStatus then runStatePatch — patch wins by ordering.
      // Future writers should prefer runStatePatch.status; keeping legacy
      // toStatus for backward compat across mixed-version event streams.
      const runState = makeRunState({ status: 'RUNNING' });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(4, 'run.status_changed', {
        fromStatus: 'RUNNING',
        toStatus: 'PAUSED', // ← legacy field
        runStatePatch: { status: 'WAITING_ON_CHILD' }, // ← new field wins
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('WAITING_ON_CHILD');
    });

    it('replays agent-turn pause_for_input as SUCCEEDED step + PAUSED run (Plan 145 §6.2)', () => {
      // The agent-turn `pause_for_input` flow writes the step as SUCCEEDED in
      // hot state and pauses the run. The matching recovery shape is
      // `step.succeeded` + `run.status_changed (RUNNING→PAUSED with pause
      // runStatePatch)`. This test confirms replay reconstructs the same
      // hot state.
      let runState = makeRunState({ status: 'RUNNING' });
      let stepStates = new Map<string, StepHotState>();
      const agentStep = makeStepState({
        status: 'STARTED',
        operationId: 'ai.agent.turn',
        stepId: 'agent',
      });
      stepStates.set(agentStep.stepExecutionId, agentStep);

      const events: RecoveryEventEnvelope[] = [
        makeEvent(
          1,
          'step.succeeded',
          { outputRef: 'gcs://b/agent-turn-output' },
          agentStep.stepExecutionId,
        ),
        makeEvent(2, 'run.status_changed', {
          fromStatus: 'RUNNING',
          toStatus: 'PAUSED',
          runStatePatch: {
            status: 'PAUSED',
            pauseReason: 'input_required',
            pauseType: 'user_input',
            requestedInputRef: 'inline:dGVzdA==',
          },
        }),
      ];

      for (const event of events) {
        ({ runState, stepStates } = applyRecoveryEvent(runState, stepStates, event));
      }

      // Step state matches what the live `ai.agent.turn pause_for_input` path
      // writes: SUCCEEDED with the output ref.
      const replayedStep = stepStates.get(agentStep.stepExecutionId);
      expect(replayedStep?.status).toBe('SUCCEEDED');
      expect(replayedStep?.outputRef).toBe('gcs://b/agent-turn-output');

      // Run state matches the live SessionHotState after the pause.
      expect(runState.status).toBe('PAUSED');
      expect(runState.pauseReason).toBe('input_required');
      expect(runState.pauseType).toBe('user_input');
      expect(runState.requestedInputRef).toBe('inline:dGVzdA==');
    });

    it('replays child-resume wake with cleared delegation fields (Plan 145 §6.1)', () => {
      // Parent session was WAITING_ON_CHILD with delegation metadata. Child
      // completes → `leaveChildWaitToRunning` emits a `run.status_changed`
      // event with runStatePatch.status=RUNNING and clears all delegation
      // fields. Replay must reconstruct the same hot state the live path
      // produces (status=RUNNING, all delegation fields gone).
      let runState = makeRunState({
        status: 'WAITING_ON_CHILD',
        delegationPauseSource: 'child_running',
        delegationWaitMode: 'until_pause',
        pauseType: 'subflow_waiting',
        waitingForChildSessionIds: ['c-1'],
      });
      let stepStates = new Map<string, StepHotState>();

      const event = makeEvent(1, 'run.status_changed', {
        fromStatus: 'WAITING_ON_CHILD',
        toStatus: 'RUNNING',
        runStatePatch: { status: 'RUNNING' },
        clearedRunStateFields: [
          'delegationPauseSource',
          'delegationWaitMode',
          'pauseType',
          'pausedChildSessionId',
          'childPausedStepExecutionId',
          'pauseReason',
          'requestedInputRef',
          'waitingForChildSessionIds',
        ],
      });

      ({ runState, stepStates } = applyRecoveryEvent(runState, stepStates, event));

      expect(runState.status).toBe('RUNNING');
      expect(runState.delegationPauseSource).toBeUndefined();
      expect(runState.delegationWaitMode).toBeUndefined();
      expect(runState.pauseType).toBeUndefined();
      expect(runState.waitingForChildSessionIds).toBeUndefined();
    });

    it('replays step.paused child-input bubble preserves delegation routing (Plan 145 P1)', () => {
      // `bubbleChildPause` (Path B) writes a parent-side pause with
      // `runStateUpdates: { delegationPauseSource: 'child_input',
      // pausedChildSessionId, childPausedStepExecutionId }` and
      // `pauseType: 'subflow_waiting'`. The step itself stays PAUSED
      // (not SUCCEEDED — it's a resumable bubble step). Recovery emits
      // `step.paused` + `run.status_changed (RUNNING→PAUSED with the
      // routing fields on runStatePatch)`. Replay MUST restore those
      // fields, otherwise `resumeRun` won't take the child-input relay
      // branch and the user's reply will be mis-routed to the parent.
      let runState = makeRunState({ status: 'RUNNING' });
      let stepStates = new Map<string, StepHotState>();
      const bubbleStep = makeStepState({
        status: 'STARTED',
        stepId: 'parent-agent-step',
      });
      stepStates.set(bubbleStep.stepExecutionId, bubbleStep);

      const events: RecoveryEventEnvelope[] = [
        makeEvent(
          1,
          'step.paused',
          { pauseReason: 'input_required', requestedInputRef: 'inline:cGF1c2U=' },
          bubbleStep.stepExecutionId,
        ),
        makeEvent(2, 'run.status_changed', {
          fromStatus: 'RUNNING',
          toStatus: 'PAUSED',
          runStatePatch: {
            status: 'PAUSED',
            pauseReason: 'input_required',
            requestedInputRef: 'inline:cGF1c2U=',
            pauseType: 'subflow_waiting',
            delegationPauseSource: 'child_input',
            pausedChildSessionId: '00000000-0000-0000-0000-000000000d01',
            childPausedStepExecutionId: '00000000-0000-0000-0000-000000000d02',
            pauseMetadataJson: '{"pauseType":"subflow_waiting"}',
            currentStepId: 'parent-agent-step',
            currentStepExecutionId: bubbleStep.stepExecutionId,
          },
        }),
      ];

      for (const event of events) {
        ({ runState, stepStates } = applyRecoveryEvent(runState, stepStates, event));
      }

      // Step gets the PAUSED status from `step.paused` (it's resumable).
      expect(stepStates.get(bubbleStep.stepExecutionId)?.status).toBe('PAUSED');

      // Run gets full delegation routing — this is the bit that mattered.
      // Without it, resumeRun would route a user reply to the parent agent
      // instead of relaying it to the paused child.
      expect(runState.status).toBe('PAUSED');
      expect(runState.delegationPauseSource).toBe('child_input');
      expect(runState.pausedChildSessionId).toBe('00000000-0000-0000-0000-000000000d01');
      expect(runState.childPausedStepExecutionId).toBe('00000000-0000-0000-0000-000000000d02');
      expect(runState.pauseType).toBe('subflow_waiting');
      expect(runState.requestedInputRef).toBe('inline:cGF1c2U=');
    });

    it('legacy run.status_changed (toStatus only) still applied (Plan 145 backward compat)', () => {
      const runState = makeRunState({ status: 'RUNNING' });
      const stepStates = new Map<string, StepHotState>();

      const event = makeEvent(1, 'run.status_changed', {
        fromStatus: 'RUNNING',
        toStatus: 'PAUSED',
      });

      const result = applyRecoveryEvent(runState, stepStates, event);
      expect(result.runState.status).toBe('PAUSED');
    });

    it('replays a full run lifecycle', () => {
      let runState = makeRunState();
      let stepStates = new Map<string, StepHotState>();

      const fullRunState = makeRunState({ status: 'RUNNING' });
      const step1 = makeStepState();

      const events: RecoveryEventEnvelope[] = [
        makeEvent(1, 'run.created', { runHotState: fullRunState, stepHotState: step1 }),
        makeEvent(2, 'step.claimed', {}, step1.stepExecutionId),
        makeEvent(3, 'step.succeeded', { outputRef: 'ref-out' }, step1.stepExecutionId),
        makeEvent(4, 'run.completed', { fromStatus: 'RUNNING', toStatus: 'SUCCEEDED' }),
      ];

      for (const event of events) {
        ({ runState, stepStates } = applyRecoveryEvent(runState, stepStates, event));
      }

      expect(runState.status).toBe('SUCCEEDED');
      expect(stepStates.get(step1.stepExecutionId)?.status).toBe('SUCCEEDED');
      expect(stepStates.get(step1.stepExecutionId)?.outputRef).toBe('ref-out');
    });
  });
});
