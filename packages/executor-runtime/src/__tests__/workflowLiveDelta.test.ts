/**
 * A step a workflow dispatched still streams.
 *
 * Such a job carries a run and a task where a chat step carries a session, and
 * the live buffer is keyed by the step either way — so the append is the same
 * one. What differs is the wake: there is no session channel to publish on, so
 * it rides the task's progress stream, which is the road the run's watchers
 * already read.
 */
import { describe, expect, it } from 'vitest';
import { StreamKeys, type StepJobMessage } from '@aflow/schemas';
import { buildExecutionContext } from '../executor/buildContext.js';
import type { ExecutorDependencies, ExecutorLogger } from '../types.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION = 'b0000000-0000-0000-0000-000000000002';
const STEP = 'c0000000-0000-0000-0000-000000000003';
const RUN = 'e0000000-0000-0000-0000-000000000005';

const log: ExecutorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface Recorded {
  appends: Array<[string, string]>;
  publishes: Array<[string, string]>;
  xadds: string[][];
}

class FakeRedis {
  readonly recorded: Recorded = { appends: [], publishes: [], xadds: [] };

  multi() {
    const self = this;
    const chain = {
      append: (key: string, value: string) => {
        self.recorded.appends.push([key, value]);
        return chain;
      },
      expire: () => chain,
      publish: (channel: string, payload: string) => {
        self.recorded.publishes.push([channel, payload]);
        return chain;
      },
      exec: () => Promise.resolve([[null, 1]]),
    };
    return chain;
  }

  pipeline() {
    const self = this;
    const chain = {
      xadd: (...args: string[]) => {
        self.recorded.xadds.push(args);
        return chain;
      },
      expire: () => chain,
      sadd: () => chain,
      exec: () => Promise.resolve([]),
    };
    return chain;
  }
}

function makeDeps(redis: FakeRedis): ExecutorDependencies {
  return {
    payloadStore: {
      retrieve: async () => ({}),
      store: async () => 'inline:e30=' as never,
      buildRef: () => 'inline:e30=' as never,
      exists: async () => false,
    } as never,
    redis: redis as never,
  } as never;
}

function makeJob(overrides: Partial<StepJobMessage>): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: TENANT,
    stepExecutionId: STEP,
    stepId: 'review',
    stepType: 'host',
    operationId: 'host.harness.run',
    attempt: 1,
    idempotencyKey: 'idem-1',
    inputRef: 'inline:e30=',
    traceId: 'trace-1',
    scheduledAtMs: 1,
    ...overrides,
  } as StepJobMessage;
}

const WORKFLOW_JOB = makeJob({
  workflowExecution: {
    runId: RUN,
    taskId: 'review',
    attempt: 1,
    dispatchAttemptToken: `dispatch:${RUN}:review:1`,
  } as never,
});

describe('a workflow-dispatched step streams live', () => {
  it('appends the step buffer even with no session on the job', async () => {
    const redis = new FakeRedis();
    const ctx = await buildExecutionContext(makeDeps(redis), WORKFLOW_JOB, log);

    await ctx.emitLiveDelta('activity', '{"kind":"status"}\n');

    expect(redis.recorded.appends).toEqual([
      [StreamKeys.liveStreamBuffer(TENANT, STEP, 'activity'), '{"kind":"status"}\n'],
    ]);
  });

  it('publishes no session wake, because the job names no session', async () => {
    const redis = new FakeRedis();
    const ctx = await buildExecutionContext(makeDeps(redis), WORKFLOW_JOB, log);

    await ctx.emitLiveDelta('activity', 'line\n');

    expect(redis.recorded.publishes).toEqual([]);
  });

  it('puts the wake on the task progress stream, carrying the step and the run', async () => {
    const redis = new FakeRedis();
    const ctx = await buildExecutionContext(makeDeps(redis), WORKFLOW_JOB, log);

    await ctx.emitLiveDelta('activity', 'line\n');

    expect(redis.recorded.xadds).toHaveLength(1);
    const args = redis.recorded.xadds[0] ?? [];
    expect(args[0]).toBe(StreamKeys.workflowTaskProgressStream(TENANT, RUN, 'review'));
    const fields: Record<string, string> = {};
    for (let i = args.indexOf('*') + 1; i + 1 < args.length; i += 2) {
      fields[args[i] as string] = args[i + 1] as string;
    }
    expect(fields['eventType']).toBe('WorkflowTaskLiveDelta');
    expect(fields['runId']).toBe(RUN);
    expect(fields['taskId']).toBe('review');
    expect(fields['stepExecutionId']).toBe(STEP);
    expect(JSON.parse(fields['metadata'] ?? '{}')).toEqual({ channel: 'activity' });
  });

  it('a chat step keeps the session wake and writes no progress entry', async () => {
    const redis = new FakeRedis();
    const ctx = await buildExecutionContext(
      makeDeps(redis),
      makeJob({ sessionId: SESSION as never }),
      log,
    );

    await ctx.emitLiveDelta('text', 'hello');

    expect(redis.recorded.publishes).toHaveLength(1);
    expect(redis.recorded.publishes[0]?.[0]).toBe(StreamKeys.pubsubChannel(TENANT, SESSION));
    expect(redis.recorded.xadds).toEqual([]);
  });

  it('an empty delta writes nothing at all', async () => {
    const redis = new FakeRedis();
    const ctx = await buildExecutionContext(makeDeps(redis), WORKFLOW_JOB, log);

    await ctx.emitLiveDelta('activity', '');

    expect(redis.recorded.appends).toEqual([]);
    expect(redis.recorded.xadds).toEqual([]);
  });
});
