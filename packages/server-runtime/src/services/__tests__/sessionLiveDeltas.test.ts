/**
 * The live plane's read side: what a watcher is handed while a step runs.
 *
 * The reader is driven by the durable tail loop — it observes each drained
 * durable event and reads the in-flight step's buffer after. Two properties
 * carry the design: a subscription that arrives mid-step reads from the
 * beginning of the buffer (the buffer is a value, not a log); and once a step's
 * terminal event has been observed, the reader structurally never yields
 * another frame for it, so a terminal event is always the last thing emitted
 * for its step.
 */
import { describe, expect, it } from 'vitest';
import {
  ServerRealtimeMessageSchema,
  StreamKeys,
  type ApiSessionEvent,
  type SessionId,
  type TenantId,
} from '@aflow/schemas';
import type { Redis } from 'ioredis';
import { createLiveDeltaReader } from '../sessionLiveDeltas.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const SESSION = '00000000-0000-4000-8000-0000000000bb' as SessionId;
const STEP_1 = '00000000-0000-4000-8000-000000000001';
const STEP_2 = '00000000-0000-4000-8000-000000000002';
/** The step a run dispatched to an operation task — it belongs to no session. */
const WORKER_STEP = '00000000-0000-4000-8000-000000000003';
const WAITER_STEP = '00000000-0000-4000-8000-0000000000cc';
const RUN = '00000000-0000-4000-8000-0000000000dd';

/** hget + pipeline(strlen,getrange) + getrange, byte-addressed like real Redis. */
class FakeRedis {
  currentStep: string | null = STEP_1;
  readonly buffers = new Map<string, string>();

  append(stepExecutionId: string, channel: 'text' | 'thinking' | 'activity', delta: string): void {
    const key = StreamKeys.liveStreamBuffer(TENANT, stepExecutionId, channel);
    this.buffers.set(key, (this.buffers.get(key) ?? '') + delta);
  }

  del(stepExecutionId: string): void {
    this.buffers.delete(StreamKeys.liveStreamBuffer(TENANT, stepExecutionId, 'text'));
    this.buffers.delete(StreamKeys.liveStreamBuffer(TENANT, stepExecutionId, 'thinking'));
  }

  hget(_key: string, field: string): Promise<string | null> {
    return Promise.resolve(field === 'currentStepExecutionId' ? this.currentStep : null);
  }

  private range(key: string, start: number, end: number): string {
    const buf = Buffer.from(this.buffers.get(key) ?? '', 'utf8');
    return buf.subarray(start, end === -1 ? undefined : end + 1).toString('utf8');
  }

  getrange(key: string, start: number, end: number): Promise<string> {
    return Promise.resolve(this.range(key, start, end));
  }

  pipeline() {
    const results: Array<[null, unknown]> = [];
    const chain = {
      strlen: (key: string) => {
        results.push([null, Buffer.byteLength(this.buffers.get(key) ?? '', 'utf8')]);
        return chain;
      },
      getrange: (key: string, start: number, end: number) => {
        results.push([null, this.range(key, start, end)]);
        return chain;
      },
      exec: () => Promise.resolve(results),
    };
    return chain;
  }
}

function stepEvent(
  eventType: string,
  stepExecutionId: string,
  metadata?: Record<string, unknown>,
): ApiSessionEvent {
  return {
    eventId: `${eventType}-${stepExecutionId}`,
    eventType,
    sessionId: SESSION,
    stepExecutionId,
    timestamp: new Date().toISOString(),
    sequenceNumber: 0,
    eventVersion: 1,
    data: {},
    ...(metadata ? { metadata } : {}),
  } as ApiSessionEvent;
}

