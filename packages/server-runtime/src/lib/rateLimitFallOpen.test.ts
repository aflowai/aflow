/**
 * A Redis outage must cost the limiter its counters, not the API its traffic.
 *
 * The limiter's connection runs with the offline queue disabled so a command
 * issued against a dead socket fails at once instead of stalling the request.
 * That only degrades to *allowing* traffic if the plugin is also told to skip
 * a failing store: left at its default it rethrows, and every route the
 * limiter guards answers 500 for as long as Redis is away.
 */
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { buildRateLimitOptions } from './rateLimitPolicy.js';

/** A store that fails the way an unreachable Redis fails. */
class UnreachableStore {
  child(): UnreachableStore {
    return this;
  }
  incr(_key: string, cb: (err: Error | null) => void): void {
    cb(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
  }
}

async function appWithFailingStore() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    ...buildRateLimitOptions({ clientIp: (req) => req.ip }),
    store: UnreachableStore as never,
  });
  app.get('/v1/spaces/:spaceId/action-center', () => ({ ok: true }));
  return app;
}

describe('rate limiter with an unreachable store', () => {
  it('serves the request instead of failing it', async () => {
    const app = await appWithFailingStore();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/spaces/abc/action-center',
        headers: { authorization: 'Bearer token' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('is wired to skip store errors', () => {
    expect(buildRateLimitOptions({ clientIp: (req) => req.ip }).skipOnError).toBe(true);
  });
});
