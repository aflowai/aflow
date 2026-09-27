/**
 * The retention task's cycle contract.
 *
 * The property that needs guarding is that a claimed candidate is never simply
 * dropped: SPOP takes it off the set, and the arm that produced it may have been
 * the stream's last transport event, so anything that did not reach a completed
 * trim has to go back or those entries sit unreclaimed indefinitely.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { StreamKeys, resetBackgroundTaskControlPlane } from '@aflow/schemas';
import { createStreamRetentionTask } from '../streamRetention.js';

interface FakeState {
  candidates: string[];
  popped: string[];
  peeked: number;
  rearmed: string[];
  trimmed: string[];
  failOn?: string;
  /** Oldest surviving entry id per stream, for the age reading. */
  oldestById?: Record<string, string>;
}

function makeState(candidates: string[], failOn?: string): FakeState {
  const state: FakeState = {
    candidates,
    popped: [],
    peeked: 0,
    rearmed: [],
    trimmed: [],
  };
  if (failOn !== undefined) state.failOn = failOn;
  return state;
}

function fakeRedis(state: FakeState): Redis {
  return {
    spop: (key: string, count: number) => {
      expect(key).toBe(StreamKeys.retentionCandidateSet);
      const taken = state.candidates.splice(0, count);
      state.popped.push(...taken);
      return Promise.resolve(taken);
    },
    srandmember: (_key: string, count: number) => {
      state.peeked++;
      return Promise.resolve(state.candidates.slice(0, count));
    },
    sadd: (_key: string, ...members: string[]) => {
      state.rearmed.push(...members);
      return Promise.resolve(members.length);
    },
    xinfo: (_sub: string, key: string) => {
      if (key === state.failOn) return Promise.reject(new Error('boom'));
      return Promise.resolve([
        ['name', 'g', 'consumers', 1, 'pending', 0, 'last-delivered-id', '5-0'],
      ]);
    },
    xlen: () => Promise.resolve(0),
    pipeline: () => {
      let trimmedKey: string | null = null;
      const chain = {
        xtrim: (key: string) => {
          trimmedKey = key;
          return chain;
        },
        xlen: () => chain,
        xrange: () => chain,
        exec: () => {
          // XLEN and the oldest-entry read ride along with the trim, so the
          // reply shape depends on whether a trim was actually queued.
          const oldest =
            trimmedKey !== null && state.oldestById?.[trimmedKey] !== undefined
              ? [[state.oldestById[trimmedKey], ['n', '0']]]
              : [];
          const tail = [
            [null, oldest.length],
            [null, oldest],
          ];
          if (trimmedKey === null) return Promise.resolve(tail);
          state.trimmed.push(trimmedKey);
          return Promise.resolve([[null, 3], ...tail]);
        },
      };
      return chain;
    },
  } as unknown as Redis;
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.clearAllMocks();
  delete process.env['BACKGROUND_TASK_OVERRIDES'];
  resetBackgroundTaskControlPlane();
});

describe('stream retention task', () => {
  it('trims every claimed candidate and gives none back', async () => {
    const state = makeState(['aflow:jobs:ai', 'aflow:shard:3:results']);
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    expect(state.trimmed).toEqual(['aflow:jobs:ai', 'aflow:shard:3:results']);
    expect(state.rearmed).toEqual([]);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('does nothing and costs one claim when nothing is armed', async () => {
    const state = makeState([]);
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    expect(result.candidates).toBe(0);
    expect(state.trimmed).toEqual([]);
  });

  it('re-arms a candidate whose trim threw, instead of dropping it', async () => {
    const state = makeState(
      ['aflow:jobs:ai', 'aflow:jobs:broken', 'aflow:jobs:api'],
      'aflow:jobs:broken',
    );
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    // The healthy streams are still trimmed; the failure goes back on the set so
    // a later cycle retries it even if that stream never sees traffic again.
    expect(state.trimmed).toEqual(['aflow:jobs:ai', 'aflow:jobs:api']);
    expect(state.rearmed).toEqual(['aflow:jobs:broken']);
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not claim more work while candidates are still owed back', async () => {
    const state = makeState(['aflow:jobs:broken'], 'aflow:jobs:broken');
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    expect(result.hasMore).toBe(false);
  });

  it('reports more work when the claim filled the batch', async () => {
    const state = makeState(Array.from({ length: 200 }, (_, i) => `aflow:jobs:s${i}`));
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    expect(result.hasMore).toBe(true);
    expect(state.candidates.length).toBeGreaterThan(0);
  });

  it('observes without consuming the candidate set or trimming', async () => {
    process.env['BACKGROUND_TASK_OVERRIDES'] = JSON.stringify({
      'orchestrator.stream_retention': { mode: 'observe' },
    });
    resetBackgroundTaskControlPlane();

    const state = makeState(['aflow:jobs:ai', 'aflow:shard:3:results']);
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    expect(state.peeked).toBe(1);
    expect(state.popped).toEqual([]);
    expect(state.rearmed).toEqual([]);
    expect(state.trimmed).toEqual([]);
    expect(state.candidates).toHaveLength(2);
    expect(result.candidates).toBe(2);
  });

  it('names the stream holding the oldest entry, so the family-level metric does not have to', async () => {
    const hourOld = Date.now() - 3_600_000;
    const state = makeState(['aflow:jobs:ai', 'aflow:jobs:stuck']);
    state.oldestById = {
      'aflow:jobs:ai': `${Date.now() - 1_000}-0`,
      'aflow:jobs:stuck': `${hourOld}-0`,
    };
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    await task.runOnce();

    const summary = logger.info.mock.calls.find(
      (call) => call[0] === '[stream-retention] reclaimed acked entries',
    );
    expect(summary).toBeDefined();
    const data = summary?.[1] as Record<string, unknown>;
    expect(data['oldestHeldStream']).toBe('aflow:jobs:stuck');
    expect(data['oldestHeldAgeMs']).toBeGreaterThanOrEqual(3_600_000);
  });

  it('never asks to re-arm immediately while observing', async () => {
    process.env['BACKGROUND_TASK_OVERRIDES'] = JSON.stringify({
      'orchestrator.stream_retention': { mode: 'observe' },
    });
    resetBackgroundTaskControlPlane();

    // A full batch is the steady state when peeking, so reporting more work
    // would re-arm the cycle immediately and spin.
    const state = makeState(Array.from({ length: 200 }, (_, i) => `aflow:jobs:s${i}`));
    const task = createStreamRetentionTask({ redis: fakeRedis(state), logger });

    const result = await task.runOnce();

    expect(result.hasMore).toBe(false);
  });
});
