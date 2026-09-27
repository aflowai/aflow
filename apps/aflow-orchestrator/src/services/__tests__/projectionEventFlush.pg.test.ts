/**
 * No durable event the stream still holds may fail to reach event_log.
 *
 * The old flush read from cursor '0' with a fixed count against a stream
 * trimmed at MAXLEN ~1000 — head loss for runs that outlived the cap while
 * RUNNING, tail loss at terminal flush when the stream sat above the count.
 * The incremental flush pages from a per-session cursor stored on the session
 * row and advanced in the same transaction as the inserts it accounts for.
 *
 * Real Redis and real Postgres: MAXLEN '~' trimming is approximate on the
 * server and exact nowhere else, and the cursor's atomicity claim is a
 * transaction boundary — neither is observable through a mock.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { StreamKeys, type TenantId } from '@aflow/schemas';
import { createDatabase, tenantIdToSchemaName, PROJECTION_FAILURES_TABLE } from '@aflow/database';
import { setSessionState, appendSessionEvent, type SessionHotState } from '@aflow/redis';
const logs = vi.hoisted(() => ({ info: [] as string[], error: [] as string[] }));
vi.mock('../../lib/orchestratorLogger.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/orchestratorLogger.js');
  const sink = {
    info: (message: string) => logs.info.push(message),
    warn: () => undefined,
    debug: () => undefined,
    error: (message: string) => logs.error.push(message),
  };
  return { ...actual, getOrchestratorLogger: () => ({ ...sink, child: () => sink }) };
});

import { createProjectionWorker } from '../ProjectionWorker.js';

const DATABASE_URL = process.env['DATABASE_URL'];
/** Its own database: a claim takes everything due, including a dev orchestrator's. */
const REDIS_DB = 10;

const SOURCE_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SOURCE_SCHEMA = tenantIdToSchemaName(SOURCE_TENANT);
const TENANT = 'd1d10000-0000-4000-8000-000000000921' as TenantId;
const SCHEMA = tenantIdToSchemaName(TENANT);

let handle: { sql: postgres.Sql; close: () => Promise<void> } | undefined;

