/**
 * agent.schedule.create refuses config the agent version it will start does
 * not declare — checked against the pinned version, or the latest published
 * one — instead of arming a schedule whose every firing drops it.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  AgentDefinitionSchema,
  StepResultMessageSchema,
  skillStarterAgentDefinition,
  type AgentDefinition,
  type IdempotencyKey,
  type PersistentAgentTarget,
  type SessionId,
  type StepDefinition,
  type StepExecutionId,
  type StepResultMessage,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import { setRunAccessGrant } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { InlineHandlerArgs } from '../types.js';
import type { FlowExecutionContext } from '../../../types.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const AGENT = 'c0000000-0000-4000-8000-0000000000a1';
const CREATOR = '1eab6e64-861a-4b99-b396-74f35b111dbb';

const harness = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  /** The agent's published versions, oldest first. */
  versions: new Map<string, AgentDefinition>(),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        harness.inserts.push(values);
        return {
          returning: () =>
            Promise.resolve([
              {
                id: randomUUID(),
                name: values['name'],
                kind: values['kind'],
                status: values['status'],
                maxFirings: values['maxFirings'],
                nextFireAt: values['nextFireAt'],
                expiresAt: values['expiresAt'],
                createdAt: new Date(),
              },
            ]),
        };
      },
    }),
  };
  return {
    ...actual,
    getDatabase: () => ({}),
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
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

const { handleScheduleCrudInline } = await import('../scheduleCrud.js');

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

function shepherdSchedule(flowVersion?: string): Record<string, unknown> {
  return {
    name: 'Local PR Shepherd',
    action: 'start_run',
    target: { kind: 'custom-agent', agentId: AGENT },
    cron: '*/5 * * * *',
    input: { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
    ...(flowVersion !== undefined ? { flowVersion } : {}),
  };
}

async function create(redis: Redis, input: Record<string, unknown>): Promise<StepResultMessage> {
  const runId = randomUUID() as SessionId;
  await setRunAccessGrant(redis, TENANT, runId, {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: CREATOR,
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
  });
  const context: FlowExecutionContext = {
    tenantId: TENANT,
    runId,
    agentDefinition: { metadata: { custom: {} } } as never,
    traceId: 'trace-sched' as TraceId,
    spaceId: SPACE,
  };
  const args: InlineHandlerArgs = {
    redis,
    payloadStore: {
      retrieve: () => Promise.resolve(input),
      shouldStore: () => false,
    } as unknown as PayloadStore,
    context,
    stepDef: {
      stepId: 'create-schedule',
      stepType: 'agent',
      operation: 'agent.schedule.create',
      config: {},
    } as unknown as StepDefinition,
    stepExecutionId: randomUUID() as StepExecutionId,
    idempotencyKey: `idem-${randomUUID()}` as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };

  await handleScheduleCrudInline(args);

  const results: StepResultMessage[] = [];
  for (const key of (await redis.keys('aflow:shard:*:results')) as string[]) {
    const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    for (const [, fields] of entries) {
      const fieldObj: Record<string, unknown> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const k = fields[i]!;
        const v = fields[i + 1]!;
        try {
          fieldObj[k] = JSON.parse(v);
        } catch {
          fieldObj[k] = v;
        }
      }
      results.push(StepResultMessageSchema.parse(fieldObj));
    }
  }
  expect(results).toHaveLength(1);
  return results[0]!;
}

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  harness.inserts.length = 0;
  harness.versions = new Map([
    ['1', withoutScheduleId],
    ['2', withScheduleId],
  ]);
});

describe('agent.schedule.create checks config against the version the schedule starts', () => {
  it('unpinned, the latest published version declares scheduleId: the schedule is created', async () => {
    const result = await create(redis, shepherdSchedule());

    expect(result.status).toBe('SUCCEEDED');
    expect(harness.inserts).toHaveLength(1);
    expect(harness.inserts[0]?.['agentVersion']).toBeNull();
  });

  it('unpinned, the latest published version lacks scheduleId: refused, naming both', async () => {
    harness.versions = new Map([['1', withoutScheduleId]]);

    const result = await create(redis, shepherdSchedule());

    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('SCHEDULE_CONFIG_NOT_DECLARED');
    expect(result.error?.message).toContain('config.scheduleId');
    expect(result.error?.message).toContain('version "1"');
    expect(result.error?.message).toContain('latest published version');
    expect(harness.inserts).toHaveLength(0);
  });

  it('pinned to a version that lacks scheduleId: refused, though a later version has it', async () => {
    const result = await create(redis, shepherdSchedule('1'));

    expect(result.error?.code).toBe('SCHEDULE_CONFIG_NOT_DECLARED');
    expect(result.error?.message).toContain('config.scheduleId');
    expect(result.error?.message).toContain('version "1", which flowVersion pins');
    expect(harness.inserts).toHaveLength(0);
  });

  it('pinned to a version that declares scheduleId: created with the pin', async () => {
    const result = await create(redis, shepherdSchedule('2'));

    expect(result.status).toBe('SUCCEEDED');
    expect(harness.inserts[0]?.['agentVersion']).toBe('2');
  });

  it('pinned to a version the agent does not have: refused', async () => {
    const result = await create(redis, shepherdSchedule('3'));

    expect(result.error?.code).toBe('SCHEDULE_CONFIG_NOT_DECLARED');
    expect(result.error?.message).toContain('no version "3"');
    expect(harness.inserts).toHaveLength(0);
  });

  it('a schedule that hands no config is not checked against any version', async () => {
    harness.versions = new Map();

    const result = await create(redis, { ...shepherdSchedule(), input: { input: 'tend' } });

    expect(result.status).toBe('SUCCEEDED');
  });
});
