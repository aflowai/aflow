/**
 * A schedule that pins no version starts the agent's latest published one.
 *
 * The version is chosen when the schedule fires, not when it was written: the
 * agent here has versions 1 and 2, and a schedule with no `agent_version`
 * must start 2 — the version a run started by hand gets — while one pinned to
 * "1" keeps starting 1.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import { StreamKeys, type PersistentAgentTarget } from '@aflow/schemas';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const AGENT = 'c0000000-0000-4000-8000-0000000000a1';
const CREATOR = '1eab6e64-861a-4b99-b396-74f35b111dbb';

const published = vi.hoisted(() => ({
  versions: ['1', '2'] as string[],
  archived: false,
  requested: [] as string[],
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    loadAgentTargetDefinition: (
      _db: unknown,
      _tenantId: string,
      target: PersistentAgentTarget,
      requested = 'latest',
    ) => {
      published.requested.push(requested);
      if (target.kind !== 'custom-agent') throw new Error('platform roles resolve no version');
      if (published.archived) throw new actual.ArchivedAgentError(target.agentId);
      const version = requested === 'latest' ? published.versions.at(-1) : requested;
      if (version === undefined || !published.versions.includes(version)) {
        throw new actual.VersionNotFoundError(target.agentId, requested);
      }
      return Promise.resolve({ target, definition: {}, version, isPlatform: false });
    },
  };
});

const { ScheduleEvaluator } = await import('../ScheduleEvaluator.js');

let redis: RedisType;
const scheduleErrors: string[] = [];

function evaluator() {
  const sqlClient = {
    unsafe: (query: string, params?: unknown[]) => {
      if (query.includes('SET last_error = $1')) scheduleErrors.push(String(params?.[0]));
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  return new ScheduleEvaluator({ redis, sqlClient, db: {} as never, mode: 'observe' });
}

async function fire(
  target: { targetKind: string; targetSystemRole: string | null; targetAgentId: string | null },
  agentVersion: string | null,
): Promise<{ kind: string; disposition?: () => Promise<boolean> }> {
  const ev = evaluator() as unknown as {
    dispatchOne(row: unknown): Promise<{ kind: string; disposition?: () => Promise<boolean> }>;
  };
  return ev.dispatchOne({
    dispatch: {
      tenantId: TENANT,
      scheduleId: randomUUID(),
      scheduleName: 'Local PR Shepherd',
      schemaName: 'tenant_test',
      spaceId: SPACE,
      action: 'start_run',
      ...target,
      agentVersion,
      targetSessionId: null,
      targetStepExecutionId: null,
      resolvedInput: { input: 'tend' },
      firingCount: 1,
      idempotencyKey: `schedule-${randomUUID()}`,
      creatorUserId: CREATOR,
      creatorTenantRole: 'admin',
      creatorSpaceRole: 'editor',
    },
  });
}

const shepherd = { targetKind: 'custom-agent', targetSystemRole: null, targetAgentId: AGENT };

async function startedVersions(): Promise<string[]> {
  const versions: string[] = [];
  for (let shard = 0; shard < 128; shard++) {
    const entries = await redis.xrange(StreamKeys.shardControlStream(shard), '-', '+');
    for (const [, fields] of entries as Array<[string, string[]]>) {
      const message: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) message[fields[i]!] = fields[i + 1]!;
      if (message['type'] === 'start_run') versions.push(String(message['agentVersion']));
    }
  }
  return versions;
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as RedisType;
  await redis.flushall();
  published.versions = ['1', '2'];
  published.archived = false;
  published.requested.length = 0;
  scheduleErrors.length = 0;
});

describe('a schedule starts the agent version it pins, or the latest published one', () => {
  it('a schedule with no version starts the latest published version', async () => {
    expect((await fire(shepherd, null)).kind).toBe('completed');

    expect(await startedVersions()).toEqual(['2']);
    expect(published.requested).toEqual(['latest']);
  });

  it('a schedule pinned to "1" keeps starting version 1', async () => {
    expect((await fire(shepherd, '1')).kind).toBe('completed');

    expect(await startedVersions()).toEqual(['1']);
    expect(published.requested).toEqual([]);
  });

  it('the latest is read at each firing, so a republished agent reaches its schedule', async () => {
    published.versions = ['1'];
    await fire(shepherd, null);
    expect(await startedVersions()).toEqual(['1']);

    published.versions = ['1', '2'];
    await fire(shepherd, null);
    // Runs land on different shards, so the streams say which, not in what order.
    expect((await startedVersions()).sort()).toEqual(['1', '2']);
  });

  it('a platform role starts version 1 without a lookup', async () => {
    await fire(
      { targetKind: 'platform-role', targetSystemRole: 'helmsman', targetAgentId: null },
      null,
    );

    expect(await startedVersions()).toEqual(['1']);
    expect(published.requested).toEqual([]);
  });

  it('an archived agent starts nothing, and the schedule says why', async () => {
    published.archived = true;

    const outcome = await fire(shepherd, null);

    expect(outcome.kind).toBe('unworkable');
    expect(await outcome.disposition?.()).toBe(true);
    expect(await startedVersions()).toEqual([]);
    expect(scheduleErrors).toEqual([expect.stringContaining('is archived')]);
  });
});