function taskEvent(opts: {
  status: string;
  workerSessionId?: string;
  taskType?: 'agent' | 'operation' | 'human';
  taskId?: string;
}): ApiSessionEvent {
  return {
    eventId: `task-${opts.status}`,
    eventType: 'WorkflowTaskUpdate',
    sessionId: SESSION,
    timestamp: new Date().toISOString(),
    sequenceNumber: 0,
    eventVersion: 1,
    data: {
      workflowTaskUpdate: {
        runId: RUN,
        taskId: opts.taskId ?? 'review',
        label: 'Review the changes',
        status: opts.status,
        attempt: 1,
        ...(opts.workerSessionId ? { workerSessionId: opts.workerSessionId } : {}),
        ...(opts.taskType ? { taskType: opts.taskType } : {}),
      },
    },
  } as ApiSessionEvent;
}

const signal = new AbortController().signal;

function reader(redis: FakeRedis) {
  return createLiveDeltaReader(redis as unknown as Redis, TENANT, SESSION);
}

describe('createLiveDeltaReader', () => {
  it('hands a late reader the whole partial, then only what is new', async () => {
    const redis = new FakeRedis();
    const r = reader(redis);
    redis.append(STEP_1, 'text', 'Hello, ');
    redis.append(STEP_1, 'text', 'world');

    expect(await r.read(signal)).toEqual([
      { stepExecutionId: STEP_1, channel: 'text', offset: 0, delta: 'Hello, world' },
    ]);

    redis.append(STEP_1, 'text', '!');
    expect(await r.read(signal)).toEqual([
      { stepExecutionId: STEP_1, channel: 'text', offset: 12, delta: '!' },
    ]);
  });

  it('keeps the two channels apart', async () => {
    const redis = new FakeRedis();
    const r = reader(redis);
    redis.append(STEP_1, 'text', 'answer');
    redis.append(STEP_1, 'thinking', 'reasoning');

    expect(await r.read(signal)).toEqual([
      { stepExecutionId: STEP_1, channel: 'text', offset: 0, delta: 'answer' },
      { stepExecutionId: STEP_1, channel: 'thinking', offset: 0, delta: 'reasoning' },
    ]);
  });

  it('reads the next step from the start of its buffer', async () => {
    const redis = new FakeRedis();
    const r = reader(redis);
    redis.append(STEP_1, 'text', 'first turn');
    expect(await r.read(signal)).toMatchObject([{ stepExecutionId: STEP_1, delta: 'first turn' }]);

    redis.currentStep = STEP_2;
    redis.append(STEP_2, 'text', 'second turn');
    expect(await r.read(signal)).toEqual([
      { stepExecutionId: STEP_2, channel: 'text', offset: 0, delta: 'second turn' },
    ]);
  });

  it('yields nothing for a step once its terminal event was observed', async () => {
    const redis = new FakeRedis();
    const r = reader(redis);
    redis.append(STEP_1, 'text', 'partial answer');
    expect(await r.read(signal)).toHaveLength(1);

    // The terminal arrives; the loop feeds it here BEFORE the next read. Even
    // though hot state may still name STEP_1 and the buffer's DEL may not have
    // landed yet, the reader must not resurrect the promoted final message.
    r.observe(stepEvent('StepSucceeded', STEP_1));
    redis.append(STEP_1, 'text', ' …tail fragment');
    expect(await r.read(signal)).toEqual([]);
  });

  it('replaces (offset 0) when a retry reuses the step after the buffer was cleared', async () => {
    const redis = new FakeRedis();
    const r = reader(redis);
    redis.append(STEP_1, 'text', 'attempt one, a long first answer');
    expect(await r.read(signal)).toHaveLength(1);

    // Retryable failure: StepFailed(willRetry) must NOT terminate the step, the
    // buffer is DELeted, and the retry reuses STEP_1 with a shorter answer.
    r.observe(stepEvent('StepFailed', STEP_1, { willRetry: true }));
    redis.del(STEP_1);
    redis.append(STEP_1, 'text', 'retry');

    expect(await r.read(signal)).toEqual([
      { stepExecutionId: STEP_1, channel: 'text', offset: 0, delta: 'retry' },
    ]);
  });
});

describe('live frame wire shape', () => {
  it('cannot carry a durable cursor', () => {
    const parsed = ServerRealtimeMessageSchema.parse({
      type: 'live_delta',
      subscriptionId: 'sub-1',
      topicKey: `session.events:${SESSION}`,
      stepExecutionId: STEP_1,
      channel: 'text',
      offset: 0,
      delta: 'partial',
      cursor: '1700000000000-0',
    });
    expect(parsed).not.toHaveProperty('cursor');
  });
});

