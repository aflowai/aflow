import { describe, it, expect, afterEach } from 'vitest';
import { TimerItemSchema } from '../runtime/streamMessages.js';
import {
  SNOOZE_OPERATION_ID,
  SNOOZE_MIN_MS_DEFAULT,
  SNOOZE_MAX_MS_DEFAULT,
  SnoozeInputSchema,
  SnoozeOutputSchema,
  getSnoozeMinMs,
  getSnoozeMaxMs,
  clampSnoozeDurationMs,
  resolveSnoozeDelayMs,
} from '../schedules/operations.js';
import { getOperation, validateStepInput } from '../catalog/index.js';

const UUID_A = '11111111-1111-4111-9111-111111111111';
const UUID_B = '22222222-2222-4222-9222-222222222222';
const UUID_C = '33333333-3333-4333-9333-333333333333';
const UUID_D = '44444444-4444-4444-9444-444444444444';

const baseTimerFields = {
  tenantId: UUID_A,
  stepExecutionId: UUID_B,
  stepId: 'snooze-step',
  operationId: 'agent.schedule.snooze',
  stepType: 'agent',
  reason: 'delayed_start',
  attempt: 1,
  inputRef: `inline:${Buffer.from(JSON.stringify({ durationMs: 60000 })).toString('base64')}`,
  traceId: 'trace-1',
  dueAtMs: Date.now() + 60_000,
} as const;

