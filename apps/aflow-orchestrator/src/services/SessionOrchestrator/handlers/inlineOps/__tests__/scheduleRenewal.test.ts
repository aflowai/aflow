import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { AgentScheduleRow, NewAgentScheduleRow } from '@aflow/database';
import {
  AgentDefinitionSchema,
  MAX_FIRINGS_CAP,
  SCHEDULE_RENEWAL_WINDOW,
  StepResultMessageSchema,
  skillStarterAgentDefinition,
  type AgentDefinition,
  type IdempotencyKey,
  type PersistentAgentTarget,
  type RunAccessGrant,
  type SessionId,
  type StepDefinition,
  type StepExecutionId,
  type StepResultMessage,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { ENTITY_EVENTS_STREAM_KEY } from '@aflow/redis';
import type { InlineHandlerArgs } from '../types.js';
import type { FlowExecutionContext } from '../../../types.js';
import type { ScheduleRenewalStore } from '../scheduleRenewal.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const OWNER = '1eab6e64-861a-4b99-b396-74f35b111dbb';
const STRANGER = '2eab6e64-861a-4b99-b396-74f35b111dbc';
const AGENT = 'c0000000-0000-4000-8000-0000000000a1';
const PREDECESSOR = '5247eee7-0000-4000-8000-000000000001';
const RUN = 'e0000000-0000-4000-8000-000000000010';
const ANCHOR_SESSION = 'f0000000-0000-4000-8000-000000000011';

function grantFor(userId: string): RunAccessGrant {
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: userId,
    tenantRole: 'admin',
    spaceRole: 'admin',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    capabilities: {
      allowedCapabilities: [],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    resourceScopes: [],
  };
}

function shepherdSchedule(overrides: Partial<AgentScheduleRow> = {}): AgentScheduleRow {
  const createdAt = new Date('2026-10-24T08:00:00Z');
  return {
    id: PREDECESSOR,
    spaceId: SPACE,
    name: 'Local PR Shepherd',
    description: null,
    action: 'start_run',
    targetKind: 'custom-agent',
    targetSystemRole: null,
    targetAgentId: AGENT,
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
    inputTemplate: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
    status: 'active',
    maxFirings: MAX_FIRINGS_CAP,
    firingCount: 0,
    lastFiredAt: null,
    lastSessionId: null,
    nextFireAt: new Date('2026-10-24T12:05:00Z'),
    expiresAt: new Date('2099-11-23T08:00:00Z'),
    lastError: null,
    createdBy: null,
    createdBySessionId: null,
    metadata: {},
    renewsScheduleId: null,
    originalScheduleId: null,
    creatorUserId: OWNER,
    creatorTenantRole: 'member',
    creatorSpaceRole: 'editor',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const nearCap = MAX_FIRINGS_CAP - SCHEDULE_RENEWAL_WINDOW + 1;
const withHeadroom = MAX_FIRINGS_CAP - SCHEDULE_RENEWAL_WINDOW - 1;

/**
 * The agent_schedules table as a renewal sees it: rows keyed by primary key,
 * an insert that keeps the first row of an id, and every call yielding, so
 * two renewals in flight interleave at each read and write.
 */
function memoryTable(rows: AgentScheduleRow[]) {
  const table = new Map(rows.map((row) => [row.id, { ...row }]));
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const store: ScheduleRenewalStore = {
    async lock(scheduleId, spaceId) {
      await tick();
      const row = table.get(scheduleId);
      return row?.spaceId === spaceId ? { ...row } : undefined;
    },
    async find(scheduleId) {
      await tick();
      const row = table.get(scheduleId);
      return row ? { ...row } : undefined;
    },
    async insertIfAbsent(row: NewAgentScheduleRow & { id: string }) {
      await tick();
      if (table.has(row.id)) return undefined;
      const now = new Date();
      const stored = {
        ...shepherdSchedule(),
        lastFiredAt: null,
        lastSessionId: null,
        ...row,
        createdAt: now,
        updatedAt: now,
      } as AgentScheduleRow;
      table.set(row.id, stored);
      return { ...stored };
    },
    async expireIfActive(scheduleId) {
      await tick();
      const row = table.get(scheduleId);
      if (row?.status === 'active') table.set(scheduleId, { ...row, status: 'expired' });
    },
  };
  return { table, store };
}

const harness = vi.hoisted(() => ({
  store: undefined as ScheduleRenewalStore | undefined,
  anchorGrant: undefined as RunAccessGrant | undefined,
  /** The agent's published versions, oldest first. */
  versions: new Map<string, AgentDefinition>(),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    getDatabase: () => ({}),
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    loadAgentTargetDefinition: (
      _db: unknown,
      _tenantId: string,
      target: PersistentAgentTarget,
      requested = 'latest',
    ) => {
      if (target.kind !== 'custom-agent') throw new Error('only the shepherd is published here');
      const version = requested === 'latest' ? [...harness.versions.keys()].at(-1) : requested;
      const definition = version === undefined ? undefined : harness.versions.get(version);
      if (version === undefined || !definition) {
        throw new actual.VersionNotFoundError(target.agentId, requested);
      }
      return Promise.resolve({ target, definition, version, isPlatform: false });
    },
  };
});

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: (_db: unknown, _tenant: string, _space: string, runId: string) =>
    Promise.resolve(runId === RUN ? { runId, sessionId: ANCHOR_SESSION } : null),
}));

