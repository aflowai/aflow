/**
 * A schedule that pins no version starts the agent's latest published one,
 * and every firing hands only config that version declares.
 *
 * The version is chosen when the schedule fires, not when it was written: the
 * agent here has versions 1 and 2, and a schedule with no `agent_version`
 * must start 2 — the version a run started by hand gets — while one pinned to
 * "1" keeps starting 1. Because the version moves with each republish, the
 * config is checked again at each firing: a republish that drops a variable
 * the schedule hands starts nothing and says so on the schedule.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type postgres from 'postgres';
import {
  AgentDefinitionSchema,
  planResidentScheduleInput,
  StreamKeys,
  skillStarterAgentDefinition,
  type AgentDefinition,
  type PersistentAgentTarget,
} from '@aflow/schemas';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const AGENT = 'c0000000-0000-4000-8000-0000000000a1';
const CREATOR = '1eab6e64-861a-4b99-b396-74f35b111dbb';

const published = vi.hoisted(() => ({
  /** The agent's published versions, oldest first. */
  versions: new Map<string, AgentDefinition>(),
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
      const version = requested === 'latest' ? [...published.versions.keys()].at(-1) : requested;
      const definition = version === undefined ? undefined : published.versions.get(version);
      if (version === undefined || !definition) {
        throw new actual.VersionNotFoundError(target.agentId, requested);
      }
      return Promise.resolve({ target, definition, version, isPlatform: false });
    },
  };
});

const board = vi.hoisted(() => ({ actionable: true, reads: vi.fn() }));
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    nextOnPlanBoard: async (ctx: unknown) => {
      board.reads(ctx);
      return {
        ok: true,
        output: { decisions: board.actionable ? [{ answer: { decision: 'continue' } }] : [] },
      };
    },
  };
});

const { ScheduleEvaluator } = await import('../ScheduleEvaluator.js');

function shepherdAgentVersion(scheduleInput: string | undefined): AgentDefinition {
  return AgentDefinitionSchema.parse(
    skillStarterAgentDefinition({
      slug: 'local-pr-shepherd',
      catalogId: 'local-pr-shepherd',
      name: 'Local PR Shepherd',
      description: 'Starts a pass.',
      folderInput: 'bindingId',
      ...(scheduleInput !== undefined ? { scheduleInput } : {}),
      folders: ['hb_aflow'],
    }),
  );
}
const withoutScheduleId = shepherdAgentVersion(undefined);
const withScheduleId = shepherdAgentVersion('scheduleId');

/** The shepherd's firing input: the schedule's template with `$schedule.id` resolved. */
const handsScheduleId = {
  input: 'tend',
  config: { scheduleId: '5247eee7-0000-4000-8000-000000000001' },
};

let redis: RedisType;
const scheduleErrors: string[] = [];
let residentTemplate: unknown;

function evaluator() {
  const sqlClient = {
    unsafe: (query: string, params?: unknown[]) => {
      if (query.includes('SELECT target_kind, target_system_role, input_template')) {
        return Promise.resolve(
          residentTemplate
            ? [
                {
                  target_kind: 'platform-role',
                  target_system_role: 'cybernetic-helmsman',
                  input_template: residentTemplate,
                },
              ]
            : [],
        );
      }
      if (query.includes('SET last_error = $1')) scheduleErrors.push(String(params?.[0]));
      return Promise.resolve([]);
    },
  } as unknown as postgres.Sql;
  return new ScheduleEvaluator({ redis, sqlClient, db: {} as never, mode: 'observe' });
}

type Outcome = { kind: string; disposition?: () => Promise<boolean> };

