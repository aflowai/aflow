/**
 * GET /v1/schedules is the Triggers page's one read of its schedules, and the
 * page takes its first page only. So the order decides what the operator sees:
 * the rows that can still run come before every expired one, however many
 * expired renewals the space has written since.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentScheduleRow } from '@aflow/database';
import type { SpaceId, TenantId } from '@aflow/schemas';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const MINUTE = 60_000;

/** `rows` stands for what the database answers, `reads` for what each read asked. */
const table = vi.hoisted(() => ({
  rows: [] as unknown[],
  reads: [] as Array<{ where: unknown; orderBy: unknown[]; limit: number | undefined }>,
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  function select() {
    const read: { where: unknown; orderBy: unknown[]; limit: number | undefined } = {
      where: undefined,
      orderBy: [],
      limit: undefined,
    };
    table.reads.push(read);
    const query = {
      from: () => query,
      where: (condition: unknown) => {
        read.where = condition;
        return query;
      },
      orderBy: (...columns: unknown[]) => {
        read.orderBy = columns;
        return query;
      },
      limit: (n: number) => {
        read.limit = n;
        return Promise.resolve(table.rows);
      },
    };
    return query;
  }
  return {
    ...actual,
    getDatabase: () => ({}),
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select }),
  };
});

const { registerScheduleRoutes } = await import('./registerRoutes.js');
const { decodeScheduleListCursor, encodeScheduleListCursor } = await import('./list.js');

function schedule(id: string, createdAt: Date): AgentScheduleRow {
  return {
    id,
    spaceId: SPACE,
    name: 'Local PR Shepherd',
    description: null,
    action: 'start_run',
    targetKind: 'custom-agent',
    targetSystemRole: null,
    targetAgentId: 'c0000000-0000-4000-8000-0000000000a1',
    agentVersion: null,
    targetSessionId: null,
    targetStepExecutionId: null,
    kind: 'cron',
    cronExpression: '*/5 * * * *',
    timezone: 'UTC',
    scheduledAt: null,
    sourceKind: null,
    sourceSystemRole: null,
    sourceAgentId: null,
    sourceStatus: null,
    inputTemplate: {},
    status: 'expired',
    maxFirings: 50,
    firingCount: 0,
    lastFiredAt: null,
    lastSessionId: null,
    nextFireAt: null,
    expiresAt: null,
    lastError: null,
    createdBy: null,
    createdBySessionId: null,
    metadata: {},
    renewsScheduleId: null,
    originalScheduleId: null,
    creatorUserId: null,
    creatorTenantRole: null,
    creatorSpaceRole: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function id(i: number): string {
  return `7247eee7-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

let app: FastifyInstance;

beforeEach(async () => {
  table.rows = [];
  table.reads = [];
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('requireTenant', function (this: FastifyRequest) {
    return Promise.resolve({ tenantId: TENANT, tenantRole: 'member', isAdmin: false });
  });
  app.decorateRequest('requireSpace', function (this: FastifyRequest) {
    return Promise.resolve({
      spaceId: SPACE as SpaceId,
      spaceRole: 'viewer',
      canWrite: false,
      isSpaceAdmin: false,
      ownerId: null,
      memberCount: 1,
    });
  });
  await app.register(
    (scoped) => {
      registerScheduleRoutes(scoped);
      return Promise.resolve();
    },
    { prefix: '/v1/schedules' },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function text(fragment: unknown): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(fragment as SQL);
  return { sql: query.sql.replace(/\s+/g, ' '), params: query.params };
}

describe('GET /v1/schedules', () => {
  it('orders the rows that can still run before every expired one, then newest first', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/schedules?limit=100' });

    expect(res.statusCode).toBe(200);
    const order = table.reads[0]?.orderBy.map((column) => text(column).sql);
    expect(order?.[0]).toBe(
      '(case when "agent_schedules"."status" = \'paused\' or ("agent_schedules"."status" = \'active\' and ("agent_schedules"."expires_at" is null or "agent_schedules"."expires_at" > $1::timestamptz)) then 0 else 1 end)',
    );
    expect(order?.slice(1)).toEqual([
      'date_trunc(\'milliseconds\', "agent_schedules"."created_at") desc',
      '"agent_schedules"."id" desc',
    ]);
    expect(table.reads[0]?.limit).toBe(101);
  });

  it('ends a full page with a cursor that resumes after its last row', async () => {
    const start = Date.now() - 60 * MINUTE;
    table.rows = Array.from({ length: 3 }, (_, i) => ({
      row: schedule(id(i), new Date(start - i * MINUTE)),
      rank: i === 0 ? 0 : 1,
    }));

    const first = await app.inject({ method: 'GET', url: '/v1/schedules?limit=2' });
    const body = first.json<{ schedules: Array<{ id: string }>; nextCursor: string | null }>();

    expect(body.schedules.map((row) => row.id)).toEqual([id(0), id(1)]);
    expect(body.nextCursor).toBe(
      encodeScheduleListCursor({ rank: 1, createdAtMs: start - MINUTE, id: id(1) }),
    );

    await app.inject({
      method: 'GET',
      url: `/v1/schedules?limit=2&cursor=${encodeURIComponent(body.nextCursor ?? '')}`,
    });
    const { sql, params } = text(table.reads[1]?.where);
    expect(sql).toContain('date_trunc(\'milliseconds\', "agent_schedules"."created_at") <');
    expect(sql).toContain('"agent_schedules"."id" <');
    expect(params).toContain(id(1));
    expect(params).toContain(new Date(start - MINUTE).toISOString());
  });

  it('refuses a cursor it did not write', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/schedules?cursor=${id(4)}` });

    expect(res.statusCode).toBe(400);
    expect(table.reads).toHaveLength(0);
  });

  it('reads back the cursor it writes', () => {
    const cursor = { rank: 0 as const, createdAtMs: 1_762_000_000_123, id: id(9) };
    expect(decodeScheduleListCursor(encodeScheduleListCursor(cursor))).toEqual(cursor);
    expect(decodeScheduleListCursor('2.1.x')).toBeNull();
  });
});