vi.mock('../../../helpers/workflowGrantGate.js', () => ({
  establishRunAccessGrant: ({ sessionId }: { sessionId: string }) =>
    Promise.resolve(
      sessionId === ANCHOR_SESSION && harness.anchorGrant
        ? { kind: 'granted', grant: harness.anchorGrant }
        : { kind: 'ungoverned' },
    ),
}));

vi.mock('../scheduleRenewal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduleRenewal.js')>();
  return {
    ...actual,
    tenantScheduleRenewalStore: () => {
      if (!harness.store) throw new Error('no table under test');
      return harness.store;
    },
  };
});

const { renewSchedule, scheduleSuccessorId } = await import('../scheduleRenewal.js');
const { handleScheduleCrudInline } = await import('../scheduleCrud.js');
const { scheduleConfigProblem } = await import('../scheduleTargetConfig.js');

/** Version 1 of the shepherd agent predates the scheduleId config; version 2 declares it. */
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
harness.versions = new Map([
  ['1', shepherdAgentVersion(undefined)],
  ['2', shepherdAgentVersion('scheduleId')],
]);

const renewal = (grant: RunAccessGrant = grantFor(OWNER)) => ({
  spaceId: SPACE,
  predecessorId: PREDECESSOR,
  grant,
  configProblem: (schedule: Parameters<typeof scheduleConfigProblem>[2]) =>
    scheduleConfigProblem({} as never, TENANT, schedule),
});