/**
 * A step a workflow dispatched has a run and a task where a chat step has a
 * session, so it is never the session's `currentStepExecutionId` — the session
 * is parked on the waiter step. The reader learns it from the task row the
 * surface is already built from, and reads its buffer beside its own step's.
 */
describe("the reader follows a run's task steps too", () => {
  function watching(): { redis: FakeRedis; r: ReturnType<typeof reader> } {
    const redis = new FakeRedis();
    redis.currentStep = WAITER_STEP;
    return { redis, r: reader(redis) };
  }

  it('reads nothing for a run it has heard nothing about', async () => {
    const { redis, r } = watching();
    redis.append(WORKER_STEP, 'activity', 'line\n');
    expect(await r.read(signal)).toEqual([]);
  });

  it("yields the task step's feed once the run says the task is running", async () => {
    const { redis, r } = watching();
    r.observe(
      taskEvent({ status: 'running', taskType: 'operation', workerSessionId: WORKER_STEP }),
    );
    redis.append(WORKER_STEP, 'activity', 'line one\n');

    expect(await r.read(signal)).toEqual([
      { stepExecutionId: WORKER_STEP, channel: 'activity', offset: 0, delta: 'line one\n' },
    ]);

    redis.append(WORKER_STEP, 'activity', 'line two\n');
    expect(await r.read(signal)).toEqual([
      {
        stepExecutionId: WORKER_STEP,
        channel: 'activity',
        offset: 'line one\n'.length,
        delta: 'line two\n',
      },
    ]);
  });

  it('hands a mount-time observer the whole feed that streamed before it', async () => {
    const { redis, r } = watching();
    redis.append(WORKER_STEP, 'activity', 'before the reader existed\n');
    // The mount page and the catch-up burst are observed before the first read,
    // which is what `SessionTailService.live` does with `seedEvents`.
    r.observe(
      taskEvent({ status: 'running', taskType: 'operation', workerSessionId: WORKER_STEP }),
    );

    expect(await r.read(signal)).toEqual([
      {
        stepExecutionId: WORKER_STEP,
        channel: 'activity',
        offset: 0,
        delta: 'before the reader existed\n',
      },
    ]);
  });

  it('stops once the task reaches a terminal status', async () => {
    const { redis, r } = watching();
    r.observe(
      taskEvent({ status: 'running', taskType: 'operation', workerSessionId: WORKER_STEP }),
    );
    redis.append(WORKER_STEP, 'activity', 'line\n');
    expect(await r.read(signal)).toHaveLength(1);

    r.observe(
      taskEvent({ status: 'succeeded', taskType: 'operation', workerSessionId: WORKER_STEP }),
    );
    redis.append(WORKER_STEP, 'activity', 'late tail\n');
    expect(await r.read(signal)).toEqual([]);
  });

  it('leaves an agent task alone — its worker session is a session, not a step', async () => {
    const { redis, r } = watching();
    r.observe(taskEvent({ status: 'running', taskType: 'agent', workerSessionId: WORKER_STEP }));
    redis.append(WORKER_STEP, 'activity', 'line\n');
    expect(await r.read(signal)).toEqual([]);
  });

  it("reads the session's own step and the task's at the same time", async () => {
    const redis = new FakeRedis();
    const r = reader(redis);
    r.observe(
      taskEvent({ status: 'running', taskType: 'operation', workerSessionId: WORKER_STEP }),
    );
    redis.append(STEP_1, 'text', 'the agent is talking');
    redis.append(WORKER_STEP, 'activity', 'the harness is working\n');

    expect(await r.read(signal)).toEqual([
      { stepExecutionId: STEP_1, channel: 'text', offset: 0, delta: 'the agent is talking' },
      {
        stepExecutionId: WORKER_STEP,
        channel: 'activity',
        offset: 0,
        delta: 'the harness is working\n',
      },
    ]);
  });
});