async function fire(
  target: { targetKind: string; targetSystemRole: string | null; targetAgentId: string | null },
  agentVersion: string | null,
  resolvedInput: Record<string, unknown> = { input: 'tend' },
  event = false,
): Promise<Outcome> {
  const ev = evaluator() as unknown as { dispatchOne(row: unknown): Promise<Outcome> };
  const scheduleId = randomUUID();
  return ev.dispatchOne({
    dispatch: {
      tenantId: TENANT,
      scheduleId,
      scheduleName: 'Local PR Shepherd',
      schemaName: 'tenant_test',
      spaceId: SPACE,
      action: 'start_run',
      ...target,
      agentVersion,
      targetSessionId: null,
      targetStepExecutionId: null,
      resolvedInput,
      firingCount: 1,
      idempotencyKey: event
        ? `schedule:${scheduleId}:wake:${randomUUID()}`
        : `schedule-${randomUUID()}`,
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

/** A firing that starts nothing retires its occurrence and leaves the reason on the schedule. */
async function expectSkipped(outcome: Outcome): Promise<void> {
  expect(outcome.kind).toBe('unworkable');
  expect(await outcome.disposition?.()).toBe(true);
  expect(await startedVersions()).toEqual([]);
  expect(scheduleErrors).toHaveLength(1);
}

beforeEach(async () => {
  board.actionable = true;
  board.reads.mockClear();
  residentTemplate = undefined;
  redis = new RedisMock() as unknown as RedisType;
  await redis.flushall();
  published.versions = new Map([
    ['1', withoutScheduleId],
    ['2', withScheduleId],
  ]);
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
    expect(published.requested).toEqual(['1']);
  });

  it('the latest is read at each firing, so a republished agent reaches its schedule', async () => {
    published.versions = new Map([['1', withoutScheduleId]]);
    await fire(shepherd, null);
    expect(await startedVersions()).toEqual(['1']);

    published.versions = new Map([
      ['1', withoutScheduleId],
      ['2', withScheduleId],
    ]);
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

    await expectSkipped(await fire(shepherd, null));
    expect(scheduleErrors[0]).toContain('is archived');
  });

  it('a pinned version the agent no longer has starts nothing, and the schedule says why', async () => {
    await expectSkipped(await fire(shepherd, '9'));
    expect(scheduleErrors[0]).toContain('no version "9"');
  });
});

describe('each firing hands only config the version it starts declares', () => {
  it('the latest declares the config the firing hands: the run starts', async () => {
    expect((await fire(shepherd, null, handsScheduleId)).kind).toBe('completed');

    expect(await startedVersions()).toEqual(['2']);
    expect(scheduleErrors).toEqual([]);
  });

  it('a republish that drops a variable the schedule hands: the firing starts nothing and says why', async () => {
    published.versions = new Map([
      ['1', withoutScheduleId],
      ['2', withScheduleId],
      ['3', withoutScheduleId],
    ]);

    await expectSkipped(await fire(shepherd, null, handsScheduleId));
    expect(scheduleErrors[0]).toContain('config.scheduleId');
    expect(scheduleErrors[0]).toContain('version "3", its latest published version');
    expect(scheduleErrors[0]).toContain('This firing was skipped.');
  });

  it('a schedule pinned to a version that lacks the config: the firing starts nothing', async () => {
    await expectSkipped(await fire(shepherd, '1', handsScheduleId));
    expect(scheduleErrors[0]).toContain('version "1", which this schedule pins');
  });
});

it.each([true, false])(
  'carries resident identity from the stored schedule, never resolved input (%s)',
  async (resident) => {
    residentTemplate = resident ? planResidentScheduleInput() : { input: 'wake' };
    const outcome = await fire(
      {
        targetKind: 'platform-role',
        targetSystemRole: 'cybernetic-helmsman',
        targetAgentId: null,
      },
      null,
      { input: 'wake', config: { scheduleId: '5247eee7-0000-4000-8000-000000000001' } },
    );
    expect(outcome.kind).toBe('completed');
    const messages: Record<string, string>[] = [];
    for (let shard = 0; shard < 128; shard++) {
      const entries = await redis.xrange(StreamKeys.shardControlStream(shard), '-', '+');
      for (const [, fields] of entries as Array<[string, string[]]>) {
        const message: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) message[fields[i]!] = fields[i + 1]!;
        if (message['type'] === 'start_run') messages.push(message);
      }
    }
    expect(messages).toHaveLength(1);
    if (resident) {
      expect(messages[0]?.['residentScheduleId']).toMatch(/^[0-9a-f-]{36}$/);
      expect(messages[0]?.['residentScheduleId']).not.toBe('5247eee7-0000-4000-8000-000000000001');
    } else expect(messages[0]?.['residentScheduleId']).toBeUndefined();
  },
);

describe('resident due check', () => {
  const resident = {
    targetKind: 'platform-role',
    targetSystemRole: 'cybernetic-helmsman',
    targetAgentId: null,
  };

  it('spends no model tokens over a day of wait occurrences, then answers the first event', async () => {
    residentTemplate = planResidentScheduleInput();
    board.actionable = false;
    for (let tick = 0; tick < 96; tick++) await fire(resident, null);
    expect(await startedVersions()).toEqual([]);
    expect(board.reads).toHaveBeenCalledTimes(96);
    expect(board.reads).toHaveBeenLastCalledWith(
      expect.objectContaining({ preview: true, spaceId: SPACE }),
    );
    await redis.set(`plan:resident:pending:${TENANT}:${SPACE}`, '1');
    await fire(resident, null);
    expect(await startedVersions()).toEqual(['1']);
  });

  it('starts a run for a non-wait board decision', async () => {
    residentTemplate = planResidentScheduleInput();
    await fire(resident, null);
    expect(await startedVersions()).toEqual(['1']);
  });
});

it('starts an event occurrence while the board waits', async () => {
  residentTemplate = planResidentScheduleInput();
  board.actionable = false;
  await fire(
    { targetKind: 'platform-role', targetSystemRole: 'cybernetic-helmsman', targetAgentId: null },
    null,
    { input: 'wake' },
    true,
  );
  expect(await startedVersions()).toEqual(['1']);
});

it('never discovers resident candidates by enumerating spaces', () => {
  for (const file of [
    '../ScheduleEvaluator.ts',
    '../residentDueCheck.ts',
    '../../../../../packages/cybernetic-runtime/src/plan/resident.ts',
    '../../../../../packages/server-runtime/src/routes/plan.ts',
    '../../../../../packages/server-runtime/src/services/actionCenter/sources/planAskSource.ts',
    '../../../../../packages/server-runtime/src/services/actionCenter/sources/planDecisionSource.ts',
    '../cybernetic/harness/planLinks.ts',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/listSpaces|space_list|\.from\(spaces\)|redis\.(?:scan|keys)\(/);
    const spaceReads = source.match(/FROM[^;\n]*\.spaces[^;\n]*/g) ?? [];
    for (const read of spaceReads) expect(read).toMatch(/WHERE id =/);
  }
});
