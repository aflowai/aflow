import { describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  getSessionState,
  setSessionState,
  type SessionHotState,
  type StepHotState,
} from '@aflow/redis';
import { RecoveryStreamKeys } from '@aflow/schemas';
import {
  buildRunPausedAfterStepSucceededRecoveryEvents,
  buildRunStatusChangedRecoveryEvent,
} from '../helpers/recoveryEmitter.js';
import { leaveChildInputToWaiting, leaveChildWaitToRunning } from '../helpers/delegationState.js';
import { applyRecoveryEvent } from '../../RecoveryService.js';
import { chooseResumeInputRef } from '../helpers/resumeInputRef.js';
import type { RecoveryEventEnvelope, SystemRole, TenantId } from '@aflow/schemas';

const TENANT = 'tenant-plan-145' as TenantId;
const RUN = '00000000-0000-0000-0000-000000000a01';
const STEP = '00000000-0000-0000-0000-000000000a02';

function freshSession(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'test-agent' as SystemRole },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    ...overrides,
  };
}

async function readRecoveryEvents(
  redis: RedisType,
  tenantId: string,
  runId: string,
): Promise<RecoveryEventEnvelope[]> {
  const key = RecoveryStreamKeys.recoveryStream(tenantId, runId);
  const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
  return entries.map(([, fields]) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const k = fields[i];
      const v = fields[i + 1];
      if (k !== undefined && v !== undefined) obj[k] = v;
    }
    return {
      version: Number(obj['version'] ?? '1'),
      type: obj['type'] as RecoveryEventEnvelope['type'],
      tenantId: obj['tenantId'] ?? tenantId,
      runId: obj['runId'] ?? runId,
      seq: Number(obj['seq'] ?? '0'),
      timestamp: Number(obj['timestamp'] ?? '0'),
      ...(obj['stepExecutionId'] ? { stepExecutionId: obj['stepExecutionId'] } : {}),
      data: obj['data'] ? (JSON.parse(obj['data']) as Record<string, unknown>) : {},
    };
  });
}

function replayAll(
  initialRun: SessionHotState,
  initialSteps: Map<string, StepHotState>,
  events: RecoveryEventEnvelope[],
): { runState: SessionHotState; stepStates: Map<string, StepHotState> } {
  let runState = initialRun;
  let stepStates = initialSteps;
  for (const event of events) {
    ({ runState, stepStates } = applyRecoveryEvent(runState, stepStates, event));
  }
  return { runState, stepStates };
}

