/**
 * Webhook ingest is public and unauthenticated: the HMAC is the whole
 * authorization, and a signature only proves a body was authentic once. What
 * stops it being replayed forever is freshness the sender actually signed, so
 * the timestamp is treated as part of the credential rather than as an
 * optional protocol nicety.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createHmac } from 'node:crypto';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const ENDPOINT = '00000000-0000-4000-8000-0000000000ee';
const SECRET = 'shhh-not-a-real-secret';
const REPLAY_WINDOW_SECONDS = 300;

const endpointRow = {
  id: ENDPOINT,
  status: 'active',
  secretEncrypted: 'enc',
  signatureHeader: 'x-signature',
  timestampHeader: 'x-timestamp',
  deliveryIdHeader: 'x-delivery-id',
  requireDeliveryId: false,
  replayWindowSeconds: REPLAY_WINDOW_SECONDS,
  filterExpression: 'false',
  inputMapping: null,
};

/** Spies, so the "no store" path can be asserted to touch neither. */
const dbSpies = vi.hoisted(() => ({
  selectEndpoint: vi.fn(() => Promise.resolve([endpointRow])),
  decrypt: vi.fn(() => Promise.resolve(SECRET)),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: () => ({}),
  createTenantContext: () => ({}),
  tenantIdToSchemaName: (t: string) => `t_${t.replace(/-/g, '')}`,
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: () => dbSpies.selectEndpoint() }) }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    }),
  webhookEndpoints: {},
  decryptCredentialAsync: () => dbSpies.decrypt(),
}));

vi.mock('../services/sessions.js', () => ({
  createSessionService: () => ({
    startSession: () => Promise.resolve({ sessionId: 'sess-1', runId: 'run-1' }),
  }),
}));

