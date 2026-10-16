/**
 * A conversation list reads each session's status from its hot state where the
 * hash still exists, so a list that says whether a conversation is mid-turn is
 * not a projection cycle late to it (Plan 315 F75). One round trip for the
 * page, one field per session, and nothing it cannot read changes what the
 * projected row says.
 */
import { describe, expect, it } from 'vitest';
import { StreamKeys } from '@aflow/schemas';

import { readHotSessionStatuses } from '../sessions.js';

const TENANT = 'tenant-1';

function fakeRedis(fields: Record<string, string | null>) {
  const reads: string[] = [];
  let execs = 0;
  return {
    reads,
    execs: () => execs,
    redis: {
      pipeline() {
        const results: Array<[Error | null, unknown]> = [];
        const chain = {
          hget(key: string, field: string) {
            reads.push(`${key}#${field}`);
            results.push([null, fields[key] ?? null]);
            return chain;
          },
          exec() {
            execs += 1;
            return Promise.resolve(results);
          },
        };
        return chain;
      },
    },
  };
}

describe('the hot status of listed sessions', () => {
  it('reads every listed session in one round trip', async () => {
    const { redis, reads, execs } = fakeRedis({
      [StreamKeys.sessionStateKey(TENANT, 'a')]: 'RUNNING',
      [StreamKeys.sessionStateKey(TENANT, 'b')]: 'PAUSED',
    });

    const statuses = await readHotSessionStatuses(redis as never, TENANT, ['a', 'b', 'c']);

    expect(execs()).toBe(1);
    expect(reads).toEqual([
      `${StreamKeys.sessionStateKey(TENANT, 'a')}#status`,
      `${StreamKeys.sessionStateKey(TENANT, 'b')}#status`,
      `${StreamKeys.sessionStateKey(TENANT, 'c')}#status`,
    ]);
    // `c` has no hash any more: its projected row is the truth for it.
    expect([...statuses]).toEqual([
      ['a', 'RUNNING'],
      ['b', 'PAUSED'],
    ]);
  });

  it('leaves out a value that is not a status', async () => {
    const { redis } = fakeRedis({ [StreamKeys.sessionStateKey(TENANT, 'a')]: 'HALF_DONE' });
    expect((await readHotSessionStatuses(redis as never, TENANT, ['a'])).size).toBe(0);
  });

  it('costs nothing for an empty page', async () => {
    const { redis, execs } = fakeRedis({});
    expect((await readHotSessionStatuses(redis as never, TENANT, [])).size).toBe(0);
    expect(execs()).toBe(0);
  });
});