describe('Plan 145 recovery-stream invariants', () => {
  describe('§6.1 — child-resume wake emits PAUSED/WAITING_ON_CHILD → RUNNING', () => {
    it('leaveChildWaitToRunning({fromStatus}) writes the recovery event atomically', async () => {
      const redis = new Redis() as unknown as RedisType;

      // Live state: parent waiting on a child, all delegation fields set.
      const initial = freshSession({
        status: 'WAITING_ON_CHILD',
        delegationPauseSource: 'child_running',
        delegationWaitMode: 'until_pause',
        pauseType: 'subflow_waiting',
        waitingForChildSessionIds: ['child-1'],
      });
      await setSessionState(redis, initial);

      await leaveChildWaitToRunning(redis, TENANT, RUN, { fromStatus: 'WAITING_ON_CHILD' });

      // Hot state: status flipped, delegation fields cleared,
      // waitingForChildSessionIds explicitly reset to [].
      const after = await getSessionState(redis, TENANT, RUN);
      expect(after?.status).toBe('RUNNING');
      expect(after?.delegationPauseSource).toBeUndefined();
      expect(after?.delegationWaitMode).toBeUndefined();
      expect(after?.pauseType).toBeUndefined();
      expect(after?.waitingForChildSessionIds).toEqual([]);

      // Recovery stream: one run.status_changed envelope with the patch
      // and the cleared-field list. `waitingForChildSessionIds` is on the
      // patch (as `[]`) rather than in `clearedRunStateFields` so replay
      const events = await readRecoveryEvents(redis, TENANT, RUN);
      expect(events.length).toBe(1);
      const ev = events[0]!;
      expect(ev.type).toBe('run.status_changed');
      expect(ev.data['fromStatus']).toBe('WAITING_ON_CHILD');
      expect(ev.data['toStatus']).toBe('RUNNING');
      expect(ev.data['runStatePatch']).toEqual({
        status: 'RUNNING',
        waitingForChildSessionIds: [],
      });
      const cleared = ev.data['clearedRunStateFields'] as string[];
      expect(cleared).toContain('delegationPauseSource');
      expect(cleared).toContain('delegationWaitMode');
      expect(cleared).toContain('pauseType');
      expect(cleared).not.toContain('waitingForChildSessionIds');
    });

    it('replaying the recovery event reconstructs the live hot state', async () => {
      const redis = new Redis() as unknown as RedisType;

      const initialRun = freshSession({
        status: 'WAITING_ON_CHILD',
        delegationPauseSource: 'child_running',
        delegationWaitMode: 'until_pause',
        pauseType: 'subflow_waiting',
        waitingForChildSessionIds: ['child-1'],
      });
      await setSessionState(redis, initialRun);

      await leaveChildWaitToRunning(redis, TENANT, RUN, { fromStatus: 'WAITING_ON_CHILD' });

      const liveAfter = await getSessionState(redis, TENANT, RUN);
      const events = await readRecoveryEvents(redis, TENANT, RUN);

      // Replay from the pre-transition state should match the live state on
      // every field the transition touches — including `waitingForChildSessionIds`
      const replayed = replayAll(initialRun, new Map(), events).runState;
      expect(replayed.status).toBe(liveAfter?.status);
      expect(replayed.delegationPauseSource).toBeUndefined();
      expect(replayed.delegationWaitMode).toBeUndefined();
      expect(replayed.pauseType).toBeUndefined();
      expect(replayed.waitingForChildSessionIds).toEqual([]);
      expect(liveAfter?.waitingForChildSessionIds).toEqual([]);
    });

    it('omitting fromStatus skips the recovery event (legacy path opt-out)', async () => {
      const redis = new Redis() as unknown as RedisType;
      // Use a distinct runId so this test isn't polluted by ioredis-mock's
      // process-shared in-memory store from sibling tests.
      const legacyRun = '00000000-0000-0000-0000-000000000a99';
      await setSessionState(
        redis,
        freshSession({ sessionId: legacyRun, status: 'WAITING_ON_CHILD' }),
      );

      // No fromStatus → existing behavior, no recovery event written.
      await leaveChildWaitToRunning(redis, TENANT, legacyRun);

      const events = await readRecoveryEvents(redis, TENANT, legacyRun);
      expect(events.length).toBe(0);

      // But the hot-state flip still happens.
      const after = await getSessionState(redis, TENANT, legacyRun);
      expect(after?.status).toBe('RUNNING');
    });
  });

  describe('child-input relay — PAUSED → WAITING_ON_CHILD (Plan 145 P1 round 3)', () => {
    it('leaveChildInputToWaiting({fromStatus}) emits run.status_changed atomically', async () => {
      const redis = new Redis() as unknown as RedisType;
      const relayRun = '00000000-0000-0000-0000-000000000c01';

      // Live state mirrors what `bubbleChildPause` writes when a child paused
      // for user input: PAUSED + child_input routing fields.
      await setSessionState(
        redis,
        freshSession({
          sessionId: relayRun,
          status: 'PAUSED',
          delegationPauseSource: 'child_input',
          pauseType: 'subflow_waiting',
          pauseReason: 'input_required',
          requestedInputRef: 'inline:dGVzdA==',
          pausedChildSessionId: '00000000-0000-0000-0000-000000000c02',
          childPausedStepExecutionId: '00000000-0000-0000-0000-000000000c03',
          waitingForChildSessionIds: ['00000000-0000-0000-0000-000000000c02'],
        }),
      );

      await leaveChildInputToWaiting(redis, TENANT, relayRun, { fromStatus: 'PAUSED' });

      // Hot state: parent back to WAITING_ON_CHILD, child-input fields cleared,
      // child_running set.
      const after = await getSessionState(redis, TENANT, relayRun);
      expect(after?.status).toBe('WAITING_ON_CHILD');
      expect(after?.delegationPauseSource).toBe('child_running');
      expect(after?.pauseType).toBe('subflow_waiting');
      expect(after?.requestedInputRef).toBeUndefined();
      expect(after?.pauseReason).toBeUndefined();
      expect(after?.pausedChildSessionId).toBeUndefined();
      expect(after?.childPausedStepExecutionId).toBeUndefined();

      // Recovery stream: one envelope with patch + cleared list.
      const events = await readRecoveryEvents(redis, TENANT, relayRun);
      expect(events.length).toBe(1);
      const ev = events[0]!;
      expect(ev.type).toBe('run.status_changed');
      expect(ev.data['fromStatus']).toBe('PAUSED');
      expect(ev.data['toStatus']).toBe('WAITING_ON_CHILD');
      expect(ev.data['runStatePatch']).toEqual({
        status: 'WAITING_ON_CHILD',
        delegationPauseSource: 'child_running',
        pauseType: 'subflow_waiting',
      });
      const cleared = ev.data['clearedRunStateFields'] as string[];
      expect(cleared).toEqual(
        expect.arrayContaining([
          'requestedInputRef',
          'pauseReason',
          'pausedChildSessionId',
          'childPausedStepExecutionId',
        ]),
      );
    });

    it('replaying the event reconstructs the live WAITING_ON_CHILD hot state', async () => {
      const redis = new Redis() as unknown as RedisType;
      const relayRun = '00000000-0000-0000-0000-000000000c11';

      const initialRun = freshSession({
        sessionId: relayRun,
        status: 'PAUSED',
        delegationPauseSource: 'child_input',
        pauseType: 'subflow_waiting',
        pauseReason: 'input_required',
        requestedInputRef: 'inline:dGVzdA==',
        pausedChildSessionId: '00000000-0000-0000-0000-000000000c12',
        childPausedStepExecutionId: '00000000-0000-0000-0000-000000000c13',
      });
      await setSessionState(redis, initialRun);

      await leaveChildInputToWaiting(redis, TENANT, relayRun, { fromStatus: 'PAUSED' });

      const liveAfter = await getSessionState(redis, TENANT, relayRun);
      const events = await readRecoveryEvents(redis, TENANT, relayRun);

      const replayed = replayAll(initialRun, new Map(), events).runState;
      expect(replayed.status).toBe(liveAfter?.status);
      expect(replayed.delegationPauseSource).toBe(liveAfter?.delegationPauseSource);
      expect(replayed.pauseType).toBe(liveAfter?.pauseType);
      expect(replayed.requestedInputRef).toBeUndefined();
      expect(replayed.pauseReason).toBeUndefined();
      expect(replayed.pausedChildSessionId).toBeUndefined();
      expect(replayed.childPausedStepExecutionId).toBeUndefined();
    });
  });

  describe('§6.2 — agent-turn pause emits step.succeeded + run.status_changed', () => {
    it('buildRunPausedAfterStepSucceededRecoveryEvents shape matches live transition', async () => {
      const redis = new Redis() as unknown as RedisType;

      const events = await buildRunPausedAfterStepSucceededRecoveryEvents(
        redis,
        TENANT,
        RUN,
        STEP,
        { outputRef: 'gcs://b/agent-turn-output' },
        {
          pauseReason: 'input_required',
          pauseType: 'user_input',
          requestedInputRef: 'inline:eyJ4Ijoxfg==',
        },
      );

      expect(events.length).toBe(2);
      expect(events[0]?.type).toBe('step.succeeded');
      expect(events[0]?.stepExecutionId).toBe(STEP);
      expect(events[0]?.data['outputRef']).toBe('gcs://b/agent-turn-output');

      expect(events[1]?.type).toBe('run.status_changed');
      expect(events[1]?.data['fromStatus']).toBe('RUNNING');
      expect(events[1]?.data['toStatus']).toBe('PAUSED');
      const patch = events[1]?.data['runStatePatch'] as Record<string, unknown>;
      expect(patch?.['status']).toBe('PAUSED');
      expect(patch?.['pauseReason']).toBe('input_required');
      expect(patch?.['pauseType']).toBe('user_input');
      expect(patch?.['requestedInputRef']).toBe('inline:eyJ4Ijoxfg==');
    });

    it('replayed SUCCEEDED agent-turn pause satisfies resumeRun preconditions', async () => {
      // §8 test-plan item — verify that the §6.2 change (agent-turn step
      // recorded as SUCCEEDED, run as PAUSED) does not break the canonical
      // resume flow. We replay the recovery pair onto a fresh state, then
      // check the two preconditions `SessionOrchestrator.resumeRun` reads:
      //
      //   1. `runState.status === 'PAUSED'` — `resumeRun` throws otherwise.
      //   2. `chooseResumeInputRef` resolves to the user's resume message,
      //      not the prior agent-turn input or the requestedInputRef
      //      handoff payload. Runner-style operations
      //      (`ai.agent.turn`, `agent.control.delegate`) must always adopt
      //      the user's reply on resume, regardless of step status.
      const redis = new Redis() as unknown as RedisType;
      const events = await buildRunPausedAfterStepSucceededRecoveryEvents(
        redis,
        TENANT,
        RUN,
        STEP,
        { outputRef: 'gcs://b/turn-output' },
        {
          pauseReason: 'input_required',
          pauseType: 'user_input',
          requestedInputRef: 'inline:eyJyZXF1ZXN0ZWQiOnRydWV9',
        },
      );

      const initialStep: StepHotState = {
        stepExecutionId: STEP,
        tenantId: TENANT,
        sessionId: RUN,
        stepId: 'agent',
        stepType: 'ai',
        operationId: 'ai.agent.turn',
        attempt: 1,
        status: 'STARTED',
        scheduledAt: 1,
        inputRef: 'inline:prior-agent-turn-input',
        idempotencyKey: 'k1',
      };
      const initialRun = freshSession({ status: 'RUNNING' });
      const { runState, stepStates } = replayAll(
        initialRun,
        new Map([[STEP, initialStep]]),
        events,
      );

      // Precondition 1: resumeRun's `runState.status !== 'PAUSED'` guard
      // accepts the replayed run.
      expect(runState.status).toBe('PAUSED');

      // Precondition 2: replayed step is SUCCEEDED (live shape), and the
      // resume helper still selects the user's resume message regardless.
      const replayedStep = stepStates.get(STEP);
      expect(replayedStep?.status).toBe('SUCCEEDED');

      const chosen = chooseResumeInputRef({
        operation: replayedStep?.operationId ?? '',
        stepStatus: replayedStep?.status ?? '',
        stepInputRef: replayedStep?.inputRef ?? null,
        paramsInputRef: 'inline:user-reply-on-resume',
        runRequestedInputRef: runState.requestedInputRef ?? null,
      });
      expect(chosen).toBe('inline:user-reply-on-resume');
    });

    it('replaying the pair reconstructs SUCCEEDED step + PAUSED run', async () => {
      const redis = new Redis() as unknown as RedisType;

      const events = await buildRunPausedAfterStepSucceededRecoveryEvents(
        redis,
        TENANT,
        RUN,
        STEP,
        { outputRef: 'gcs://b/out' },
        {
          pauseReason: 'input_required',
          pauseType: 'user_input',
          requestedInputRef: 'inline:dGVzdA==',
        },
      );

      // The step exists in hot state as STARTED before the agent turn finishes
      // — set up the initial step state for replay.
      const initialStep: StepHotState = {
        stepExecutionId: STEP,
        tenantId: TENANT,
        sessionId: RUN,
        stepId: 'agent',
        stepType: 'ai',
        operationId: 'ai.agent.turn',
        attempt: 1,
        status: 'STARTED',
        scheduledAt: 1,
        inputRef: 'inline:in',
        idempotencyKey: 'k1',
      };
      const initialRun = freshSession({ status: 'RUNNING' });
      const initialSteps = new Map([[STEP, initialStep]]);

      const { runState, stepStates } = replayAll(initialRun, initialSteps, events);

      expect(stepStates.get(STEP)?.status).toBe('SUCCEEDED');
      expect(stepStates.get(STEP)?.outputRef).toBe('gcs://b/out');
      expect(runState.status).toBe('PAUSED');
      expect(runState.pauseReason).toBe('input_required');
      expect(runState.pauseType).toBe('user_input');
      expect(runState.requestedInputRef).toBe('inline:dGVzdA==');
    });
  });

  describe('extended run.status_changed shape', () => {
    it('builder includes runStatePatch + clearedRunStateFields when provided', async () => {
      const redis = new Redis() as unknown as RedisType;
      const events = await buildRunStatusChangedRecoveryEvent(
        redis,
        TENANT,
        RUN,
        'RUNNING',
        'PAUSED',
        {
          runStatePatch: { status: 'PAUSED', pauseReason: 'input_required' },
          clearedRunStateFields: ['interruptRequested'],
        },
      );
      expect(events.length).toBe(1);
      expect(events[0]?.data['runStatePatch']).toEqual({
        status: 'PAUSED',
        pauseReason: 'input_required',
      });
      expect(events[0]?.data['clearedRunStateFields']).toEqual(['interruptRequested']);
    });

    it('builder omits new fields when opts not provided (backward compat)', async () => {
      const redis = new Redis() as unknown as RedisType;
      const events = await buildRunStatusChangedRecoveryEvent(
        redis,
        TENANT,
        RUN,
        'RUNNING',
        'FAILED',
      );
      expect(events.length).toBe(1);
      expect(events[0]?.data['runStatePatch']).toBeUndefined();
      expect(events[0]?.data['clearedRunStateFields']).toBeUndefined();
      // toStatus → run.completed for terminal statuses.
      expect(events[0]?.type).toBe('run.completed');
    });
  });
});
