/**
 * GET /v1/schedules/upcoming is all the Workbench's Schedules section reads, so
 * what it answers is what the section shows: the requesting space's schedules
 * that will fire again, whoever created them.
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
const ARMING_SESSION = 'f0000000-0000-4000-8000-000000000011';
const MINUTE = 60_000;

/**
 * `rows` stands for what the database answers, and `reads` records the
 * condition, the order and the limit each read asked for.
 */
const table = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** What a count of every upcoming schedule answers. */
  total: 0,
  reads: [] as Array<{
    fields: unknown;
    where: unknown;
    orderBy: unknown[];
    limit: number | undefined;
  }>,
  tenants: [] as unknown[],
  databases: [] as unknown[],
}));

const DATABASE = vi.hoisted(() => ({ name: 'the server database' }));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  function select(fields?: unknown) {
    const read: { fields: unknown; where: unknown; orderBy: unknown[]; limit: number | undefined } =
      {
        fields,
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
      // A count read ends at its condition and answers one row.
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve(fields === undefined ? table.rows : [{ total: table.total }]).then(
          resolve,
          reject,
        ),
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
    getDatabase: () => DATABASE,
    createTenantContext: (tenantId: unknown) => {
      table.tenants.push(tenantId);
      return actual.createTenantContext(tenantId as TenantId);
    },
    withTenantSchema: (db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      table.databases.push(db);
      return fn({ select });
    },
  };
});

const { registerScheduleRoutes } = await import('./registerRoutes.js');
const { rowToResponse } = await import('./helpers.js');
const { UPCOMING_SCHEDULE_LIST_LIMIT } = await import('./upcoming.js');

function schedule(id: string, overrides: Partial<AgentScheduleRow>): AgentScheduleRow {
  const at = new Date(Date.now() - 60 * MINUTE);
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
    status: 'active',
    maxFirings: 50,
    firingCount: 0,
    lastFiredAt: null,
    lastSessionId: null,
    nextFireAt: new Date(Date.now() + 4 * MINUTE),
    expiresAt: null,
    lastError: null,
    createdBy: null,
    createdBySessionId: ARMING_SESSION,
    metadata: {},
    renewsScheduleId: null,
    originalScheduleId: null,
    creatorUserId: null,
    creatorTenantRole: null,
    creatorSpaceRole: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** The Local PR Shepherd as the operator created it: no session armed it. */
const operatorShepherd = schedule('5247eee7-0000-4000-8000-000000000001', {
  createdBy: null,
  createdBySessionId: null,
  creatorUserId: 'd0000000-0000-4000-8000-0000000000d1',
  nextFireAt: new Date(Date.now() + MINUTE),
});

/** A daily report an agent armed in chat. */
const agentReport = schedule('6247eee7-0000-4000-8000-000000000002', { name: 'Daily report' });

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const built = Fastify({ logger: false });
  built.setValidatorCompiler(validatorCompiler);
  built.setSerializerCompiler(serializerCompiler);
  built.decorateRequest('requireTenant', function (this: FastifyRequest) {
    return Promise.resolve({ tenantId: TENANT, tenantRole: 'member', isAdmin: false });
  });
  built.decorateRequest('requireSpace', function (this: FastifyRequest) {
    return Promise.resolve({
      spaceId: SPACE as SpaceId,
      spaceRole: 'viewer',
      canWrite: false,
      isSpaceAdmin: false,
      ownerId: null,
      memberCount: 1,
    });
  });
  await built.register(
    (scoped) => {
      registerScheduleRoutes(scoped);
      return Promise.resolve();
    },
    { prefix: '/v1/schedules' },
  );
  await built.ready();
  return built;
}

beforeEach(async () => {
  table.rows = [];
  table.total = 0;
  table.reads = [];
  table.tenants = [];
  table.databases = [];
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

async function getUpcoming(): Promise<{
  status: number;
  body: { schedules: unknown[]; total: number };
}> {
  const res = await app.inject({ method: 'GET', url: '/v1/schedules/upcoming' });
  return { status: res.statusCode, body: res.json() };
}

/** The read's condition as Postgres receives it, its text flattened to one line. */
function readCondition(): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(table.reads[0]?.where as SQL);
  return { sql: query.sql.replace(/\s+/g, ' '), params: query.params };
}

describe('GET /v1/schedules/upcoming', () => {
  it("reads the requesting tenant's schema and the requesting space only", async () => {
    await getUpcoming();

    expect(table.databases).toEqual([DATABASE]);
    expect(table.tenants).toEqual([TENANT]);
    const { sql: text, params } = readCondition();
    expect(params).toContain(SPACE);
    expect(text).not.toContain(SPACE);
  });

  it('asks for schedules whatever their creator, so an operator-created one is listed', async () => {
    table.rows = [operatorShepherd, agentReport];

    const { status, body } = await getUpcoming();

    const { sql: text } = readCondition();
    expect(text).not.toContain('created_by_session_id');
    expect(text).not.toContain('created_by');
    expect(text).not.toContain('creator_user_id');
    expect(status).toBe(200);
    expect(body).toEqual({
      schedules: [rowToResponse(operatorShepherd), rowToResponse(agentReport)].map((row) =>
        JSON.parse(JSON.stringify(row)),
      ),
      total: 2,
    });
    // A short page holds every upcoming schedule, so nothing is counted.
    expect(table.reads).toHaveLength(1);
  });

  it('asks only for active schedules with a next firing ahead and no end behind', async () => {
    await getUpcoming();

    const { sql: text, params } = readCondition();
    expect(text).toContain('"agent_schedules"."status" = $');
    expect(params).toContain('active');
    expect(text).toContain('"agent_schedules"."next_fire_at" > $');
    expect(text).toMatch(
      /\("agent_schedules"."expires_at" is null or "agent_schedules"."expires_at" > \$\d+\)/,
    );
  });

  it('orders the soonest first and stops at the section limit', async () => {
    await getUpcoming();

    const read = table.reads[0];
    const order = read?.orderBy.map((column) =>
      new PgDialect().sqlToQuery(column as SQL).sql.replace(/\s+/g, ' '),
    );
    expect(order?.[0]).toBe('"agent_schedules"."next_fire_at" asc');
    expect(read?.limit).toBe(UPCOMING_SCHEDULE_LIST_LIMIT);
  });

  it('counts every upcoming schedule under the same condition when the cap fills', async () => {
    table.rows = Array.from({ length: UPCOMING_SCHEDULE_LIST_LIMIT }, (_, i) =>
      schedule(`7247eee7-0000-4000-8000-${String(i).padStart(12, '0')}`, {
        nextFireAt: new Date(Date.now() + (i + 1) * MINUTE),
      }),
    );
    table.total = UPCOMING_SCHEDULE_LIST_LIMIT + 14;

    const { body } = await getUpcoming();

    expect(body.schedules).toHaveLength(UPCOMING_SCHEDULE_LIST_LIMIT);
    expect(body.total).toBe(UPCOMING_SCHEDULE_LIST_LIMIT + 14);
    expect(table.reads).toHaveLength(2);
    const [list, counted] = table.reads.map((read) =>
      new PgDialect().sqlToQuery(read.where as SQL),
    );
    expect(counted).toEqual(list);
    expect(table.reads[1]?.limit).toBeUndefined();
  });
});
