/**
 * A ref says where its bytes are, and a reader has to believe it.
 *
 * One appliance, one payload directory, every executor sharing it — and the
 * question never came up. The host lane settles it by force: that executor runs
 * on the operator's own machine and cannot mount the appliance's volume, so it
 * writes to Redis while every reader inside the appliance looks on disk. The
 * step succeeds, the bytes land, and the agent asking for the output is told it
 * expired. Since a `host.file.get` carries the revision a conditional write
 * needs, that does not just hide a result — it makes read-then-write impossible.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PayloadRef, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';

import { resolvePayloadStore } from '../resolve.js';
import { createRedisPayloadStore } from '../store.js';

/** Only the commands the Redis payload store issues. */
function fakeRedis(): { store: Map<string, string> } & Record<string, unknown> {
  const store = new Map<string, string>();
  return {
    store,
    set: (k: string, v: string) => (store.set(k, v), Promise.resolve('OK')),
    setex: (k: string, _ttl: number, v: string) => (store.set(k, v), Promise.resolve('OK')),
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    exists: (k: string) => Promise.resolve(store.has(k) ? 1 : 0),
    del: (k: string) => Promise.resolve(store.delete(k) ? 1 : 0),
    expire: () => Promise.resolve(1),
  };
}

const params = {
  tenantId: 'a0000000-0000-0000-0000-000000000001' as TenantId,
  runId: '11111111-1111-4111-8111-111111111111' as SessionId,
  stepExecutionId: '22222222-2222-4222-8222-222222222222' as StepExecutionId,
  attempt: 1,
  kind: 'output' as const,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-payload-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a filesystem-backed process reading a ref Redis wrote', () => {
  it('reads it, rather than reporting nothing found', async () => {
    const redis = fakeRedis();
    // What the host executor does, on the operator's machine.
    const written = await createRedisPayloadStore(redis as never).store({
      ...params,
      data: { path: 'hello.md', revision: 'sha256:abc', content: 'hello' },
    });
    expect(written).toContain('gs://redis-store/');

    // What the appliance does: a directory named, so the directory wins.
    const resolved = resolvePayloadStore({
      redis: redis as never,
      env: { PHOENIX_PAYLOAD_DIR: dir },
    });
    expect(resolved?.backend).toBe('file');

    const read = (await resolved?.store.retrieve(written)) as { revision?: string };
    // The revision is the whole point: without it a conditional write cannot be
    // attempted at all, which is how this presented — as a write that kept
    // insisting the file had changed since it was read.
    expect(read.revision).toBe('sha256:abc');
  });

  it('still writes to the backend this process chose', async () => {
    const redis = fakeRedis();
    const resolved = resolvePayloadStore({
      redis: redis as never,
      env: { PHOENIX_PAYLOAD_DIR: dir },
    });
    const ref = await resolved?.store.store({ ...params, data: { a: 1 } });
    // Reads follow the ref; writes never do. Durability is the operator's
    // choice, and a foreign read must not quietly relocate it.
    expect(ref).toContain('gs://file-store/');
    expect(redis.store.size).toBe(0);
  });

  it('reports a ref that genuinely is not there, without guessing why', async () => {
    const redis = fakeRedis();
    const resolved = resolvePayloadStore({
      redis: redis as never,
      env: { PHOENIX_PAYLOAD_DIR: dir },
    });
    const missing = 'gs://redis-store/tenants/x/runs/y/steps/z/attempt/1/output.json' as PayloadRef;
    await expect(resolved?.store.retrieve(missing)).rejects.toThrow();
  });
});
