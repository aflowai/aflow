/**
 * No candidate leaves the projection worklist without a durable record.
 *
 * Two drops used to end with nothing anywhere: a poison candidate given up on
 * after ten failures counted in a process-local Map, and a session whose hot
 * state was already gone. Both leave Postgres holding a stale row — or none —
 * with nothing pointing at it, and a log line is not a record.
 *
 * Real Redis and real Postgres, because both halves of the claim are substrate
 * behaviour: the claim/lease/compare-and-ack is Lua over server-clock scored
 * sorted sets, and the attempt ceiling now lives on a row so that it survives a
 * restart and means the same thing on five instances as on one. The eviction
 * predicate — "a record was written, or do not evict" — is only observable when
 * the record write can be made to fail for real.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { StreamKeys, type TenantId } from '@aflow/schemas';
import {
  createDatabase,
  tenantIdToSchemaName,
  listProjectionFailures,
  PROJECTION_FAILURES_TABLE,
} from '@aflow/database';
import { setSessionState, type SessionHotState } from '@aflow/redis';
import { stackRedis } from '@aflow/redis/testing';
import { createProjectionWorker } from '../ProjectionWorker.js';

const DATABASE_URL = process.env['DATABASE_URL'];
/** Its own database: a claim takes everything due, including a dev orchestrator's. */
const REDIS_DB = 14;

const SOURCE_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SOURCE_SCHEMA = tenantIdToSchemaName(SOURCE_TENANT);
/** Has a schema, so a projection can succeed. */
const TENANT = 'd1d10000-0000-4000-8000-000000000911' as TenantId;
const SCHEMA = tenantIdToSchemaName(TENANT);
/** Has none, so every projection of it fails at the first write. */
const BROKEN_TENANT = 'd1d10000-0000-4000-8000-000000000912' as TenantId;

const MAX_PROJECTION_RETRIES = 10;

let handle: { sql: postgres.Sql; close: () => Promise<void> } | undefined;

const STACK_REDIS = await stackRedis(REDIS_DB);