describe('renewSchedule: a schedule near its cap is handed to exactly one successor', () => {
  it('near the cap, creates one successor that copies the schedule and takes over from it', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);

    const outcome = await renewSchedule(store, renewal());

    expect(outcome).toMatchObject({ kind: 'renewed', created: true });
    expect(table.size).toBe(2);
    const successor = table.get(scheduleSuccessorId(PREDECESSOR))!;
    expect(successor).toMatchObject({
      status: 'active',
      firingCount: 0,
      maxFirings: MAX_FIRINGS_CAP,
      kind: 'cron',
      cronExpression: '*/5 * * * *',
      targetKind: 'custom-agent',
      targetAgentId: AGENT,
      inputTemplate: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
      expiresAt: new Date('2099-11-23T08:00:00Z'),
      renewsScheduleId: PREDECESSOR,
      originalScheduleId: PREDECESSOR,
    });
    expect(successor.nextFireAt).toBeInstanceOf(Date);
    expect(table.get(PREDECESSOR)?.status).toBe('expired');
  });

  it('a successor carries how its predecessor was created, not the run that renewed it', async () => {
    for (const armedBy of [null, 'a0000000-0000-4000-8000-0000000000c1']) {
      const { table, store } = memoryTable([
        shepherdSchedule({ firingCount: nearCap, createdBySessionId: armedBy, createdBy: 'api' }),
      ]);

      await renewSchedule(store, renewal());

      expect(table.get(scheduleSuccessorId(PREDECESSOR))).toMatchObject({
        createdBySessionId: armedBy,
        createdBy: 'api',
        creatorUserId: OWNER,
        creatorTenantRole: 'member',
        creatorSpaceRole: 'editor',
        renewsScheduleId: PREDECESSOR,
      });
    }
  });

  it("a renewal of a renewal names the chain's first schedule, not its predecessor", async () => {
    const ORIGINAL = 'a0000000-0000-4000-8000-0000000000f0';
    const { table, store } = memoryTable([
      shepherdSchedule({
        firingCount: nearCap,
        renewsScheduleId: ORIGINAL,
        originalScheduleId: ORIGINAL,
      }),
    ]);

    await renewSchedule(store, renewal());

    expect(table.get(scheduleSuccessorId(PREDECESSOR))).toMatchObject({
      renewsScheduleId: PREDECESSOR,
      originalScheduleId: ORIGINAL,
    });
  });

  it('with headroom, creates none and leaves the schedule firing', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: withHeadroom })]);

    const outcome = await renewSchedule(store, renewal());

    expect(outcome.kind).toBe('not_due');
    expect(table.size).toBe(1);
    expect(table.get(PREDECESSOR)?.status).toBe('active');
  });

  it('two overlapping renewals create one successor, and both name it', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);

    const [first, second] = await Promise.all([
      renewSchedule(store, renewal()),
      renewSchedule(store, renewal()),
    ]);

    expect(table.size).toBe(2);
    const successorId = scheduleSuccessorId(PREDECESSOR);
    expect(first).toMatchObject({ kind: 'renewed', successor: { id: successorId } });
    expect(second).toMatchObject({ kind: 'renewed', successor: { id: successorId } });
    expect(
      [first, second].filter((outcome) => outcome.kind === 'renewed' && outcome.created),
    ).toHaveLength(1);
  });

  it('a renewal after the handover returns the successor it already has', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);
    await renewSchedule(store, renewal());

    const again = await renewSchedule(store, renewal());

    expect(again).toMatchObject({
      kind: 'renewed',
      created: false,
      successor: { id: scheduleSuccessorId(PREDECESSOR) },
    });
    expect(table.size).toBe(2);
  });

  it('a schedule its owner paused is not renewed', async () => {
    const { table, store } = memoryTable([
      shepherdSchedule({ firingCount: nearCap, status: 'paused' }),
    ]);

    expect((await renewSchedule(store, renewal())).kind).toBe('not_due');
    expect(table.size).toBe(1);
  });

  it("another user's grant renews nothing: the successor would run as them", async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);

    expect((await renewSchedule(store, renewal(grantFor(STRANGER)))).kind).toBe('not_owner');
    expect(table.size).toBe(1);
    expect(table.get(PREDECESSOR)?.status).toBe('active');
  });

  it('a schedule pinned to a version without its config is not renewed, and keeps firing', async () => {
    const { table, store } = memoryTable([
      shepherdSchedule({ firingCount: nearCap, agentVersion: '1' }),
    ]);

    const outcome = await renewSchedule(store, renewal());

    expect(outcome.kind).toBe('config_refused');
    expect(outcome.kind === 'config_refused' && outcome.message).toContain('config.scheduleId');
    expect(table.size).toBe(1);
    expect(table.get(PREDECESSOR)?.status).toBe('active');
  });

  it('a schedule pinned to a version that declares its config is renewed with the pin', async () => {
    const { table, store } = memoryTable([
      shepherdSchedule({ firingCount: nearCap, agentVersion: '2' }),
    ]);

    expect((await renewSchedule(store, renewal())).kind).toBe('renewed');
    expect(table.get(scheduleSuccessorId(PREDECESSOR))?.agentVersion).toBe('2');
  });
});

// ============================================================================

function taskArgs(redis: Redis, taskId: string): InlineHandlerArgs {
  const context: FlowExecutionContext = {
    tenantId: TENANT,
    runId: randomUUID() as SessionId,
    agentDefinition: {
      flowId: 'workflow-task-inline',
      flowVersion: '1',
      steps: [],
      metadata: { name: '', description: '' },
    } as never,
    traceId: 'trace-renew' as TraceId,
    spaceId: SPACE,
  };
  const payloadStore = {
    retrieve: () => Promise.resolve({ renews: PREDECESSOR }),
    shouldStore: () => false,
  } as unknown as PayloadStore;
  return {
    redis,
    payloadStore,
    context,
    stepDef: {
      stepId: taskId,
      stepType: 'agent',
      operation: 'agent.schedule.create',
      config: {},
    } as unknown as StepDefinition,
    stepExecutionId: randomUUID() as StepExecutionId,
    idempotencyKey: `dispatch:${RUN}:${taskId}:1` as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
    workflowExecution: {
      runId: RUN,
      taskId,
      attempt: 1,
      dispatchAttemptToken: `dispatch:${RUN}:${taskId}:1`,
    },
  };
}

