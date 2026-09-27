/**
 * appendSessionEvent folds candidate arming and the subscriber wake into the
 * append transaction. `MULTI` makes the batch atomic as a unit but gives no
 * conditionality between its commands: the XADD can succeed while the arming
 * fails, leaving an event the flush cannot discover. The repair is a detached
 * retry of the arming alone — these tests pin that it fires exactly when
 * arming failed and never when the whole transaction succeeded.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { appendSessionEvent } from '../hotState/events.js';

interface RecordedPipeline {
  commands: string[];
  exec: () => Promise<Array<[Error | null, unknown]>>;
}

function fakeRedis(
  firstExecResults: Array<[Error | null, unknown]>,
  repairExecResults: Array<[Error | null, unknown]> = [
    [null, 1],
    [null, 1],
  ],
): {
  redis: Redis;
  pipelines: RecordedPipeline[];
} {
  const pipelines: RecordedPipeline[] = [];
  const makePipeline = (results: Array<[Error | null, unknown]>): RecordedPipeline => {
    const commands: string[] = [];
    const p: Record<string, unknown> = { commands };
    for (const cmd of ['xadd', 'expire', 'zincrby', 'zadd', 'publish']) {
      p[cmd] = (): unknown => {
        commands.push(cmd);
        return p;
      };
    }
    p['exec'] = async (): Promise<Array<[Error | null, unknown]>> => results;
    const pipeline = p as unknown as RecordedPipeline;
    pipelines.push(pipeline);
    return pipeline;
  };
  let first = true;
  const next = (): RecordedPipeline => {
    const results = first ? firstExecResults : repairExecResults;
    first = false;
    return makePipeline(results);
  };
  const redis = {
    // The append opens a transaction; the detached repair opens a pipeline.
    multi: next,
    pipeline: next,
    publish: async (): Promise<number> => 1,
  } as unknown as Redis;
  return { redis, pipelines };
}

const event = {
  eventId: 'e-1',
  eventType: 'StepSucceeded',
  timestamp: Date.now(),
  sessionId: 'run-a',
} as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appendSessionEvent arming repair', () => {
  it('re-arms the candidate on a detached retry when arming fails after the append', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { redis, pipelines } = fakeRedis([
      [null, '1-1'],
      [null, 1],
      [new Error('WRONGTYPE'), null],
      [null, 1],
    ]);

    const id = await appendSessionEvent(redis, 'tenant-a', 'run-a', event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(id).toBe('1-1');
    expect(pipelines).toHaveLength(2);
    expect(pipelines[1]?.commands).toEqual(['zincrby', 'zadd']);
  });

  it('surfaces a repair whose commands failed inside the reply tuples', async () => {
    // Command errors resolve inside exec()'s result — the promise rejects only
    // for connection failures — so a repair that hit the same WRONGTYPE as the
    // arming must be read out of the tuples, not assumed repaired.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { redis } = fakeRedis(
      [
        [null, '1-1'],
        [null, 1],
        [new Error('WRONGTYPE'), null],
        [null, 1],
      ],
      [
        [new Error('WRONGTYPE'), null],
        [null, 1],
      ],
    );

    await appendSessionEvent(redis, 'tenant-a', 'run-a', event);
    await new Promise((resolve) => setImmediate(resolve));

    const rearmFailures = errorSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('re-arm failed'),
    );
    expect(rearmFailures).toHaveLength(1);
  });

  it('does not re-arm when the whole pipeline succeeds', async () => {
    const { redis, pipelines } = fakeRedis([
      [null, '1-1'],
      [null, 1],
      [null, 1],
      [null, 1],
    ]);

    await appendSessionEvent(redis, 'tenant-a', 'run-a', event);
    await new Promise((resolve) => setImmediate(resolve));

    expect(pipelines).toHaveLength(1);
  });
});
