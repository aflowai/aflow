/**
 * GET /v1/schedules/chat is all the Workbench's Schedules section reads, so
 * what it answers is what the section shows: the requesting space's chains,
 * each as its newest renewal, and only the ones that will fire again.
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
 * `pairs` stands for what the chain query picks, one arrival and its newest
 * renewal per chain, and `rows` for the schedules the second read loads.
 */
const table = vi.hoisted(() => ({
  pairs: [] as Array<{ arrival_id: string; current_id: string }>,
  rows: [] as unknown[],
  executed: [] as unknown[],
  tenants: [] as unknown[],
  databases: [] as unknown[],
}));

const DATABASE = vi.hoisted(() => ({ name: 'the server database' }));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const query = { from: () => query, where: () => Promise.resolve(table.rows) };
  return {
    ...actual,
    getDatabase: () => DATABASE,
    createTenantContext: (tenantId: unknown) => {
      table.tenants.push(tenantId);
      return actual.createTenantContext(tenantId as TenantId);
    },
    withTenantSchema: (db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      table.databases.push(db);
      return fn({
        select: () => query,
        execute: (statement: unknown) => {
          table.executed.push(statement);
          return Promise.resolve(table.pairs);
        },
      });
    },
  };
});

const { registerScheduleRoutes } = await import('./registerRoutes.js');
const { rowToResponse } = await import('./helpers.js');

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

function chain(arrival: AgentScheduleRow, current: AgentScheduleRow = arrival): void {
  table.pairs.push({ arrival_id: arrival.id, current_id: current.id });
  table.rows.push(arrival, current);
}

/** A shepherd armed in chat, renewed once: the first is expired, the renewal fires. */
const shepherd = schedule('5247eee7-0000-4000-8000-000000000001', {
  status: 'expired',
  nextFireAt: null,
  firingCount: 50,
  createdAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE),
});
const shepherdRenewal = schedule('6247eee7-0000-4000-8000-000000000002', {
  firingCount: 3,
  renewsScheduleId: shepherd.id,
  originalScheduleId: shepherd.id,
  createdAt: new Date(Date.now() - 30 * MINUTE),
});

/** A one-shot armed in chat an hour ago, which has run and is over. */
const firedOneShot = schedule('7247eee7-0000-4000-8000-000000000003', {
  name: 'Send the release note',
  kind: 'one_shot',
  cronExpression: null,
  scheduledAt: new Date(Date.now() - 30 * MINUTE),
  status: 'expired',
  nextFireAt: null,
  firingCount: 1,
  maxFirings: 1,
  lastFiredAt: new Date(Date.now() - 30 * MINUTE),
});

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
  table.pairs = [];
  table.rows = [];
  table.executed = [];
  table.tenants = [];
  table.databases = [];
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

async function getChat(): Promise<{ status: number; body: { schedules: unknown[] } }> {
  const res = await app.inject({ method: 'GET', url: '/v1/schedules/chat' });
  return { status: res.statusCode, body: res.json() };
}

describe('GET /v1/schedules/chat', () => {
  it("reads the requesting tenant's schema and the requesting space only", async () => {
    await getChat();

    expect(table.databases).toEqual([DATABASE]);
    expect(table.tenants).toEqual([TENANT]);
    const query = new PgDialect().sqlToQuery(table.executed[0] as SQL);
    expect(query.params).toContain(SPACE);
    expect(query.sql).not.toContain(SPACE);
  });

  it("answers { schedules } with each chain's newest renewal, newest arrival first, as rowToResponse maps it", async () => {
    chain(shepherd, shepherdRenewal);
    const daily = schedule('8247eee7-0000-4000-8000-000000000004', { name: 'Daily report' });
    chain(daily);

    const { status, body } = await getChat();

    expect(status).toBe(200);
    expect(body).toEqual({
      schedules: [rowToResponse(daily), rowToResponse(shepherdRenewal)].map((row) =>
        JSON.parse(JSON.stringify(row)),
      ),
    });
  });

  it('never answers with an expired one-shot', async () => {
    chain(firedOneShot);
    chain(shepherd, shepherdRenewal);

    const { body } = await getChat();

    const ids = body.schedules.map((row) => (row as { id: string }).id);
    expect(ids).toEqual([shepherdRenewal.id]);
    expect(ids).not.toContain(firedOneShot.id);
  });

  it('leaves out a chain whose newest renewal will not fire again', async () => {
    chain(shepherd);
    chain(schedule('9247eee7-0000-4000-8000-000000000005', { status: 'paused' }));
    chain(
      schedule('a247eee7-0000-4000-8000-000000000006', {
        expiresAt: new Date(Date.now() - MINUTE),
      }),
    );
    chain(
      schedule('b247eee7-0000-4000-8000-000000000007', {
        nextFireAt: new Date(Date.now() - MINUTE),
      }),
    );

    expect((await getChat()).body).toEqual({ schedules: [] });
  });
});
