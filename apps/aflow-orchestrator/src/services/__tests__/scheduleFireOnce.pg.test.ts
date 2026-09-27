/**
 * A due schedule fires once — not zero times, not twice.
 *
 * The two halves fail in opposite directions and neither is observable from a
 * fake. Firing twice needs a real transaction to rule out: the schedule advance
 * and the dispatch record either commit together or the occurrence is
 * recomputed identically on the retry. Firing zero times needs a real crash
 * point: a drain that emits and then dies must not lose the run, and a
 * redelivery of the same record must not start a second one.
 *
 * Real Postgres on a schema cloned from the live tenant one, with the arming
 * triggers installed the way the migration installs them — the arming is DDL,
 * the claims are `FOR UPDATE SKIP LOCKED`, and none of that has a fake. The
 * clone keeps the live tenant's own schedules out of the assertions.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import {
  createDatabase,
  tenantIdToSchemaName,
  claimScheduleDispatches,
  clearTenantDue,
  tenantDueSeedDdl,
  tenantDueTriggerDdl,
  SCHEDULE_DUE_POINTER,
  SCHEDULE_DISPATCH_OUTBOX_TABLE,
} from '@aflow/database';

import { StreamKeys, resolveBackgroundTaskRuntime, type TenantId } from '@aflow/schemas';
import { ScheduleEvaluator, advanceScheduleInTx } from '../ScheduleEvaluator.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const SOURCE_TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SOURCE_SCHEMA = tenantIdToSchemaName(SOURCE_TENANT);
/**
 * This suite clones whole tenant schemas, and `cloneSchema` drops before it
 * creates. Fixed ids meant two concurrent executions — two worktrees, a re-run
 * started before the last finished — dropped each other's schema mid-test, and
 * a live dev orchestrator kept claiming work for a tenant whose schema had gone.
 * The namespace is what a later run sweeps an abandoned one by; the random tail
 * is what keeps two live runs apart.
 */
const TENANT_NAMESPACE = 'd1d10000-0000-4000-8000-';
const SCHEMA_NAMESPACE = `t_${TENANT_NAMESPACE.replace(/-/g, '')}`;
const RUN_TAIL = randomBytes(5).toString('hex');
const TENANT = `${TENANT_NAMESPACE}${RUN_TAIL}02` as TenantId;
const SCHEMA = tenantIdToSchemaName(TENANT);
/** A second tenant, so a cycle budget can be shown to bound the whole cycle. */
const TENANT_B = `${TENANT_NAMESPACE}${RUN_TAIL}03` as TenantId;
const SCHEMA_B = tenantIdToSchemaName(TENANT_B);
/** Stamped inside each cloned schema so a sweep can tell abandoned from live. */
const SUITE_MARKER = '_suite_started_at';
const SPACE = '55ed0000-0000-4000-8000-0000000009f2';
const CREATOR = '11110000-0000-4000-8000-0000000009f2';
const CYCLE_BUDGET = resolveBackgroundTaskRuntime('orchestrator.schedule_evaluator').maxBatch;

let handle: { sql: postgres.Sql; close: () => Promise<void> } | undefined;

/**
 * A `postgres.Sql` that runs `hook.run()` once, immediately after the first
 * query matching `hook.match` returns.
 *
 * Every statement is the real thing against the real database; the only thing
 * injected is when the other instance gets to run. Nothing else can express the
 * interleaving these tests are about — the tenant claim is what normally keeps
 * two instances apart, so a race that survives it has to be staged from inside
 * the cycle that holds the claim.
 */
