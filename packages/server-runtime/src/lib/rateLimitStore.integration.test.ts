/**
 * The limiter's counters have to live in Redis, not in process memory.
 *
 * In memory the configured number is per-instance, so the real ceiling is that
 * number times however many instances happen to be running, and it resets
 * whenever one recycles — a limit nobody can reason about, and one that a
 * caller escapes simply by being routed elsewhere.
 *
 * These run against a real Redis when one is reachable, because the behaviour
 * under test *is* the shared store. Keys are unique per run and never flushed.
 */
import { describe, it, expect, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';
import {
  RATE_LIMIT_WINDOW_MS,
  isAuthenticatedRequest,
  rateLimitKey,
  rateLimitMaxForMethod,
  shouldBypassRateLimit,
} from './rateLimitPolicy.js';

const STACK_REDIS = await stackRedis(0);
const NAMESPACE = `aflow:ratelimit:test:${String(Date.now())}:`;
const clients: Redis[] = [];

async function store(): Promise<Redis> {
  const c = new Redis(STACK_REDIS.url, { enableOfflineQueue: false, lazyConnect: true });
  clients.push(c);
  // With the offline queue disabled, commands issued before the socket is up
  // fail immediately and the limiter falls open — correct in production, but
  // it would make these assertions about connection timing rather than about
  // the store.
  await c.connect();
  return c;
}

/** An app wired exactly as `buildApp` wires the limiter. */
async function appWithLimiter(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    redis: await store(),
    nameSpace: NAMESPACE,
    max: (req) =>
      rateLimitMaxForMethod(req.method, isAuthenticatedRequest(req.headers.authorization)),
    timeWindow: RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) =>
      rateLimitKey({
        authorization: req.headers.authorization,
        ip: req.ip,
        method: req.method,
      }),
    allowList: (req) => shouldBypassRateLimit(req.url),
  });
  app.get('/v1/thing', () => ({ ok: true }));
  await app.ready();
  return app;
}

const get = (app: FastifyInstance, authorization?: string) =>
  app.inject({
    method: 'GET',
    url: '/v1/thing',
    ...(authorization ? { headers: { authorization } } : {}),
  });

afterAll(() => {
  for (const c of clients) c.disconnect();
});

describe.skipIf(!STACK_REDIS.available)('rate limiter backed by Redis', () => {
  it('shares one budget across instances', async () => {
    // Two apps stand in for two Cloud Run instances behind the load balancer.
    const one = await appWithLimiter();
    const two = await appWithLimiter();
    const cred = `Bearer shared-${String(Date.now())}`;

    const first = await get(one, cred);
    const second = await get(two, cred);

    // In-memory counters would give the second instance a fresh budget; a
    // shared store continues the count.
    expect(Number(second.headers['x-ratelimit-remaining'])).toBe(
      Number(first.headers['x-ratelimit-remaining']) - 1,
    );

    await one.close();
    await two.close();
  });

  it('keeps distinct credentials in distinct buckets', async () => {
    const app = await appWithLimiter();
    const stamp = String(Date.now());

    const a = await get(app, `Bearer a-${stamp}`);
    const b = await get(app, `Bearer b-${stamp}`);

    expect(a.headers['x-ratelimit-remaining']).toBe(b.headers['x-ratelimit-remaining']);
    await app.close();
  });

  it('does not let anonymous traffic consume an authenticated budget', async () => {
    const app = await appWithLimiter();
    const cred = `Bearer untouched-${String(Date.now())}`;

    for (let i = 0; i < 10; i++) await get(app);
    const mine = await get(app, cred);

    expect(Number(mine.headers['x-ratelimit-remaining'])).toBe(
      rateLimitMaxForMethod('GET', true) - 1,
    );
    await app.close();
  });

  it('advertises the smaller ceiling to an anonymous caller', async () => {
    const app = await appWithLimiter();

    const anon = await get(app);
    const authed = await get(app, `Bearer tier-${String(Date.now())}`);

    expect(Number(anon.headers['x-ratelimit-limit'])).toBe(rateLimitMaxForMethod('GET', false));
    expect(Number(authed.headers['x-ratelimit-limit'])).toBe(rateLimitMaxForMethod('GET', true));
    expect(Number(anon.headers['x-ratelimit-limit'])).toBeLessThan(
      Number(authed.headers['x-ratelimit-limit']),
    );
    await app.close();
  });
});