async function substrateReady(): Promise<boolean> {
  if (!DATABASE_URL || !STACK_REDIS.available) return false;
  handle = createDatabase({ connectionString: DATABASE_URL });
  try {
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT to_regclass('public.projection_failures') IS NOT NULL
         AND to_regclass(${`${SOURCE_SCHEMA}.sessions`}) IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

const READY = await substrateReady();

describe.skipIf(!READY)('projection failure record', () => {
  const sql = (): postgres.Sql => handle!.sql;
  let redis: RedisType;

  /** Rejects every statement, the way the worker sees a Postgres outage. */
  const unreachableSql = new Proxy({} as postgres.Sql, {
    get() {
      return () => Promise.reject(new Error('postgres is unreachable'));
    },
  });

  function worker(
    overrides: {
      sqlClient?: postgres.Sql;
      redis?: RedisType;
      completionSchedules?: { recordForTerminalRun: (run: unknown) => Promise<number> };
    } = {},
  ) {
    return createProjectionWorker(
      {
        redis: overrides.redis ?? redis,
        db: drizzle(sql()),
        sqlClient: overrides.sqlClient ?? sql(),
        ...(overrides.completionSchedules
          ? { completionSchedules: overrides.completionSchedules as never }
          : {}),
      },
      { batchSize: 50 },
    );
  }

  /**
   * A Redis whose first read of one session's hash is immediately followed by a
   * write to that session — the mutation that lands while the worker is
   * projecting, which is the only state the compare-and-ack exists for.
   */
  function writeDuringProjection(base: RedisType, tenantId: string, runId: string): RedisType {
    let fired = false;
    return new Proxy(base, {
      get(target, prop) {
        if (prop === 'hgetall') {
          return async (key: string): Promise<Record<string, string>> => {
            const value = await target.hgetall(key);
            if (!fired && key === StreamKeys.sessionStateKey(tenantId, runId)) {
              fired = true;
              await target.zincrby(StreamKeys.projectionCandidatesKey, 1, `${tenantId}:${runId}`);
            }
            return value;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RedisType;
  }

  function hotState(tenantId: string, runId: string, status = 'RUNNING'): SessionHotState {
    return {
      tenantId,
      sessionId: runId,
      target: { kind: 'platform-role', systemRole: 'helmsman' },
      agentVersion: '1',
      status,
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    } as unknown as SessionHotState;
  }

  async function failureRow(
    tenantId: string,
    runId: string,
  ): Promise<{ reason: string; attempts: number; evicted: boolean } | undefined> {
    const rows = await sql().unsafe<Array<{ reason: string; attempts: number; evicted: boolean }>>(
      `SELECT reason, attempts, (evicted_at IS NOT NULL) AS evicted
         FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = $1::uuid AND session_id = $2::uuid`,
      [tenantId, runId],
    );
    return rows[0];
  }

  async function stillACandidate(tenantId: string, runId: string): Promise<boolean> {
    const score = await redis.zscore(StreamKeys.projectionCandidatesKey, `${tenantId}:${runId}`);
    return score !== null;
  }

  beforeAll(async () => {
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql().unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await sql().unsafe(
      `CREATE TABLE "${SCHEMA}".sessions (LIKE "${SOURCE_SCHEMA}".sessions INCLUDING ALL)`,
    );
  });

  afterAll(async () => {
    if (!handle) return;
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await sql().unsafe(
      `DELETE FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = ANY($1::uuid[])`,
      [[TENANT, BROKEN_TENANT]],
    );
    redis.disconnect();
    await handle.close();
  });

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    await redis.flushdb();
    await sql().unsafe(`TRUNCATE "${SCHEMA}".sessions CASCADE`);
    await sql().unsafe(
      `DELETE FROM ${PROJECTION_FAILURES_TABLE} WHERE tenant_id = ANY($1::uuid[])`,
      [[TENANT, BROKEN_TENANT]],
    );
  });

  it('records a failed projection and leaves the candidate armed', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(BROKEN_TENANT, runId));

    const stats = await worker().runOnce();

    expect(stats.errorCount).toBe(1);
    expect(stats.evictedCount).toBe(0);
    const row = await failureRow(BROKEN_TENANT, runId);
    expect(row).toMatchObject({ reason: 'projection_error', attempts: 1, evicted: false });
    expect(await stillACandidate(BROKEN_TENANT, runId)).toBe(true);
  });

  it('counts attempts on the row, so the ceiling survives a new worker', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(BROKEN_TENANT, runId));

    // A fresh worker per cycle is a rolling deploy. A counter that lived in the
    // process would restart at zero every time and never reach the ceiling.
    for (let attempt = 1; attempt < MAX_PROJECTION_RETRIES; attempt++) {
      await worker().runOnce();
      expect(await failureRow(BROKEN_TENANT, runId)).toMatchObject({
        attempts: attempt,
        evicted: false,
      });
      expect(await stillACandidate(BROKEN_TENANT, runId)).toBe(true);
      await redis.zrem(StreamKeys.projectionLeasesKey, `${BROKEN_TENANT}:${runId}`);
    }

    const stats = await worker().runOnce();

    expect(stats.evictedCount).toBe(1);
    expect(await failureRow(BROKEN_TENANT, runId)).toMatchObject({
      attempts: MAX_PROJECTION_RETRIES,
      evicted: true,
    });
    expect(await stillACandidate(BROKEN_TENANT, runId)).toBe(false);
    const listed = await listProjectionFailures(sql(), { limit: 50, evictedOnly: true });
    expect(listed.map((entry) => entry.sessionId)).toContain(runId);
  });

  it('does not evict when the failure cannot be recorded', async () => {
    // Postgres being down is both the reason projection failed and the reason
    // the record cannot be written. Evicting here takes the whole backlog out
    // on one outage, so the predicate is "recorded, or stay armed".
    const runId = randomUUID();
    await setSessionState(redis, hotState(BROKEN_TENANT, runId));

    for (let attempt = 0; attempt <= MAX_PROJECTION_RETRIES + 1; attempt++) {
      const stats = await worker({ sqlClient: unreachableSql }).runOnce();
      expect(stats.evictedCount).toBe(0);
      expect(stats.unrecordedFailureCount).toBe(1);
      await redis.zrem(StreamKeys.projectionLeasesKey, `${BROKEN_TENANT}:${runId}`);
    }

    expect(await stillACandidate(BROKEN_TENANT, runId)).toBe(true);
  });

  it('records why a session with no hot state was dropped', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(TENANT, runId));
    // The hash carries a TTL and the candidate index does not, so a session can
    // outlive the only thing there was to project from.
    await redis.del(StreamKeys.sessionStateKey(TENANT, runId));

    const stats = await worker().runOnce();

    expect(stats.evictedCount).toBe(1);
    expect(await failureRow(TENANT, runId)).toMatchObject({
      reason: 'state_missing',
      evicted: true,
    });
    expect(await stillACandidate(TENANT, runId)).toBe(false);
  });

  it('tells a quarantined session apart from an expired one', async () => {
    // A corrupt session is a platform bug with its raw hash preserved; an
    // expired one is a run that aged out. Collapsing them is how the
    // most-travelled drop came to produce no evidence at all.
    const runId = randomUUID();
    await setSessionState(redis, hotState(TENANT, runId));
    await redis.setex(StreamKeys.sessionCorruptMarkerKey(TENANT, runId), 60, '{}');

    await worker().runOnce();

    expect(await failureRow(TENANT, runId)).toMatchObject({
      reason: 'state_corrupt',
      evicted: true,
    });
  });

  it('keeps the candidate armed when the record of a missing session fails', async () => {
    const runId = randomUUID();
    await setSessionState(redis, hotState(TENANT, runId));
    await redis.del(StreamKeys.sessionStateKey(TENANT, runId));

    const stats = await worker({ sqlClient: unreachableSql }).runOnce();

    expect(stats.evictedCount).toBe(0);
    expect(stats.unrecordedFailureCount).toBe(1);
    expect(await stillACandidate(TENANT, runId)).toBe(true);
  });

  it('retires the record once the session projects again', async () => {
    const runId = randomUUID();
    await sql().unsafe(
      `INSERT INTO ${PROJECTION_FAILURES_TABLE} (tenant_id, session_id, reason, attempts)
       VALUES ($1::uuid, $2::uuid, 'projection_error', 4)`,
      [TENANT, runId],
    );
    await setSessionState(redis, hotState(TENANT, runId));

    const stats = await worker().runOnce();

    expect(stats.projectedCount).toBe(1);
    expect(await failureRow(TENANT, runId)).toBeUndefined();
    expect(await stillACandidate(TENANT, runId)).toBe(false);
  });

  it('counts an acknowledgement refused by a mid-projection write', async () => {
    // Sound on its own — the session stays due with the newer state — but a
    // session refused every cycle is starvation, and nothing reported it.
    const runId = randomUUID();
    await setSessionState(redis, hotState(TENANT, runId));

    const stats = await worker({
      redis: writeDuringProjection(redis, TENANT, runId),
    }).runOnce();

    expect(stats.projectedCount).toBe(1);
    expect(stats.ackRefusedCount).toBe(1);
    expect(await stillACandidate(TENANT, runId)).toBe(true);
  });

  it('clears the completion mark when a session projects back into a live status', async () => {
    // The mark means "the CURRENT durable terminal state has fired", not "this
    // session fired once, ever" — a retry reopens the same session, and its
    // next terminal transition must fire rather than be swallowed.
    const runId = randomUUID();
    const firedAt = async (): Promise<Date | null> => {
      const rows = await sql().unsafe<Array<{ fired_at: Date | null }>>(
        `SELECT completion_schedules_fired_at AS fired_at
           FROM "${SCHEMA}".sessions WHERE session_id = $1::uuid`,
        [runId],
      );
      return rows[0]?.fired_at ?? null;
    };
    const markFired = () =>
      sql().unsafe(
        `UPDATE "${SCHEMA}".sessions SET completion_schedules_fired_at = now()
          WHERE session_id = $1::uuid`,
        [runId],
      );

    await setSessionState(redis, hotState(TENANT, runId, 'FAILED'));
    await worker().runOnce();
    await markFired();

    // Reopened by a retry: the RUNNING projection clears the mark.
    await setSessionState(redis, hotState(TENANT, runId, 'RUNNING'));
    await worker().runOnce();
    expect(await firedAt()).toBeNull();

    // A pause is a live state too — the flushable-status upsert clears as well.
    await markFired();
    await setSessionState(redis, hotState(TENANT, runId, 'PAUSED'));
    await worker().runOnce();
    expect(await firedAt()).toBeNull();

    // A terminal projection leaves the mark alone: setting and claiming it is
    // the completion recorder's transaction, not the upsert's.
    await markFired();
    await setSessionState(redis, hotState(TENANT, runId, 'SUCCEEDED'));
    await worker().runOnce();
    expect(await firedAt()).not.toBeNull();
  });

  it('skips every terminal side effect when the upsert lost the fence', async () => {
    // A stale terminal projector acts on state a peer has already superseded:
    // its completions, recovery cleanup and manifest removal all reason from
    // that stale state, so losing the fence must stop all of them, not just
    // the row write.
    const runId = randomUUID();
    const recorded: unknown[] = [];
    const recorder = {
      recordForTerminalRun: async (run: unknown): Promise<number> => {
        recorded.push(run);
        return 0;
      },
    };

    await setSessionState(redis, hotState(TENANT, runId, 'RUNNING'));
    await worker({ completionSchedules: recorder }).runOnce();

    // The stale claim's view: a FAILED state older than the RUNNING row.
    await setSessionState(redis, {
      ...hotState(TENANT, runId, 'FAILED'),
      spaceId: randomUUID(),
      lastUpdatedAt: Date.now() - 60_000,
    } as never);
    await worker({ completionSchedules: recorder }).runOnce();

    expect(recorded).toEqual([]);
    const rows = await sql().unsafe<Array<{ status: string }>>(
      `SELECT status FROM "${SCHEMA}".sessions WHERE session_id = $1::uuid`,
      [runId],
    );
    expect(rows[0]?.status).toBe('RUNNING');
  });

  it('skips a stale projection whole instead of regressing the durable row', async () => {
    // Claim exclusivity ends at the Redis lease: a projector resuming past its
    // expired lease writes the older state it read, after a peer has already
    // persisted a newer one. The upsert fences on the hot-state clock, so the
    // stale write can neither regress the durable status nor clear the
    // completion mark the newer projection stands behind.
    const runId = randomUUID();
    await setSessionState(redis, hotState(TENANT, runId, 'SUCCEEDED'));
    await worker().runOnce();
    await sql().unsafe(
      `UPDATE "${SCHEMA}".sessions SET completion_schedules_fired_at = now()
        WHERE session_id = $1::uuid`,
      [runId],
    );

    await setSessionState(redis, {
      ...hotState(TENANT, runId, 'RUNNING'),
      lastUpdatedAt: Date.now() - 60_000,
    } as never);
    await worker().runOnce();

    const rows = await sql().unsafe<Array<{ status: string; fired: boolean }>>(
      `SELECT status, (completion_schedules_fired_at IS NOT NULL) AS fired
         FROM "${SCHEMA}".sessions WHERE session_id = $1::uuid`,
      [runId],
    );
    expect(rows[0]?.status).toBe('SUCCEEDED');
    expect(rows[0]?.fired).toBe(true);
  });

  it('hands a terminal run to the completion recorder, and only a terminal one', async () => {
    // Both halves of the on_completion path have their own tests; this is the
    // wiring between them, which nothing else exercises — deleting the call
    // from fullFlush would silence every completion schedule with CI green.
    const seen: Array<{ runId: string; status: string }> = [];
    const recorder = {
      recordForTerminalRun: async (run: unknown) => {
        const r = run as { runId: string; status: string };
        seen.push({ runId: r.runId, status: r.status });
        return 0;
      },
    };

    const terminalRun = randomUUID();
    const runningRun = randomUUID();
    await setSessionState(redis, {
      ...hotState(TENANT, terminalRun, 'SUCCEEDED'),
      spaceId: randomUUID(),
    } as never);
    await setSessionState(redis, hotState(TENANT, runningRun));

    await worker({ completionSchedules: recorder }).runOnce();

    expect(seen.map((r) => r.runId)).toEqual([terminalRun]);
    expect(seen[0]?.status).toBe('SUCCEEDED');
  });

  it('keeps the candidate armed when the completion recorder fails', async () => {
    // The recorder is the only thing that re-drives a lost firing, so its
    // failure must not spend the session's eviction budget — an evicted
    // candidate forfeits the firing permanently.
    const recorder = {
      recordForTerminalRun: async () => {
        throw new Error('marker column missing');
      },
    };
    const runId = randomUUID();
    await setSessionState(redis, {
      ...hotState(TENANT, runId, 'SUCCEEDED'),
      spaceId: randomUUID(),
    } as never);

    const stats = await worker({ completionSchedules: recorder }).runOnce();

    expect(stats.evictedCount).toBe(0);
    expect(await stillACandidate(TENANT, runId)).toBe(true);
    expect(await failureRow(TENANT, runId)).toBeUndefined();
  });
});
