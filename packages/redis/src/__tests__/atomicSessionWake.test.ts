/**
 * A durable session event and the wake that announces it must land together.
 *
 * Published after the transaction, the wake can be lost on its own — the event
 * is durable and no connected subscriber is ever told about it, so it surfaces
 * only on the next periodic re-read. That periodic re-read is what Plan 295
 * removes, which is what makes this invariant load-bearing rather than
 * belt-and-braces.
 *
 * A pipeline is not enough here: it batches round trips but still lets a
 * connection drop between the XADD and the PUBLISH. These tests assert the
 * publish is *in the transaction*, which is the only thing that closes it.
 */
import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import { appendSessionEvent } from '../hotState/events.js';
import { atomicCreateSession, atomicCompleteStep, atomicScheduleStep } from '../hotState/atomic.js';
import type { SessionHotState, StepHotState } from '../hotState/schemas.js';
import type { SessionEvent } from '../hotState/schemas.js';

interface Recorded {
  kind: 'multi' | 'pipeline';
  commands: string[];
}

function fakeRedis(): { redis: Redis; batches: Recorded[]; looseCommands: string[] } {
  const batches: Recorded[] = [];
  const looseCommands: string[] = [];

  const makeBatch = (kind: 'multi' | 'pipeline'): unknown => {
    const commands: string[] = [];
    batches.push({ kind, commands });
    const p: Record<string, unknown> = {};
    const record = (cmd: string) => {
      p[cmd] = (): unknown => {
        commands.push(cmd);
        return p;
      };
    };
    for (const cmd of [
      'xadd',
      'expire',
      'hset',
      'hdel',
      'del',
      'zincrby',
      'zadd',
      'zrem',
      'sadd',
      'srem',
      'publish',
      'set',
      'incr',
    ]) {
      record(cmd);
    }
    p['exec'] = async (): Promise<Array<[Error | null, unknown]>> =>
      commands.map(() => [null, '1-0'] as [Error | null, unknown]);
    return p;
  };

  const redis = new Proxy(
    {
      multi: () => makeBatch('multi'),
      pipeline: () => makeBatch('pipeline'),
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // Any direct command is a write issued OUTSIDE a batch.
        return async (...__args: unknown[]): Promise<unknown> => {
          looseCommands.push(prop);
          return 1;
        };
      },
    },
  ) as unknown as Redis;

  return { redis, batches, looseCommands };
}

const TENANT = 'tenant-1';
const SESSION = '00000000-0000-4000-8000-000000000001';

function event(id: string): SessionEvent {
  return {
    eventId: id,
    eventType: 'StepSucceeded',
    timestamp: 1_700_000_000_000,
    sessionId: SESSION,
  } as SessionEvent;
}

/** The batch that carried the stream append. */
function appendBatch(batches: Recorded[]): Recorded {
  const found = batches.find((b) => b.commands.includes('xadd'));
  if (!found) throw new Error('no batch appended to the stream');
  return found;
}

describe('the session wake rides the append transaction', () => {
  it('appendSessionEvent publishes inside the transaction', async () => {
    const { redis, batches, looseCommands } = fakeRedis();
    await appendSessionEvent(redis, TENANT, SESSION, event('e-1'));

    const batch = appendBatch(batches);
    expect(batch.kind).toBe('multi');
    expect(batch.commands).toContain('publish');
    // Nothing published on its own afterwards.
    expect(looseCommands).not.toContain('publish');
  });

  it('atomicCreateSession publishes inside the transaction', async () => {
    const { redis, batches, looseCommands } = fakeRedis();
    await atomicCreateSession(
      redis,
      { tenantId: TENANT, sessionId: SESSION } as SessionHotState,
      { tenantId: TENANT, stepExecutionId: 'step-1' } as StepHotState,
      event('e-0'),
      event('e-0b'),
    );

    const batch = appendBatch(batches);
    expect(batch.kind).toBe('multi');
    expect(batch.commands).toContain('publish');
    expect(looseCommands).not.toContain('publish');
  });

  it('atomicScheduleStep publishes inside the transaction', async () => {
    const { redis, batches, looseCommands } = fakeRedis();
    await atomicScheduleStep(
      redis,
      TENANT,
      SESSION,
      { stepExecutionId: 'step-1' },
      { sessionId: SESSION },
      event('e-2'),
    );

    const batch = appendBatch(batches);
    expect(batch.kind).toBe('multi');
    expect(batch.commands).toContain('publish');
    expect(looseCommands).not.toContain('publish');
  });

  it('atomicCompleteStep publishes inside the transaction', async () => {
    const { redis, batches, looseCommands } = fakeRedis();
    await atomicCompleteStep(
      redis,
      TENANT,
      { stepExecutionId: 'step-1' },
      { sessionId: SESSION },
      event('e-3'),
    );

    const batch = appendBatch(batches);
    expect(batch.kind).toBe('multi');
    expect(batch.commands).toContain('publish');
    expect(looseCommands).not.toContain('publish');
  });
});
