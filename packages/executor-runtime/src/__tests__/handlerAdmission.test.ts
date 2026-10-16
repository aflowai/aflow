/**
 * A step whose handler must hold something before it runs — a lease on a
 * model runtime — waits for it by the rules of an operation slot: it stays
 * SCHEDULED, gives back its executor slot, keeps its claim alive, and starts
 * its timeout only once admitted. Whatever it was admitted with is released
 * when the attempt ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    getStepState: vi.fn(),
    updateStepState: vi.fn().mockResolvedValue(undefined),
    appendSessionEvent: vi.fn().mockResolvedValue(undefined),
    registerStepInFlight: vi.fn().mockResolvedValue(undefined),
    extendStepInFlight: vi.fn().mockResolvedValue(undefined),
    clearStepInFlight: vi.fn().mockResolvedValue(undefined),
    wasStepCancelled: vi.fn().mockResolvedValue(false),
    releaseStepJob: vi.fn().mockResolvedValue('2-0'),
    StepJobNotPendingError: class StepJobNotPendingError extends Error {},
  },
}));
vi.mock('@aflow/redis', () => redisMock);

const { reportingMock } = vi.hoisted(() => ({
  reportingMock: {
    acknowledgeJob: vi.fn().mockResolvedValue(undefined),
    emitFailure: vi.fn().mockResolvedValue(undefined),
    emitResult: vi.fn().mockResolvedValue(undefined),
    emitSuccess: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../executor/resultReporting.js', () => reportingMock);

vi.mock('../executor/buildContext.js', () => ({
  buildExecutionContext: vi.fn((_deps: unknown, job: unknown) =>
    Promise.resolve({
      job,
      outputExists: () => Promise.resolve(undefined),
      stepDefinition: undefined,
    }),
  ),
}));

import { processJob } from '../executor/processJob.js';
import type { StepAdmissionWaiting } from '../types.js';

const SCHEDULED_AT = 1_800_000_000_000;
/** Longer than the step's own timeout, so a wait charged to it would fail it. */
const ADMISSION_WAIT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 60_000;

const JOB = {
  tenantId: 't1',
  sessionId: 'session-1',
  stepExecutionId: 'turn-queued',
  stepType: 'ai',
  stepId: 'turn',
  attempt: 1,
  operationId: 'ai.agent.turn',
  inputRef: 'inline:e30=',
} as never;

const startedWrites = (): unknown[] =>
  redisMock.updateStepState.mock.calls.filter(
    ([, , , patch]: [unknown, unknown, unknown, { status?: string }]) => patch.status === 'STARTED',
  );

describe('processJob — a step waiting for what its handler must hold', () => {
  let execute: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let admitNow: () => void;
  let seenWaiting: StepAdmissionWaiting | undefined;
  let slot: { held: boolean; release: ReturnType<typeof vi.fn>; acquire: ReturnType<typeof vi.fn> };
  let claimingStopped: AbortController;

  function host() {
    const handler = {
      stepType: 'ai',
      execute,
      resolveTimeoutMs: () => Promise.resolve(STEP_TIMEOUT_MS),
      admit: (_ctx: unknown, waiting: StepAdmissionWaiting) => {
        seenWaiting = waiting;
        waiting.waiting({ runtimeId: 'this-machine:11434' });
        return new Promise<{ release: () => Promise<void> }>((resolve, reject) => {
          const timer = setInterval(() => waiting.stillWaiting(), 10_000);
          admitNow = () => {
            clearInterval(timer);
            resolve({ release });
          };
          waiting.signal.addEventListener('abort', () => {
            clearInterval(timer);
            reject(new Error('aborted'));
          });
        });
      },
    };
    return {
      config: { consumerName: 'ai-test', defaultTimeoutMs: STEP_TIMEOUT_MS },
      deps: { redis: {} },
      handlers: new Map([['ai', handler]]),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      abortControllers: new Map<string, AbortController>(),
      operationLimiters: new Map(),
      claimingStopped: claimingStopped.signal,
      stopped: new AbortController().signal,
      stepStarted: vi.fn(),
      stepRunning: vi.fn(),
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: SCHEDULED_AT });
    redisMock.getStepState.mockResolvedValue({
      status: 'SCHEDULED',
      attempt: 1,
      scheduledAt: SCHEDULED_AT,
    });
    execute = vi.fn().mockResolvedValue({ status: 'SUCCEEDED', outputRef: 'inline:e30=' });
    release = vi.fn().mockResolvedValue(undefined);
    slot = { held: true, release: vi.fn(), acquire: vi.fn().mockResolvedValue(undefined) };
    claimingStopped = new AbortController();
    seenWaiting = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays SCHEDULED while it waits, without its slot, and keeps its claim alive', async () => {
    const processing = processJob(host(), '1-0', JOB, slot as never);
    await vi.advanceTimersByTimeAsync(ADMISSION_WAIT_MS);

    expect(startedWrites()).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(slot.release).toHaveBeenCalledTimes(1);
    expect(redisMock.registerStepInFlight.mock.calls.length).toBeGreaterThan(1);

    admitNow();
    await processing;
    expect(slot.acquire).toHaveBeenCalledTimes(1);
  });

  it('starts its timeout on admission, so a wait longer than the timeout does not fail it', async () => {
    const processing = processJob(host(), '1-0', JOB, slot as never);
    await vi.advanceTimersByTimeAsync(ADMISSION_WAIT_MS);
    admitNow();
    await processing;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(reportingMock.emitResult).toHaveBeenCalledTimes(1);
    expect(reportingMock.emitFailure).not.toHaveBeenCalled();
  });

  it('releases what it was admitted with when the attempt ends', async () => {
    const processing = processJob(host(), '1-0', JOB, slot as never);
    await vi.advanceTimersByTimeAsync(1_000);
    admitNow();
    await processing;

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(
      execute.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('a cancelled wait never starts the step', async () => {
    const h = host() as unknown as { abortControllers: Map<string, AbortController> };
    const processing = processJob(h as never, '1-0', JOB, slot as never);
    await vi.advanceTimersByTimeAsync(1_000);
    h.abortControllers.get('turn-queued')?.abort();
    await processing;

    expect(execute).not.toHaveBeenCalled();
    expect(startedWrites()).toHaveLength(0);
    expect(reportingMock.acknowledgeJob).toHaveBeenCalledTimes(1);
    expect(seenWaiting?.signal.aborted).toBe(true);
  });

  it('gives the step back to its stream when the executor stops claiming', async () => {
    const processing = processJob(host(), '1-0', JOB, slot as never);
    await vi.advanceTimersByTimeAsync(1_000);
    claimingStopped.abort();
    await processing;

    expect(execute).not.toHaveBeenCalled();
    expect(startedWrites()).toHaveLength(0);
    expect(redisMock.releaseStepJob).toHaveBeenCalledTimes(1);
  });
});
