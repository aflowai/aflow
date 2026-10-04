/**
 * The live streaming buffer's contract is byte-offset cursoring over APPEND +
 * GETRANGE. ioredis-mock's string commands do not reproduce real offset
 * semantics closely enough to trust a green run, so this exercises a live
 * Redis when one is reachable and skips otherwise.
 *
 * Keys are unique per run and deleted afterwards — never `flushdb`, which
 * would take out a developer's whole local stack.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';

/**
 * Its own database. Writing session state on db 0 puts entries into the shared
 * candidate indexes a live dev orchestrator is draining, and it then retries a
 * synthetic tenant forever.
 */
const TEST_DB = 11;
import { StreamKeys } from '@aflow/schemas';
import { appendLiveDelta, readLiveDeltaFrom, clearLiveBuffers } from '../index.js';

const TENANT = 'tenant-live-stream-test';
const SESSION = '00000000-0000-0000-0000-00000000live';
const STEP = '00000000-0000-0000-0000-0000000005+e';

const STACK_REDIS = await stackRedis(TEST_DB);

function client(): RedisType {
  return new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
}

describe.skipIf(!STACK_REDIS.available)('live stream buffer', () => {
  let redis: RedisType | null = null;

  afterEach(async () => {
    if (redis) {
      await clearLiveBuffers(redis, TENANT, STEP);
      redis.disconnect();
      redis = null;
    }
  });

  it('appends with no session to publish to, and the buffer reads the same', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    // A step a workflow dispatched names no session; the wake is published
    // downstream once the run's watchers are known.
    await appendLiveDelta(redis, TENANT, null, STEP, 'activity', 'one line\n');
    expect(await readLiveDeltaFrom(redis, TENANT, STEP, 'activity', 0)).toEqual({
      delta: 'one line\n',
      offset: 9,
      startOffset: 0,
    });
  });

  it('returns only what is new since the caller offset', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'Hello');
    const first = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0);
    expect(first.delta).toBe('Hello');
    expect(first.offset).toBe(5);

    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', ', world');
    const second = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', first.offset);
    expect(second.delta).toBe(', world');
    expect(second.offset).toBe(12);

    // Caught up: nothing new, and the offset must not drift.
    const third = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', second.offset);
    expect(third.delta).toBe('');
    expect(third.offset).toBe(second.offset);
  });

  it('gives a late reader the whole partial in one read', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    for (const chunk of ['alpha ', 'beta ', 'gamma']) {
      await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', chunk);
    }

    const late = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0);
    expect(late.delta).toBe('alpha beta gamma');
    expect(late.offset).toBe(16);
  });

  it('keeps text and thinking in separate keys', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'answer');
    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'thinking', 'reasoning');

    const text = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0);
    const thinking = await readLiveDeltaFrom(redis, TENANT, STEP, 'thinking', 0);
    expect(text.delta).toBe('answer');
    expect(thinking.delta).toBe('reasoning');

    // Separate keys is what makes "a visitor may read text but never thinking"
    // expressible as a subscription rather than a per-frame filter.
    expect(StreamKeys.liveStreamBuffer(TENANT, STEP, 'text')).not.toBe(
      StreamKeys.liveStreamBuffer(TENANT, STEP, 'thinking'),
    );
  });

  it('reads empty for a step that never streamed', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    const read = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0);
    expect(read.delta).toBe('');
    expect(read.offset).toBe(0);
  });

  it('clears both channels together', async () => {
    redis = client();
    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'answer');
    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'thinking', 'reasoning');

    await clearLiveBuffers(redis, TENANT, STEP);

    expect((await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0)).delta).toBe('');
    expect((await readLiveDeltaFrom(redis, TENANT, STEP, 'thinking', 0)).delta).toBe('');
  });

  it('sets a TTL so an abandoned step cannot leak its buffer', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'partial');
    const ttl = await redis.ttl(StreamKeys.liveStreamBuffer(TENANT, STEP, 'text'));
    expect(ttl).toBeGreaterThan(0);
  });

  it('signals a restart when a retry reuses the step after the buffer was cleared', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    // Attempt 1 streams, then fails retryably — the terminal clears the buffer.
    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'attempt one output');
    const attempt1 = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0);
    expect(attempt1.startOffset).toBe(0);
    const heldOffset = attempt1.offset;
    await clearLiveBuffers(redis, TENANT, STEP);

    // The retry reuses the same stepExecutionId and streams a shorter answer.
    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'retry');
    const restart = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', heldOffset);
    // The buffer is shorter than the held offset → read from 0 and replace.
    expect(restart.delta).toBe('retry');
    expect(restart.startOffset).toBe(0);
    expect(restart.offset).toBe(Buffer.byteLength('retry'));
  });

  it('cursors by bytes, not characters, so multi-byte text resumes correctly', async () => {
    redis = client();
    await clearLiveBuffers(redis, TENANT, STEP);

    // GETRANGE offsets are byte offsets; a cursor counted in JS string length
    // would land mid-sequence and corrupt the resumed text.
    const first = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', 0);
    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', 'héllo');
    const read = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', first.offset);
    expect(read.delta).toBe('héllo');
    expect(read.offset).toBe(Buffer.byteLength('héllo'));

    await appendLiveDelta(redis, TENANT, SESSION, STEP, 'text', ' wörld');
    const next = await readLiveDeltaFrom(redis, TENANT, STEP, 'text', read.offset);
    expect(next.delta).toBe(' wörld');
  });
});