describe('TimerItem correlation (Plan 194 §4.1)', () => {
  it('accepts a session-correlated timer (historical shape)', () => {
    const parsed = TimerItemSchema.parse({ ...baseTimerFields, sessionId: UUID_C });
    expect(parsed.sessionId).toBe(UUID_C);
    expect(parsed.workflowExecution).toBeUndefined();
  });

  it('accepts a workflow-correlated timer and round-trips through JSON', () => {
    const workflowExecution = {
      runId: UUID_C,
      taskId: 'poll-lb',
      attempt: 2,
      dispatchAttemptToken: `dispatch:${UUID_C}:poll-lb:2`,
    };
    const timer = TimerItemSchema.parse({
      ...baseTimerFields,
      workflowExecution,
      spaceId: UUID_D,
      credentialOwnerId: 'user-1',
    });
    expect(timer.sessionId).toBeUndefined();
    expect(timer.workflowExecution).toEqual(workflowExecution);

    // The timers ZSET stores JSON.stringify(timer) and re-parses on pop.
    const roundTripped = TimerItemSchema.parse(JSON.parse(JSON.stringify(timer)));
    expect(roundTripped).toEqual(timer);
    expect(roundTripped.workflowExecution?.dispatchAttemptToken).toBe(
      workflowExecution.dispatchAttemptToken,
    );
    expect(roundTripped.spaceId).toBe(UUID_D);
    expect(roundTripped.credentialOwnerId).toBe('user-1');
  });

  it('rejects a timer with BOTH sessionId and workflowExecution', () => {
    const result = TimerItemSchema.safeParse({
      ...baseTimerFields,
      sessionId: UUID_C,
      workflowExecution: {
        runId: UUID_C,
        taskId: 't',
        attempt: 1,
        dispatchAttemptToken: 'dispatch:x:t:1',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a timer with NEITHER sessionId nor workflowExecution', () => {
    const result = TimerItemSchema.safeParse({ ...baseTimerFields });
    expect(result.success).toBe(false);
  });

  it('preserves parentStepExecutionId on session timers (snooze tool sub-steps)', () => {
    const parsed = TimerItemSchema.parse({
      ...baseTimerFields,
      sessionId: UUID_C,
      parentStepExecutionId: UUID_D,
    });
    expect(parsed.parentStepExecutionId).toBe(UUID_D);
  });
});

describe('snooze clamps (Plan 194 §4.1)', () => {
  afterEach(() => {
    delete process.env['SNOOZE_MIN_MS'];
    delete process.env['SNOOZE_MAX_MS'];
  });

  it('defaults: min 1s, max 15min', () => {
    expect(getSnoozeMinMs()).toBe(SNOOZE_MIN_MS_DEFAULT);
    expect(getSnoozeMaxMs()).toBe(SNOOZE_MAX_MS_DEFAULT);
    expect(SNOOZE_MIN_MS_DEFAULT).toBe(1_000);
    expect(SNOOZE_MAX_MS_DEFAULT).toBe(15 * 60_000);
  });

  it('accepts an in-range duration unchanged', () => {
    const parsed = SnoozeInputSchema.parse({ durationMs: 60_000 });
    expect(parsed.durationMs).toBe(60_000);
    expect(resolveSnoozeDelayMs({ durationMs: 60_000 })).toBe(60_000);
  });

  it('clamps below-min durations up to the minimum (no error)', () => {
    expect(clampSnoozeDurationMs(10)).toBe(SNOOZE_MIN_MS_DEFAULT);
    expect(resolveSnoozeDelayMs({ durationMs: 10 })).toBe(SNOOZE_MIN_MS_DEFAULT);
  });

  it('rejects above-max durations with a teaching error pointing at resume_run schedules', () => {
    const result = SnoozeInputSchema.safeParse({ durationMs: SNOOZE_MAX_MS_DEFAULT + 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join('; ');
      expect(message).toContain('agent.schedule.create');
      expect(message).toContain('resume_run');
    }
    expect(() => resolveSnoozeDelayMs({ durationMs: SNOOZE_MAX_MS_DEFAULT + 1 })).toThrow(
      /resume_run/,
    );
  });

  it('rejects non-integer / non-positive durations', () => {
    expect(SnoozeInputSchema.safeParse({ durationMs: 0 }).success).toBe(false);
    expect(SnoozeInputSchema.safeParse({ durationMs: -5 }).success).toBe(false);
    expect(SnoozeInputSchema.safeParse({ durationMs: 1.5 }).success).toBe(false);
    expect(SnoozeInputSchema.safeParse({}).success).toBe(false);
  });

  it('clamp knobs are env-gated (SNOOZE_MIN_MS / SNOOZE_MAX_MS)', () => {
    process.env['SNOOZE_MIN_MS'] = '5000';
    process.env['SNOOZE_MAX_MS'] = '120000';
    expect(getSnoozeMinMs()).toBe(5_000);
    expect(getSnoozeMaxMs()).toBe(120_000);
    expect(clampSnoozeDurationMs(2_000)).toBe(5_000);
    expect(SnoozeInputSchema.safeParse({ durationMs: 120_001 }).success).toBe(false);
    expect(SnoozeInputSchema.safeParse({ durationMs: 120_000 }).success).toBe(true);
  });

  it('ignores malformed env values and falls back to defaults', () => {
    process.env['SNOOZE_MAX_MS'] = 'not-a-number';
    expect(getSnoozeMaxMs()).toBe(SNOOZE_MAX_MS_DEFAULT);
  });
});

describe('snooze catalog registration', () => {
  it('agent.schedule.snooze is registered with derived id and read access', () => {
    expect(SNOOZE_OPERATION_ID).toBe('agent.schedule.snooze');
    const op = getOperation(SNOOZE_OPERATION_ID);
    expect(op).toBeDefined();
    expect(op?.stepType).toBe('agent');
    expect(op?.group).toBe('schedule');
    expect(op?.mutates).toBe(false);
    expect(op?.accessMode).toBe('read');
  });

  it('op guidance supersedes sandbox-sleep', () => {
    const op = getOperation(SNOOZE_OPERATION_ID);
    const guidance = JSON.stringify(op?.usage ?? {}) + (op?.semanticDescription ?? '');
    expect(guidance).toContain('compute.sandbox.exec');
  });

  it('session-path input validation enforces the max (validateStepInput)', () => {
    const ok = validateStepInput(SNOOZE_OPERATION_ID, { durationMs: 30_000 });
    expect(ok.valid).toBe(true);

    const tooLong = validateStepInput(SNOOZE_OPERATION_ID, {
      durationMs: SNOOZE_MAX_MS_DEFAULT + 1,
    });
    expect(tooLong.valid).toBe(false);
    expect(JSON.stringify(tooLong.errors ?? [])).toContain('resume_run');
  });

  it('output schema accepts the inline handler shape', () => {
    const parsed = SnoozeOutputSchema.parse({
      requestedMs: 10,
      waitedMs: 1_000,
      resumedAt: new Date().toISOString(),
    });
    expect(parsed.waitedMs).toBe(1_000);
  });
});
