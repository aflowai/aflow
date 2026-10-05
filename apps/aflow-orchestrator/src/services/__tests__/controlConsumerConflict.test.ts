/**
 * The destructive resume race, pinned end-to-end through the consumer.
 *
 * Two editors resolve the same pause. The winner's resume applies and the run
 * is RUNNING. The loser's message reaches the orchestrator, which rejects it as
 * a conflict. Before this fix the consumer's catch-all routed that rejection to
 * `markRunFailed`, overwriting the winner's RUNNING state with FAILED — two
 * people clicking resume killed healthy work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal ShardStreamSet for a fake owner; avoids depending on the redis mock. */
function fakeStreamSet(shardIds: number[], prefix: string) {
  const streamMap = new Map(shardIds.map((id) => [`aflow:shard:${String(id)}:${prefix}`, id]));
  return { streamKeys: [...streamMap.keys()], streamMap };
}

import type { ControlMessage } from '@aflow/schemas';

const mockAck = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockSetSessionState = vi.fn();
const mockMarkSessionDirty = vi.fn();
const mockGetSessionStateSafe = vi.fn();
const mockReadFresh = vi.fn();
const mockReadPending = vi.fn(async () => []);

vi.mock('@aflow/redis', () => ({
  readShardControlMessages: (...args: unknown[]) => mockReadFresh(...args),
  readShardPendingControlMessages: (...args: unknown[]) => mockReadPending(...args),
  ackShardControlMessage: (...args: unknown[]) => mockAck(...args),
  setSessionState: (...args: unknown[]) => mockSetSessionState(...args),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
  updateSessionState: vi.fn(),
  shardFor: () => 1,
  validateShardOwnership: async () => true,
  getShardRegistryEntry: async () => null,
  claimShardPendingMessages: vi.fn(),
  streamIdToTimestampMs: () => Date.now(),
}));

const { createControlConsumer } = await import('../ControlConsumer.js');
const { ControlConflictError } = await import('../../lib/controlConflict.js');

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = 'tenant-1';

const resumeMessage = {
  messageVersion: 1,
  type: 'resume_run',
  tenantId: TENANT_ID,
  runId: RUN_ID,
  stepExecutionId: '22222222-2222-4222-8222-222222222222',
  inputRef: 'inline:e30=',
  traceId: 'trace-1',
  idempotencyKey: 'idem-loser',
  requestedAtMs: Date.now(),
} as unknown as ControlMessage;

/** State the winner left behind: the run is live again. */
const runningState = {
  ok: true,
  state: {
    sessionId: RUN_ID,
    tenantId: TENANT_ID,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
  },
};

async function runConsumerOnce(resumeRun: () => Promise<unknown>) {
  let delivered = false;
  // Yield a macrotask each poll — an all-microtask loop would starve the
  // timers `vi.waitFor` runs on.
  mockReadFresh.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (delivered) return [];
    delivered = true;
    return [{ id: '1-0', shardId: 1, message: resumeMessage }];
  });

  const consumer = createControlConsumer(
    {
      blockingRedis: {} as never,
      redis: {} as never,
      executionService: { resumeRun } as never,
      shardManager: {
        ownedShards: () => [1],
        resultStreams: () => fakeStreamSet([1], 'results'),
        controlStreams: () => fakeStreamSet([1], 'control'),
        fencingToken: () => 1,
        revokeShard: vi.fn(),
      } as never,
      wakeHold: { remainingMs: () => 0 },
    },
    { consumerName: 'test-consumer', batchSize: 4, blockMs: 0 },
  );

  consumer.start();
  await vi.waitFor(() => expect(mockAck).toHaveBeenCalled());
  await consumer.stop();
}

describe('ControlConsumer — losing control action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPending.mockResolvedValue([]);
    mockGetSessionStateSafe.mockResolvedValue(runningState);
  });

  it('leaves the winner’s RUNNING run untouched and emits a typed conflict', async () => {
    await runConsumerOnce(async () => {
      throw new ControlConflictError(
        'run_not_paused',
        `Run ${RUN_ID} is not paused (status: RUNNING)`,
        { observedStatus: 'RUNNING' },
      );
    });

    // The run keeps running: no FAILED write, no dirty flush of a failure.
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockMarkSessionDirty).not.toHaveBeenCalled();

    const events = mockAppendSessionEvent.mock.calls.map((call) => call[3]);
    expect(events.map((e) => e.eventType)).toEqual(['ControlRejected']);
    expect(events[0].metadata).toMatchObject({
      conflictCode: 'run_not_paused',
      controlMessageType: 'resume_run',
      observedStatus: 'RUNNING',
    });
    expect(events.some((e) => e.eventType === 'SessionFailed')).toBe(false);

    // Still acked — a void command must not redeliver forever.
    expect(mockAck).toHaveBeenCalledTimes(1);
  });

  it('still fails the run when the error is a genuine failure', async () => {
    await runConsumerOnce(async () => {
      throw new Error('agent definition could not be loaded');
    });

    expect(mockSetSessionState).toHaveBeenCalledTimes(1);
    expect(mockSetSessionState.mock.calls[0]?.[1]).toMatchObject({ status: 'FAILED' });
    const events = mockAppendSessionEvent.mock.calls.map((call) => call[3]);
    expect(events.map((e) => e.eventType)).toEqual(['SessionFailed']);
  });

  it('never rewrites a run that already settled', async () => {
    mockGetSessionStateSafe.mockResolvedValue({
      ok: true,
      state: { ...runningState.state, status: 'SUCCEEDED' },
    });

    await runConsumerOnce(async () => {
      throw new Error('late cancel arrived after completion');
    });

    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockAppendSessionEvent).not.toHaveBeenCalled();
    expect(mockAck).toHaveBeenCalledTimes(1);
  });
});