async function stepResults(redis: Redis): Promise<StepResultMessage[]> {
  const results: StepResultMessage[] = [];
  for (const key of (await redis.keys('aflow:shard:*:results')) as string[]) {
    const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    for (const [, fields] of entries) {
      const fieldObj: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const k = fields[i];
        const v = fields[i + 1];
        if (k === undefined || v === undefined) continue;
        try {
          fieldObj[k] = JSON.parse(v);
        } catch {
          fieldObj[k] = v;
        }
      }
      results.push(StepResultMessageSchema.parse(fieldObj));
    }
  }
  return results;
}

describe('agent.schedule.create renews as a workflow task, with the run’s grant', () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    harness.anchorGrant = grantFor(OWNER);
  });

  it('a pass near the cap creates one successor, owned by the run’s user', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);
    harness.store = store;

    await handleScheduleCrudInline(taskArgs(redis, 'renew-schedule'));

    const [result] = await stepResults(redis);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      workflowExecution: { runId: RUN, taskId: 'renew-schedule' },
    });
    expect(table.size).toBe(2);
    expect(table.get(scheduleSuccessorId(PREDECESSOR))?.creatorUserId).toBe(OWNER);
  });

  it('a renewal announces no newly armed trigger', async () => {
    const { store } = memoryTable([
      shepherdSchedule({ firingCount: nearCap, createdBySessionId: ANCHOR_SESSION }),
    ]);
    harness.store = store;

    await handleScheduleCrudInline(taskArgs(redis, 'renew-schedule'));

    expect((await stepResults(redis)).map((result) => result.status)).toEqual(['SUCCEEDED']);
    expect(await redis.xlen(ENTITY_EVENTS_STREAM_KEY(TENANT, SPACE))).toBe(0);
  });

  it('a pass with headroom creates none', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: withHeadroom })]);
    harness.store = store;

    await handleScheduleCrudInline(taskArgs(redis, 'renew-schedule'));

    const [result] = await stepResults(redis);
    expect(result?.status).toBe('FAILED');
    expect(result?.error?.code).toBe('SCHEDULE_RENEWAL_NOT_DUE');
    expect(table.size).toBe(1);
  });

  it('two overlapping passes create one successor between them', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);
    harness.store = store;

    await Promise.all([
      handleScheduleCrudInline(taskArgs(redis, 'renew-schedule-a')),
      handleScheduleCrudInline(taskArgs(redis, 'renew-schedule-b')),
    ]);

    const results = await stepResults(redis);
    expect(results.map((result) => result.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(table.size).toBe(2);
  });

  it('a pass whose schedule pins a version without its config is told which, and renews nothing', async () => {
    const { table, store } = memoryTable([
      shepherdSchedule({ firingCount: nearCap, agentVersion: '1' }),
    ]);
    harness.store = store;

    await handleScheduleCrudInline(taskArgs(redis, 'renew-schedule'));

    const [result] = await stepResults(redis);
    expect(result?.status).toBe('FAILED');
    expect(result?.error?.code).toBe('SCHEDULE_CONFIG_NOT_DECLARED');
    expect(result?.error?.message).toContain('config.scheduleId');
    expect(result?.error?.message).toContain('version "1"');
    expect(table.size).toBe(1);
  });

  it('a run with no user behind it renews nothing', async () => {
    const { table, store } = memoryTable([shepherdSchedule({ firingCount: nearCap })]);
    harness.store = store;
    harness.anchorGrant = undefined;

    await handleScheduleCrudInline(taskArgs(redis, 'renew-schedule'));

    const [result] = await stepResults(redis);
    expect(result?.error?.code).toBe('SCHEDULE_NO_CREDENTIAL_OWNER');
    expect(table.size).toBe(1);
  });
});