vi.mock('../lib/jsonata-utils.js', () => ({
  evaluateFilter: () => Promise.resolve(false),
  applyMapping: (_m: unknown, b: unknown) => Promise.resolve(b),
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

interface FakeRedis {
  set: (k: string, v: string, ex: string, ttl: number, mode: string) => Promise<'OK' | null>;
  incr: () => Promise<number>;
  expire: () => Promise<number>;
  /** TTL each dedup key was stored with, so the derived lifetime is assertable. */
  dedupTtls: number[];
}

/** Only what the route touches: SET NX for dedup, INCR/EXPIRE for the rate limit. */
function fakeRedis(): FakeRedis {
  const keys = new Set<string>();
  const dedupTtls: number[] = [];
  return {
    set: (k, _v, _ex, ttl, mode) => {
      if (k.includes(':dedup:')) dedupTtls.push(ttl);
      return Promise.resolve(mode === 'NX' && keys.has(k) ? null : (keys.add(k), 'OK'));
    },
    incr: () => Promise.resolve(1),
    expire: () => Promise.resolve(1),
    dedupTtls,
  };
}

async function buildApp(redis: unknown): Promise<FastifyInstance> {
  const { webhookIngestRoutes } = await import('./webhook-ingest.js');
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Mirrors the shared parser the rest of the API uses, so the plugin-scoped
  // override is exercised against a realistic parent rather than the default.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  (app as unknown as { appContext: unknown }).appContext = { redis, db: {} };
  await app.register(webhookIngestRoutes, { prefix: '/webhooks/ingest' });
  await app.ready();
  return app;
}

/** A body whose bytes deliberately differ from `JSON.stringify` of its parse. */
const RAW = '{ "event" : "ping",  "n" : 1 }';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The material the route verifies: the timestamp as sent, then the bytes as sent. */
const sign = (ts: string, raw = RAW): string =>
  createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');

function post(
  app: FastifyInstance,
  headers: Record<string, string>,
  payload = RAW,
): Promise<{ statusCode: number; body: string }> {
  return app
    .inject({
      method: 'POST',
      url: `/webhooks/ingest/${TENANT}/${ENDPOINT}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    })
    .then((r) => ({ statusCode: r.statusCode, body: r.body }));
}

/** A well-formed, freshly signed delivery. */
function fresh(extra: Record<string, string> = {}): Record<string, string> {
  const ts = String(nowSeconds());
  return { 'x-signature': sign(ts), 'x-timestamp': ts, ...extra };
}

describe('webhook ingest — replay defence', () => {
  let app: FastifyInstance;
  let redis: FakeRedis;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    redis = fakeRedis();
    app = await buildApp(redis);
  });

  /**
   * The signature is computed over the transmitted bytes. Re-serializing our
   * parse of them yields `{"event":"ping","n":1}` — different bytes, different
   * HMAC — so this passing is what proves we verify what was actually sent.
   */
  it('verifies the signature over the bytes as received, not a re-serialization', async () => {
    const res = await post(app, fresh());
    expect(res.statusCode).not.toBe(401);
    expect(res.body).toMatch(/filtered/);
  });

  /**
   * The heart of it: freshness is only a control if the sender signed it. The
   * pair is the assertion — the same bytes under the same signature are
   * accepted at the timestamp they were issued for and refused at any other,
   * so restamping a captured delivery cannot buy it a fresh window.
   */
  it('binds a signature to the timestamp it was issued for', async () => {
    const issued = String(nowSeconds() - 60);
    const signature = sign(issued);

    const honest = await post(app, { 'x-signature': signature, 'x-timestamp': issued });
    const restamped = await post(app, {
      'x-signature': signature,
      'x-timestamp': String(nowSeconds()),
    });

    expect(honest.body).toMatch(/filtered/);
    expect(restamped.statusCode).toBe(401);
  });

  it('refuses a delivery that carries no timestamp to sign', async () => {
    const ts = String(nowSeconds());
    const res = await post(app, { 'x-signature': sign(ts) });

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatch(/timestamp/i);
  });

  /**
   * Freshness is checked against material that verified, so a correctly signed
   * but aged delivery is the case that reaches it.
   */
  it('refuses a correctly signed delivery from outside the replay window', async () => {
    const ts = String(nowSeconds() - (REPLAY_WINDOW_SECONDS + 60));
    const res = await post(app, { 'x-signature': sign(ts), 'x-timestamp': ts });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/replay window/i);
  });

  it('refuses a correctly signed delivery stamped far in the future', async () => {
    const ts = String(nowSeconds() + (REPLAY_WINDOW_SECONDS + 60));
    const res = await post(app, { 'x-signature': sign(ts), 'x-timestamp': ts });

    expect(res.statusCode).toBe(400);
  });

  /**
   * Asserted against a delivery the filter drops, because dedup runs before the
   * filter: reaching `filtered` proves the key was stored without needing a
   * session to be started.
   */
  it('treats a resent delivery as a duplicate rather than a new one', async () => {
    const headers = fresh();

    const first = await post(app, headers);
    const second = await post(app, headers);

    expect(first.body).toMatch(/filtered/);
    expect(second.body).toMatch(/duplicate/);
  });

  /**
   * Replay defence and deduplication are different jobs, and only one of them
   * is this endpoint's to do without being asked.
   *
   * A replay is the same bytes AND the same timestamp, so it signs identically
   * and the signature key catches it. Two genuine deliveries that happen to
   * carry the same body a second apart sign differently, and collapsing those
   * would answer 200 to a delivery that never ran — the sender is told it
   * succeeded and does not retry. A sender that wants them collapsed says so
   * with an id.
   */
  it('admits a second delivery of the same body under a new timestamp', async () => {
    const first = await post(app, fresh());
    const later = String(nowSeconds() + 1);
    const second = await post(app, { 'x-signature': sign(later), 'x-timestamp': later });

    expect(first.body).toMatch(/filtered/);
    expect(second.body).toMatch(/filtered/);
  });

  it('still refuses the exact bytes replayed under their own timestamp', async () => {
    const headers = fresh();
    const first = await post(app, headers);
    const replayed = await post(app, headers);

    expect(first.body).toMatch(/filtered/);
    expect(replayed.body).toMatch(/duplicate/);
  });

  /**
   * The id header is outside the signature, so an attacker can add or remove it
   * freely. If it selected the dedup key, stripping it would move a captured
   * delivery into a namespace the original never wrote and let it back in.
   */
  it('treats a replay with the delivery id stripped as a duplicate', async () => {
    const headers = fresh({ 'x-delivery-id': 'evt_1' });
    const first = await post(app, headers);

    const { 'x-delivery-id': _dropped, ...withoutId } = headers;
    const replayed = await post(app, withoutId);

    expect(first.body).toMatch(/filtered/);
    expect(replayed.body).toMatch(/duplicate/);
  });

  /**
   * The delivery-id header is sender-chosen and outside the signature, so
   * keying dedup on it alone lets a captured delivery back in under an id the
   * attacker picked.
   */
  it('treats a replay under a fresh delivery id as a duplicate', async () => {
    const headers = fresh({ 'x-delivery-id': 'evt_1' });

    const first = await post(app, headers);
    const replayed = await post(app, { ...headers, 'x-delivery-id': 'evt_2' });

    expect(first.body).toMatch(/filtered/);
    expect(replayed.body).toMatch(/duplicate/);
  });

  /**
   * An honest redelivery restates its timestamp, so it is a different
   * signature over the same event. The id the sender chose is the only thing
   * that says the two are one delivery.
   */
  it('treats a redelivery under the same id as a duplicate despite a new signature', async () => {
    const id = 'evt_1';
    const first = await post(app, fresh({ 'x-delivery-id': id }));

    const later = String(nowSeconds() + 1);
    const second = await post(app, {
      'x-signature': sign(later),
      'x-timestamp': later,
      'x-delivery-id': id,
    });

    expect(first.body).toMatch(/filtered/);
    expect(second.body).toMatch(/duplicate/);
  });

  it('refuses a delivery with no id when the endpoint requires one', async () => {
    endpointRow.requireDeliveryId = true;
    try {
      const res = await post(app, fresh());
      expect(res.statusCode).toBe(400);
    } finally {
      endpointRow.requireDeliveryId = false;
    }
  });

  /**
   * A delivery verifies anywhere in `[ts - window, ts + window]`, so a dedup
   * record shorter than twice the window leaves a span in which a replay is
   * both fresh enough to verify and forgotten.
   */
  it('remembers a delivery for as long as the replay window could still admit it', async () => {
    await post(app, fresh());

    expect(redis.dedupTtls.length).toBeGreaterThan(0);
    for (const ttl of redis.dedupTtls) {
      expect(ttl).toBe(REPLAY_WINDOW_SECONDS * 2);
    }
  });

  /**
   * Rate limiting and dedup share one store, and both are controls rather than
   * optimisations — so losing it refuses rather than letting one of them
   * silently lapse. Refused before the tenant read and the credential decrypt,
   * because a caller who has proven nothing should not be able to spend them.
   */
  it('refuses, without doing tenant work, when the counter store is gone', async () => {
    const noRedis = await buildApp(undefined);

    const res = await post(noRedis, fresh());

    expect(res.statusCode).toBe(503);
    expect(dbSpies.selectEndpoint).not.toHaveBeenCalled();
    expect(dbSpies.decrypt).not.toHaveBeenCalled();
  });

  it('still rejects a bad signature', async () => {
    const res = await post(app, { ...fresh(), 'x-signature': 'a'.repeat(64) });
    expect(res.statusCode).toBe(401);
  });
});