async function substrateReady(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const probe = new Redis({
    host: '127.0.0.1',
    port: 6379,
    db: REDIS_DB,
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
  handle = createDatabase({ connectionString: DATABASE_URL });
  try {
    // Gated on the base schema only, never on the artifact under test: a gate
    // that requires the cursor column reports "skipped" instead of "failed"
    // when the migration is reverted, which is the silent-skip failure this
    // repo has already been bitten by.
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT to_regclass(${`${SOURCE_SCHEMA}.event_log`}) IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

const READY = await substrateReady();

describe.skipIf(!READY)('projection event flush', () => {
  const sql = (): postgres.Sql => handle!.sql;
  let redis: RedisType;

  function worker() {
    return createProjectionWorker(
      { redis, db: drizzle(sql()), sqlClient: sql() },
      { batchSize: 50 },
    );
  }

  function hotState(runId: string, status = 'RUNNING'): SessionHotState {
    return {
      tenantId: TENANT,
      sessionId: runId,
      target: { kind: 'platform-role', systemRole: 'helmsman' },
      agentVersion: '1',
      status,
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    } as unknown as SessionHotState;
  }

  async function appendEvents(runId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await appendSessionEvent(redis, TENANT, runId, {
        eventId: randomUUID(),
        eventType: 'StepSucceeded',
        timestamp: Date.now(),
        sessionId: runId,
      });
    }
  }

  async function eventLogCount(runId: string): Promise<number> {
    const rows = await sql().unsafe<Array<{ n: string }>>(
      `SELECT count(*)::text AS n FROM "${SCHEMA}".event_log WHERE session_id = $1::uuid`,
      [runId],
    );
    return Number(rows[0]?.n ?? '0');
  }

  async function cursorOf(runId: string): Promise<string | null> {
    const rows = await sql().unsafe<Array<{ cursor: string | null }>>(
      `SELECT last_flushed_event_stream_id AS cursor
         FROM "${SCHEMA}".sessions WHERE session_id = $1::uuid`,
      [runId],
    );
    return rows[0]?.cursor ?? null;
  }

  async function streamLength(runId: string): Promise<number> {
    return redis.xlen(StreamKeys.sessionEventsStream(TENANT, runId));
  }

  async function lastStreamId(runId: string): Promise<string | null> {
    const rows = await redis.xrevrange(
      StreamKeys.sessionEventsStream(TENANT, runId),
      '+',
      '-',
      'COUNT',
      1,
    );
    return rows[0]?.[0] ?? null;
  }

  async function stillACandidate(runId: string): Promise<boolean> {
    const score = await redis.zscore(StreamKeys.projectionCandidatesKey, `${TENANT}:${runId}`);
    return score !== null;
  }

  beforeAll(async () => {
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql().unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await sql().unsafe(
      `CREATE TABLE "${SCHEMA}".sessions (LIKE "${SOURCE_SCHEMA}".sessions INCLUDING ALL)`,
    );
    await sql().unsafe(
      `CREATE TABLE "${SCHEMA}".event_log (LIKE "${SOURCE_SCHEMA}".event_log INCLUDING ALL)`,
    );
    // LIKE copies no foreign keys; production event_log carries this one, and
    // the drain-failure behavior under test only exists because of it.
    await sql().unsafe(
      `ALTER TABLE "${SCHEMA}".event_log
         ADD FOREIGN KEY (session_id) REFERENCES "${SCHEMA}".sessions(session_id)`,
    );
  });

  afterAll(async () => {
    if (!handle) return;
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql().unsafe(`DELETE FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = $1::uuid`, [
      TENANT,
    ]);
    redis.disconnect();
    await handle.close();
  });

  beforeEach(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379, db: REDIS_DB, maxRetriesPerRequest: 1 });
    // Scoped deletes, never flushdb: the instance is shared, and vitest is
    // known to collect sibling worktrees' suites onto the same databases.
    const mine = await redis.keys(`aflow:*${TENANT}*`);
    const indexKeys = [
      'aflow:projection:candidates',
      'aflow:projection:order',
      'aflow:projection:leases',
    ];
    if (mine.length > 0) await redis.del(...mine);
    for (const key of indexKeys) {
      const members = await redis.zrange(key, 0, -1);
      const ours = members.filter((m) => m.startsWith(`${TENANT}:`));
      if (ours.length > 0) await redis.zrem(key, ...ours);
    }
    await sql().unsafe(`TRUNCATE "${SCHEMA}".event_log, "${SCHEMA}".sessions CASCADE`);
    await sql().unsafe(`DELETE FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = $1::uuid`, [
      TENANT,
    ]);
  });

  it("persists a running session's events and advances the cursor", async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId));
    await appendEvents(runId, 5);

    const stats = await worker().runOnce();

    expect(stats.statusUpdatedCount).toBe(1);
    expect(stats.errorCount).toBe(0);
    expect(await eventLogCount(runId)).toBe(5);
    expect(await cursorOf(runId)).toBe(await lastStreamId(runId));
    expect(await stillACandidate(runId)).toBe(false);
  });

  it('keeps events durable after the stream evicts them', async () => {
    // The loss this closes: a run RUNNING past the stream cap used to lose its
    // head, because nothing flushed events before the terminal projection.
    // With the mechanism reverted, event_log can never exceed what the stream
    // still holds — the assertion below measures the difference.
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId));
    await appendEvents(runId, 600);
    await worker().runOnce();
    expect(await eventLogCount(runId)).toBe(600);

    // The appends alone must re-arm and re-drive the flush: fan-out sessions
    // receive events with no accompanying state mutation.
    await appendEvents(runId, 700);
    expect(await streamLength(runId)).toBeLessThan(1300);
    await worker().runOnce();

    expect(await eventLogCount(runId)).toBe(1300);
  });

  it('a terminal flush persists the whole stream, not the first 1000', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId));
    let appended = 1080;
    await appendEvents(runId, appended);
    // MAXLEN '~' trims whole macro-nodes, so the length oscillates in a band
    // above the cap; push until it is measurably past the old fixed count.
    while ((await streamLength(runId)) <= 1000) {
      await appendEvents(runId, 10);
      appended += 10;
    }
    const lengthAtFlush = await streamLength(runId);

    await setSessionState(redis, hotState(runId, 'SUCCEEDED'));
    const stats = await worker().runOnce();

    expect(stats.flushedCount).toBe(1);
    expect(stats.errorCount).toBe(0);
    // Everything still held is persisted — beyond the old 1000-count cap...
    expect(lengthAtFlush).toBeGreaterThan(1000);
    expect(await eventLogCount(runId)).toBe(lengthAtFlush);
    // ...and nothing already evicted is claimed back: the head that fell out
    // before the first flush ever ran is honestly gone.
    expect(lengthAtFlush).toBeLessThan(appended);
    expect(await cursorOf(runId)).toBe(await lastStreamId(runId));
  });

  it('leaves the candidate armed and the cursor unmoved when the insert fails', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId));
    await appendEvents(runId, 3);

    await sql().unsafe(`ALTER TABLE "${SCHEMA}".event_log RENAME TO event_log_hidden`);
    try {
      const stats = await worker().runOnce();
      expect(stats.errorCount).toBe(1);
      expect(await stillACandidate(runId)).toBe(true);
      // The transaction rolled back whole: no session row, so no cursor.
      expect(await cursorOf(runId)).toBeNull();
    } finally {
      await sql().unsafe(`ALTER TABLE "${SCHEMA}".event_log_hidden RENAME TO event_log`);
    }

    await redis.zrem(StreamKeys.projectionLeasesKey, `${TENANT}:${runId}`);
    const stats = await worker().runOnce();

    expect(stats.errorCount).toBe(0);
    expect(await eventLogCount(runId)).toBe(3);
    expect(await cursorOf(runId)).toBe(await lastStreamId(runId));
  });

  it('re-flushing a paused session reads only the tail and stays idempotent', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId, 'PAUSED'));
    await appendEvents(runId, 8);
    await worker().runOnce();
    const cursorAfterFirst = await cursorOf(runId);
    expect(await eventLogCount(runId)).toBe(8);

    await appendEvents(runId, 2);
    await worker().runOnce();

    expect(await eventLogCount(runId)).toBe(10);
    expect(await cursorOf(runId)).not.toBe(cursorAfterFirst);
    expect(await cursorOf(runId)).toBe(await lastStreamId(runId));
  });

  it('persists an event type this vintage cannot parse instead of skipping it', async () => {
    // The entry most likely to fail the schema is one appended by a newer
    // deploy during the rollout window — exactly the events the flush exists
    // to keep. A flush that skipped it would commit the cursor past it, and
    // the skip would be permanent: the old from-zero flush self-healed after
    // an upgrade, a cursor cannot.
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId));
    await appendEvents(runId, 1);
    const futureId = randomUUID();
    await redis.xadd(
      `aflow:session_events:${TENANT}:${runId}`,
      '*',
      'eventId',
      futureId,
      'eventType',
      'EventTypeFromTheFuture',
      'sessionId',
      runId,
      'timestamp',
      String(Date.now()),
    );
    await appendEvents(runId, 1);

    const stats = await worker().runOnce();

    expect(stats.errorCount).toBe(0);
    expect(await eventLogCount(runId)).toBe(3);
    const rows = await sql().unsafe<Array<{ event_type: string }>>(
      `SELECT event_type FROM "${SCHEMA}".event_log WHERE event_id = $1::uuid`,
      [futureId],
    );
    expect(rows[0]?.event_type).toBe('EventTypeFromTheFuture');
    expect(await cursorOf(runId)).toBe(await lastStreamId(runId));
  });

  it('halts the cursor at an entry that cannot name itself', async () => {
    // Missing eventId is corruption, not vintage skew. Advancing past it would
    // commit the loss; halting keeps the candidate armed and the failure
    // budget is what eventually records and evicts it.
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId));
    await appendEvents(runId, 1);
    await redis.xadd(
      `aflow:session_events:${TENANT}:${runId}`,
      '*',
      'eventType',
      'StepSucceeded',
      'timestamp',
      String(Date.now()),
    );

    const stats = await worker().runOnce();

    expect(stats.errorCount).toBe(1);
    expect(await stillACandidate(runId)).toBe(true);
    expect(await cursorOf(runId)).toBeNull();
  });

  it('an expired stream on a rested session reports no loss', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId, 'PAUSED'));
    await appendEvents(runId, 5);
    await worker().runOnce();
    expect(await cursorOf(runId)).toBe(await lastStreamId(runId));

    // The hot-state TTL takes the hash and the stream together, and the next
    // append recreates the stream at an id past the cursor — indistinguishable
    // from a trim by ids alone, which is why the hash is read too.
    await redis.del(StreamKeys.sessionStateKey(TENANT, runId));
    await redis.del(StreamKeys.sessionEventsStream(TENANT, runId));
    await appendEvents(runId, 3);

    logs.info.length = 0;
    logs.error.length = 0;
    await worker().runOnce();

    expect(logs.error.some((m) => m.includes('are lost'))).toBe(false);
    expect(logs.info.some((m) => m.includes('expired during a rest'))).toBe(true);
    // Quiet is not the same as skipped: the recreated tail still lands.
    expect(await eventLogCount(runId)).toBe(8);
  });

  it('a gap under a session whose hot state is live is still reported as loss', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(runId, 'PAUSED'));
    await appendEvents(runId, 5);
    await worker().runOnce();

    // Durable row still resting, hash alive: the shape a resumed session wears
    // for the cycle before its status catches up, where a trim is real.
    await redis.del(StreamKeys.sessionEventsStream(TENANT, runId));
    await appendEvents(runId, 3);

    logs.info.length = 0;
    logs.error.length = 0;
    await worker().runOnce();

    expect(logs.error.some((m) => m.includes('are lost'))).toBe(true);
    expect(logs.info.some((m) => m.includes('expired during a rest'))).toBe(false);
  });

  it('records the missing state, not the drain failure, when the drain cannot land', async () => {
    // Events but no hot state and no sessions row: the session was never
    // projected, so event_log's foreign key rejects the drain's insert. That
    // failure must not divert to the generic retry path — no retry makes it
    // succeed — and the state_missing record is where the drain error belongs.
    const runId = randomUUID();
    await appendEvents(runId, 3);

    const stats = await worker().runOnce();

    expect(stats.errorCount).toBe(1);
    const rows = await sql().unsafe<
      Array<{ reason: string; last_error: string; evicted: boolean }>
    >(
      `SELECT reason, last_error, (evicted_at IS NOT NULL) AS evicted
         FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = $1::uuid AND session_id = $2::uuid`,
      [TENANT, runId],
    );
    expect(rows[0]?.reason).toBe('state_missing');
    expect(rows[0]?.last_error).toContain('Event drain failed');
    expect(rows[0]?.evicted).toBe(true);
    expect(await stillACandidate(runId)).toBe(false);
  });
});