function interleavingSql(
  base: postgres.Sql,
  hook: { match: (query: string) => boolean; run: () => Promise<void> },
): postgres.Sql {
  let fired = false;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'unsafe') {
        return async (query: string, params?: unknown[]): Promise<unknown> => {
          const rows = await (params === undefined
            ? target.unsafe(query)
            : target.unsafe(query, params as never));
          if (!fired && hook.match(query)) {
            fired = true;
            await hook.run();
          }
          return rows;
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as postgres.Sql;
}

const DUE_SELECT = (query: string): boolean =>
  query.includes('.agent_schedules') && query.includes('next_fire_at <= NOW()');

/**
 * A `postgres.Sql` whose transactions fail on the outbox insert — a real
 * transaction, a real rollback, failing at the last write of the pair whose
 * atomicity is the claim under test.
 */
function failingOutboxSql(base: postgres.Sql): postgres.Sql {
  const wrapTx = (tx: postgres.TransactionSql): postgres.TransactionSql =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === 'unsafe') {
          return async (query: string, params?: unknown[]): Promise<unknown> => {
            if (query.includes(SCHEDULE_DISPATCH_OUTBOX_TABLE)) {
              throw new Error('outbox write failed');
            }
            return params === undefined
              ? target.unsafe(query)
              : target.unsafe(query, params as never);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as postgres.TransactionSql;

  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'begin') {
        return <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
          target.begin((tx) => fn(wrapTx(tx))) as Promise<T>;
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as postgres.Sql;
}

async function substrateReady(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  handle = createDatabase({ connectionString: DATABASE_URL });
  try {
    const rows = await handle.sql<Array<{ ok: boolean }>>`
      SELECT to_regclass('public.schedule_due') IS NOT NULL
         AND to_regclass('public.schedule_dispatch_outbox') IS NOT NULL
         AND to_regclass(${`${SOURCE_SCHEMA}.agent_schedules`}) IS NOT NULL AS ok`;
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

const READY = await substrateReady();

describe.skipIf(!READY)('schedule fire-once', () => {
  const sql = (): postgres.Sql => handle!.sql;
  let redis: RedisType;

  /**
   * Every control message on every shard stream. Read with XRANGE rather than
   * the consumer-group reader so the assertion is "what was written", not "what
   * one consumer happened to be delivered".
   */
  async function emittedControlMessages(): Promise<Array<Record<string, string>>> {
    const out: Array<Record<string, string>> = [];
    for (let shard = 0; shard < 128; shard++) {
      const entries = await redis.xrange(StreamKeys.shardControlStream(shard), '-', '+');
      for (const [, fields] of entries as Array<[string, string[]]>) {
        const message: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) message[fields[i]!] = fields[i + 1]!;
        out.push(message);
      }
    }
    return out;
  }

  function evaluator(): ScheduleEvaluator {
    return new ScheduleEvaluator({ redis, sqlClient: sql(), instanceId: randomUUID() });
  }

  async function insertSchedule(
    overrides: Partial<{
      schema: string;
      status: string;
      kind: string;
      nextFireAt: string | null;
      cron: string | null;
      creator: string | null;
      maxFirings: number | null;
      sourceStatus: string | null;
      sourceSystemRole: string | null;
    }> = {},
  ): Promise<string> {
    const rows = await sql().unsafe<Array<{ id: string }>>(
      `INSERT INTO "${overrides.schema ?? SCHEMA}".agent_schedules
         (space_id, name, action, kind, cron_expression, timezone, status, next_fire_at,
          target_kind, target_system_role, creator_user_id, creator_tenant_role,
          creator_space_role, max_firings, input_template,
          source_kind, source_system_role, source_status)
       VALUES ($1::uuid, 'nightly', 'start_run', $2, $3, 'UTC', $4, $5::timestamptz,
               'platform-role', 'helmsman', $6::uuid, 'admin', 'editor', $7::int, '{}'::jsonb,
               CASE WHEN $8::text IS NULL THEN NULL ELSE 'platform-role' END, $8::text, $9::text)
       RETURNING id::text AS id`,
      [
        SPACE,
        overrides.kind ?? 'cron',
        overrides.cron === undefined ? '0 3 * * *' : overrides.cron,
        overrides.status ?? 'active',
        overrides.nextFireAt === undefined
          ? new Date(Date.now() - 60_000).toISOString()
          : overrides.nextFireAt,
        overrides.creator === undefined ? CREATOR : overrides.creator,
        overrides.maxFirings ?? null,
        overrides.sourceSystemRole ?? null,
        overrides.sourceStatus ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /** A run whose terminal state is already durable and whose firing is owed. */
  async function insertTerminalSession(status: string): Promise<string> {
    const rows = await sql().unsafe<Array<{ id: string }>>(
      `INSERT INTO "${SCHEMA}".sessions
         (session_id, target_kind, target_system_role, agent_version, status, space_id, ended_at)
       VALUES (gen_random_uuid(), 'platform-role', 'helmsman', '1', $1, $2::uuid, now())
       RETURNING session_id::text AS id`,
      [status, SPACE],
    );
    return rows[0]!.id;
  }

  async function completionFiredAt(sessionId: string): Promise<Date | null> {
    const rows = await sql().unsafe<Array<{ fired: Date | null }>>(
      `SELECT completion_schedules_fired_at AS fired FROM "${SCHEMA}".sessions WHERE session_id = $1::uuid`,
      [sessionId],
    );
    return rows[0]?.fired ?? null;
  }

  async function pointerDueMs(): Promise<number | null> {
    const rows = await sql()<Array<{ due_ms: string }>>`
      SELECT (extract(epoch FROM due_at) * 1000)::bigint::text AS due_ms
        FROM public.schedule_due WHERE tenant_id = ${TENANT}`;
    return rows[0] ? Number(rows[0].due_ms) : null;
  }

  async function outboxKeys(): Promise<string[]> {
    const rows = await sql().unsafe<Array<{ idempotency_key: string }>>(
      `SELECT idempotency_key FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
        WHERE tenant_id = $1::uuid ORDER BY idempotency_key`,
      [TENANT],
    );
    return rows.map((row) => row.idempotency_key);
  }

  async function scheduleRow(
    id: string,
    schema: string = SCHEMA,
  ): Promise<{ firing_count: number; status: string; next_fire_at: string | null }> {
    const rows = await sql().unsafe<
      Array<{ firing_count: number; status: string; next_fire_at: string | null }>
    >(`SELECT firing_count, status, next_fire_at FROM "${schema}".agent_schedules WHERE id = $1`, [
      id,
    ]);
    return rows[0]!;
  }

  async function cloneSchema(schema: string): Promise<void> {
    await sql().unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql().unsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of ['agent_schedules', 'spaces', 'sessions']) {
      await sql().unsafe(
        `CREATE TABLE "${schema}".${table} (LIKE "${SOURCE_SCHEMA}".${table} INCLUDING ALL)`,
      );
    }
    await sql().unsafe(tenantDueTriggerDdl(SCHEDULE_DUE_POINTER, schema));
    await sql().unsafe(
      `CREATE TABLE "${schema}".${SUITE_MARKER} (started_at timestamptz NOT NULL DEFAULT now())`,
    );
    await sql().unsafe(`INSERT INTO "${schema}".${SUITE_MARKER} DEFAULT VALUES`);
  }

  /** The tenant uuid a cloned schema name was built from. */
  function tenantOfSchema(schema: string): string {
    const hex = schema.slice(2);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  /**
   * Schemas an earlier run abandoned. Each run owns uniquely named schemas, so
   * nothing else will ever drop them for it, and a run killed before `afterAll`
   * would leak one forever along with the cross-tenant rows that point at it —
   * which is what a live orchestrator then fails on. The age gate is what keeps
   * a concurrent run's schema out of this; a schema with no marker predates the
   * convention and is left alone rather than guessed at.
   */
  async function sweepAbandonedTenants(): Promise<void> {
    const rows = await sql().unsafe<Array<{ schema_name: string }>>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1`,
      [`${SCHEMA_NAMESPACE}%`],
    );
    for (const { schema_name: schema } of rows) {
      if (schema === SCHEMA || schema === SCHEMA_B) continue;
      const aged = await sql()
        .unsafe<Array<{ old: boolean }>>(
          `SELECT started_at < now() - interval '1 hour' AS old
             FROM "${schema}".${SUITE_MARKER} LIMIT 1`,
        )
        .catch(() => [] as Array<{ old: boolean }>);
      if (aged[0]?.old !== true) continue;
      const tenant = tenantOfSchema(schema);
      await sql().unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await clearTenantDue(sql(), [SCHEDULE_DUE_POINTER], tenant as TenantId);
      await sql().unsafe(
        `DELETE FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE} WHERE tenant_id = $1::uuid`,
        [tenant],
      );
    }
  }

  beforeAll(async () => {
    await sweepAbandonedTenants();
    await cloneSchema(SCHEMA);
    await cloneSchema(SCHEMA_B);
  });

  afterAll(async () => {
    if (!handle) return;
    for (const schema of [SCHEMA, SCHEMA_B]) {
      await sql().unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    for (const tenant of [TENANT, TENANT_B]) {
      await clearTenantDue(sql(), [SCHEDULE_DUE_POINTER], tenant);
      await sql().unsafe(
        `DELETE FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE} WHERE tenant_id = $1::uuid`,
        [tenant],
      );
    }
    await handle.close();
  });

  beforeEach(async () => {
    for (const [tenant, schema] of [
      [TENANT, SCHEMA],
      [TENANT_B, SCHEMA_B],
    ] as const) {
      await sql().unsafe(`TRUNCATE "${schema}".agent_schedules`);
      await sql().unsafe(`TRUNCATE "${schema}".sessions CASCADE`);
      await sql().unsafe(
        `DELETE FROM ${SCHEDULE_DISPATCH_OUTBOX_TABLE} WHERE tenant_id = $1::uuid`,
        [tenant],
      );
      await clearTenantDue(sql(), [SCHEDULE_DUE_POINTER], tenant);
    }
    redis = new Redis() as unknown as RedisType;
    await redis.flushall();
  });

  describe('arming', () => {
    it('arms the pointer from the insert that creates a due schedule', async () => {
      const before = Date.now();
      await insertSchedule();
      const due = await pointerDueMs();
      expect(due).not.toBeNull();
      expect(due!).toBeLessThan(before);
    });

    it('arms on an unpause, which writes no due column at all', async () => {
      // The write that makes a schedule eligible again touches `status` only.
      // A pointer watching `next_fire_at` would never hear about it.
      const id = await insertSchedule({ status: 'paused' });
      expect(await pointerDueMs()).toBeNull();
      await sql().unsafe(`UPDATE "${SCHEMA}".agent_schedules SET status = 'active' WHERE id = $1`, [
        id,
      ]);
      expect(await pointerDueMs()).not.toBeNull();
    });

    it('seeds from rows that predate the trigger', async () => {
      // A healthy cron row is written only by the evaluator when it fires, and
      // the fire is what the pointer causes — without the seed it never arms.
      await insertSchedule();
      await clearTenantDue(sql(), [SCHEDULE_DUE_POINTER], TENANT);
      expect(await pointerDueMs()).toBeNull();
      await sql().unsafe(tenantDueSeedDdl(SCHEDULE_DUE_POINTER, SCHEMA));
      expect(await pointerDueMs()).not.toBeNull();
    });

    it('does not arm for a schedule kind the evaluator never polls', async () => {
      await insertSchedule({ kind: 'on_completion', cron: null, nextFireAt: null });
      expect(await pointerDueMs()).toBeNull();
    });
  });

  describe('discovery', () => {
    it('advances the schedule and records exactly one occurrence, together', async () => {
      const id = await insertSchedule();
      await evaluator().evaluateOnce();

      const row = await scheduleRow(id);
      expect(row.firing_count).toBe(1);
      expect(new Date(row.next_fire_at!).getTime()).toBeGreaterThan(Date.now());
      expect(await emittedControlMessages()).toHaveLength(1);
    });

    it('does not record a second occurrence for a schedule it already advanced', async () => {
      const id = await insertSchedule();
      const first = evaluator();
      await first.evaluateOnce();
      await first.evaluateOnce();
      expect((await scheduleRow(id)).firing_count).toBe(1);
      expect(await emittedControlMessages()).toHaveLength(1);
    });

    it('finds nothing when the pointer holds no tenant', async () => {
      await insertSchedule();
      await clearTenantDue(sql(), [SCHEDULE_DUE_POINTER], TENANT);
      await evaluator().evaluateOnce();
      // The pointer is the only discovery path; nothing walks tenants to
      // second-guess it.
      expect(await emittedControlMessages()).toHaveLength(0);
    });

    it('expires a one-shot rather than leaving it due forever', async () => {
      const id = await insertSchedule({ kind: 'one_shot', cron: null });
      await evaluator().evaluateOnce();
      const row = await scheduleRow(id);
      expect(row.status).toBe('expired');
      expect(row.next_fire_at).toBeNull();
    });

    it('advances past an ownerless schedule without recording an occurrence', async () => {
      const id = await insertSchedule({ creator: null });
      await evaluator().evaluateOnce();
      expect((await scheduleRow(id)).firing_count).toBe(1);
      expect(await outboxKeys()).toEqual([]);
      expect(await emittedControlMessages()).toHaveLength(0);
    });

    it('refuses to advance a row a second instance advanced from the same read', async () => {
      // The tenant claim is what normally keeps two instances off one schedule,
      // and its lease expires at the same instant the cycle's own budget does.
      // Releasing it mid-cycle is that expiry, and it is the only state in which
      // the row guard is load-bearing.
      const id = await insertSchedule();
      const winner = evaluator();
      const loser = new ScheduleEvaluator({
        redis,
        sqlClient: interleavingSql(sql(), {
          match: DUE_SELECT,
          run: async () => {
            await sql().unsafe(
              `UPDATE public.schedule_due SET lease_until = NULL, claimed_by = NULL
                WHERE tenant_id = $1::uuid`,
              [TENANT],
            );
            await winner.evaluateOnce();
          },
        }),
        instanceId: randomUUID(),
      });

      await loser.evaluateOnce();

      expect((await scheduleRow(id)).firing_count).toBe(1);
      expect(await emittedControlMessages()).toHaveLength(1);
      expect(await outboxKeys()).toEqual([]);
    });

    it('loses to an operator who pauses the schedule mid-cycle', async () => {
      const id = await insertSchedule();
      const paused = new ScheduleEvaluator({
        redis,
        sqlClient: interleavingSql(sql(), {
          match: DUE_SELECT,
          run: async () => {
            await sql().unsafe(
              `UPDATE "${SCHEMA}".agent_schedules SET status = 'paused' WHERE id = $1::uuid`,
              [id],
            );
          },
        }),
        instanceId: randomUUID(),
      });

      await paused.evaluateOnce();

      const row = await scheduleRow(id);
      expect(row.status).toBe('paused');
      expect(row.firing_count).toBe(0);
      expect(await emittedControlMessages()).toHaveLength(0);
    });

    it('bounds one cycle across every tenant it claimed, and serves the rest next cycle', async () => {
      // The budget is the batch ceiling for the whole cycle. Reused per tenant
      // it multiplies by the tenants claimed, and the cycle then outlives the
      // leases that are its only exclusion. The second half of this test is
      // what makes the first half mean "deferred" rather than "lost".
      const older = new Date(Date.now() - 600_000).toISOString();
      for (let i = 0; i < CYCLE_BUDGET; i++) {
        await insertSchedule({ nextFireAt: older });
      }
      const deferredId = await insertSchedule({ schema: SCHEMA_B });
      const subject = evaluator();

      await subject.evaluateOnce();

      const spent = await sql().unsafe<Array<{ total: string }>>(
        `SELECT COALESCE(sum(firing_count), 0)::text AS total FROM "${SCHEMA}".agent_schedules`,
      );
      // Every tenant claimed gets a share of the one budget rather than the
      // head of the queue taking it all: the deep-backlog tenant is bounded to
      // its slice, and the tenant behind it fires in the SAME cycle instead of
      // waiting out however many cycles the backlog lasts.
      expect(Number(spent[0]!.total)).toBeLessThanOrEqual(Math.ceil(CYCLE_BUDGET / 2));
      expect(Number(spent[0]!.total)).toBeGreaterThan(0);
      expect((await scheduleRow(deferredId, SCHEMA_B)).firing_count).toBe(1);

      await subject.evaluateOnce();
      const after = await sql().unsafe<Array<{ total: string }>>(
        `SELECT COALESCE(sum(firing_count), 0)::text AS total FROM "${SCHEMA}".agent_schedules`,
      );
      expect(Number(after[0]!.total)).toBeGreaterThan(Number(spent[0]!.total));
    });
  });

  describe('dispatch', () => {
    it('retires the record only after the control message is written', async () => {
      await insertSchedule();
      await evaluator().evaluateOnce();
      expect(await outboxKeys()).toEqual([]);
      expect(await emittedControlMessages()).toHaveLength(1);
    });

    it('does not start a second run when a record is redelivered after an emit', async () => {
      // The drain is at-least-once by construction: it can be killed between
      // the emit and the delete. Re-inserting the record is that crash.
      const id = await insertSchedule();
      const evaluatorA = evaluator();
      await evaluatorA.evaluateOnce();
      const emitted = await emittedControlMessages();
      expect(emitted).toHaveLength(1);

      await sql().unsafe(
        `INSERT INTO ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
           (idempotency_key, tenant_id, schedule_id, dispatch)
         SELECT $1, $2::uuid, $3::uuid, $4::jsonb`,
        [
          `schedule:${id}:1`,
          TENANT,
          id,
          JSON.stringify({
            tenantId: TENANT,
            scheduleId: id,
            scheduleName: 'nightly',
            schemaName: SCHEMA,
            spaceId: SPACE,
            action: 'start_run',
            targetKind: 'platform-role',
            targetSystemRole: 'helmsman',
            targetAgentId: null,
            agentVersion: null,
            targetSessionId: null,
            targetStepExecutionId: null,
            resolvedInput: {},
            firingCount: 1,
            idempotencyKey: `schedule:${id}:1`,
            creatorUserId: CREATOR,
            creatorTenantRole: 'admin',
            creatorSpaceRole: 'editor',
          }),
        ],
      );

      await evaluatorA.evaluateOnce();
      expect(await emittedControlMessages()).toHaveLength(1);
      expect(await outboxKeys()).toEqual([]);
    });

    it('hands two instances racing the same occurrence to exactly one of them', async () => {
      await insertSchedule();
      const [a, b] = [evaluator(), evaluator()];
      await Promise.all([a.evaluateOnce(), b.evaluateOnce()]);
      expect(await emittedControlMessages()).toHaveLength(1);
      expect(await outboxKeys()).toEqual([]);
    });

    it('leaves a record claimable again after its lease expires', async () => {
      const id = await insertSchedule();
      // Record the occurrence but leave it undispatched, the way a process
      // killed between the commit and the emit does.
      await sql().unsafe(
        `INSERT INTO ${SCHEDULE_DISPATCH_OUTBOX_TABLE}
           (idempotency_key, tenant_id, schedule_id, dispatch, lease_until, claimed_by)
         VALUES ($1, $2::uuid, $3::uuid, '{}'::jsonb, now() - interval '1 minute', 'dead-instance')`,
        [`schedule:${id}:9`, TENANT, id],
      );
      const claimed = await claimScheduleDispatches(sql(), {
        limit: 10,
        leaseMs: 30_000,
        claimToken: 'live-instance',
      });
      expect(claimed.map((row) => row.idempotencyKey)).toContain(`schedule:${id}:9`);
    });
  });

  describe('on_completion', () => {
    const terminalRun = (runId: string, status = 'SUCCEEDED') =>
      ({
        tenantId: TENANT as string,
        runId,
        spaceId: SPACE,
        target: { kind: 'platform-role', systemRole: 'helmsman' },
        status,
      }) as const;

    it('records one occurrence for a run that has just become durable', async () => {
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');
      const subject = evaluator();

      expect(await subject.recordForTerminalRun(terminalRun(runId))).toBe(1);

      expect((await scheduleRow(id)).firing_count).toBe(1);
      expect(await completionFiredAt(runId)).not.toBeNull();

      // The occurrence is durable; emission rides the dispatch cycle rather
      // than being awaited inline, so the drain is driven explicitly here —
      // on the same instance, whose runner serialises with the record's nudge.
      await subject.evaluateOnce();
      expect(await emittedControlMessages()).toHaveLength(1);
    });

    it('does not fire a second time when the terminal run is projected again', async () => {
      // The projection worker retries anything it could not acknowledge, and a
      // terminal session is re-flushed on any later write. The mark is what
      // makes the retry free rather than a second run.
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');
      const subject = evaluator();

      expect(await subject.recordForTerminalRun(terminalRun(runId))).toBe(1);
      expect(await subject.recordForTerminalRun(terminalRun(runId))).toBe(0);

      expect((await scheduleRow(id)).firing_count).toBe(1);
      expect(await emittedControlMessages()).toHaveLength(1);
    });

    it('leaves the run unfired when recording the occurrence fails', async () => {
      // The mark and the occurrences commit together or not at all. If the mark
      // could land alone, a blip anywhere after it would lose the firing with
      // nothing left saying one was owed — which is what the inline path did.
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');

      const broken = new ScheduleEvaluator({
        redis,
        sqlClient: failingOutboxSql(sql()),
        instanceId: randomUUID(),
      });
      await expect(broken.recordForTerminalRun(terminalRun(runId))).rejects.toThrow();

      expect(await completionFiredAt(runId)).toBeNull();
      expect((await scheduleRow(id)).firing_count).toBe(0);

      const healthy = evaluator();
      expect(await healthy.recordForTerminalRun(terminalRun(runId))).toBe(1);
      // Same instance: its runner is what the record nudged, so this waits for
      // any in-flight drain instead of racing a fresh one against its lease.
      await healthy.evaluateOnce();
      expect(await emittedControlMessages()).toHaveLength(1);
    });

    it('refuses a stale claim when the durable row is live again', async () => {
      // The terminal upsert and the marker claim are separate transactions; a
      // stale claim landing after a peer projected the retried run's live
      // status must not set the mark against a live row — that would swallow
      // the next terminal transition's firing.
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');
      await sql().unsafe(
        `UPDATE "${SCHEMA}".sessions SET status = 'RUNNING' WHERE session_id = $1::uuid`,
        [runId],
      );

      expect(await evaluator().recordForTerminalRun(terminalRun(runId))).toBe(0);

      expect(await completionFiredAt(runId)).toBeNull();
      expect((await scheduleRow(id)).firing_count).toBe(0);
    });

    it('fires again after the projection of a reopened session clears the mark', async () => {
      // A retried session reaches a second terminal transition; the projection
      // worker clears the mark when it projects the live status in between, so
      // the recorder sees a fresh claim rather than the old transition's.
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');

      expect(await evaluator().recordForTerminalRun(terminalRun(runId))).toBe(1);
      await sql().unsafe(
        `UPDATE "${SCHEMA}".sessions SET completion_schedules_fired_at = NULL
          WHERE session_id = $1::uuid`,
        [runId],
      );
      expect(await evaluator().recordForTerminalRun(terminalRun(runId))).toBe(1);

      expect((await scheduleRow(id)).firing_count).toBe(2);
    });

    it('refuses to record while schedules are disabled, leaving the firing owed', async () => {
      // Returning success here would let the projection worker acknowledge the
      // terminal candidate with completion_schedules_fired_at still null — and
      // nothing ever re-arms a terminal run, so the firing would be silently
      // lost rather than suspended.
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');

      const disabled = new ScheduleEvaluator({
        redis,
        sqlClient: sql(),
        instanceId: randomUUID(),
        mode: 'disabled',
      });
      await expect(disabled.recordForTerminalRun(terminalRun(runId))).rejects.toThrow(/suspended/);
      expect(await completionFiredAt(runId)).toBeNull();

      // Re-enabled, the still-armed candidate replays the owed firing.
      expect(await evaluator().recordForTerminalRun(terminalRun(runId))).toBe(1);
      expect((await scheduleRow(id)).firing_count).toBe(1);
    });

    it('flips an exhausting advance to expired even when the caller read a stale count', async () => {
      // Two source runs completing at once both read the same firing_count and
      // both must fire — so the later writer's caller-computed status is one
      // increment behind. The statement owns the terminal flip; a caller-owned
      // one writes 'active' onto a schedule that just reached its limit.
      const id = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
        maxFirings: 2,
      });
      await sql().unsafe(
        `UPDATE "${SCHEMA}".agent_schedules SET firing_count = 1 WHERE id = $1::uuid`,
        [id],
      );
      const stale = { id, tenant_schema: SCHEMA, firing_count: 0 } as unknown as Parameters<
        typeof advanceScheduleInTx
      >[1];

      const fired = await sql().begin(async (tx) =>
        advanceScheduleInTx(tx, stale, { nextFireAt: null, status: 'active' }),
      );

      expect(fired).toBe(2);
      const row = await scheduleRow(id);
      expect(row.status).toBe('expired');
      expect(row.next_fire_at).toBeNull();
    });

    it('skips a schedule left exhausted but active instead of failing the recording', async () => {
      // The recording transaction also carries the completion marker and every
      // sibling schedule's occurrence — a row that can never fire again must
      // cost this run nothing, and the miss retires it so it stops being
      // selected by every later completion.
      const poisoned = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
        maxFirings: 2,
      });
      await sql().unsafe(
        `UPDATE "${SCHEMA}".agent_schedules SET firing_count = 2 WHERE id = $1::uuid`,
        [poisoned],
      );
      const healthy = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'succeeded',
      });
      const runId = await insertTerminalSession('SUCCEEDED');

      expect(await evaluator().recordForTerminalRun(terminalRun(runId))).toBe(1);

      expect(await completionFiredAt(runId)).not.toBeNull();
      expect((await scheduleRow(healthy)).firing_count).toBe(1);
      expect((await scheduleRow(poisoned)).status).toBe('expired');
      expect((await scheduleRow(poisoned)).firing_count).toBe(2);
    });

    it('fires a cancelled run only for schedules that asked for any terminal state', async () => {
      const onFailure = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'failed',
      });
      const onAny = await insertSchedule({
        kind: 'on_completion',
        cron: null,
        nextFireAt: null,
        sourceSystemRole: 'helmsman',
        sourceStatus: 'any_terminal',
      });
      const runId = await insertTerminalSession('CANCELLED');

      expect(await evaluator().recordForTerminalRun(terminalRun(runId, 'CANCELLED'))).toBe(1);

      expect((await scheduleRow(onFailure)).firing_count).toBe(0);
      expect((await scheduleRow(onAny)).firing_count).toBe(1);
    });
  });
});
