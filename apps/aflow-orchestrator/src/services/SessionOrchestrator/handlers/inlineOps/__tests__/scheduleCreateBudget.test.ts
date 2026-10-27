import { describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  StreamKeys,
  StepResultMessageSchema,
  type IdempotencyKey,
  type SessionId,
  type StepDefinition,
  type StepExecutionId,
  type StepResultMessage,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { InlineHandlerArgs } from '../types.js';
import type { FlowExecutionContext } from '../../../types.js';

const dbMock = vi.hoisted(() => ({
  capturedInserts: [] as Record<string, unknown>[],
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbMock.capturedInserts.push(values);
        return {
          returning: () =>
            Promise.resolve([
              {
                id: 'f0000000-0000-4000-8000-000000000009',
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
  };
});

import { handleScheduleCrudInline } from '../scheduleCrud.js';
import { failRun } from '../../failRun.js';
import {
  MAX_SCHEDULE_CREATES_PER_RUN,
  SCHEDULE_CREATE_COUNT_TTL_SECONDS,
  scheduleCreatesCounted,
} from '../scheduleCreateBudget.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const STEP_EXEC = 'c0000000-0000-4000-8000-000000000003' as StepExecutionId;

function createInput(): Record<string, unknown> {
  return {
    input: { note: 'daily' },
    name: 'daily-cycle',
    cron: '0 9 * * *',
    maxFirings: 5,
    timezone: 'UTC',
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
  };
}

function buildArgs(redis: Redis, runId: SessionId): InlineHandlerArgs {
  const context: FlowExecutionContext = {
    tenantId: TENANT,
    runId,
    agentDefinition: { metadata: { custom: {} } } as never,
    traceId: 'trace-sched' as TraceId,
    spaceId: SPACE,
  };
  const payloadStore = {
    retrieve: () => Promise.resolve(createInput()),
    shouldStore: () => false,
  } as unknown as PayloadStore;
  return {
    redis,
    payloadStore,
    context,
    stepDef: {
      stepId: 'create-schedule',
      stepType: 'agent',
      operation: 'agent.schedule.create',
      config: {},
    } as unknown as StepDefinition,
    stepExecutionId: STEP_EXEC,
    idempotencyKey: 'idem-sched-1' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

/** Every step result emitted so far, in the order they were written. */
async function stepResults(redis: Redis): Promise<StepResultMessage[]> {
  const keys = (await redis.keys('aflow:shard:*:results')) as string[];
  const results: Array<{ id: string; result: StepResultMessage }> = [];
  for (const key of keys) {
    const entries = (await redis.xrange(key, '-', '+')) as Array<[string, string[]]>;
    for (const [id, fields] of entries) {
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
      results.push({ id, result: StepResultMessageSchema.parse(fieldObj) });
    }
  }
  const order = (id: string): [number, number] => {
    const [ms = '0', seq = '0'] = id.split('-');
    return [Number(ms), Number(seq)];
  };
  return results
    .sort((a, b) => {
      const [aMs, aSeq] = order(a.id);
      const [bMs, bSeq] = order(b.id);
      return aMs - bMs || aSeq - bSeq;
    })
    .map((entry) => entry.result);
}

async function freshRedis(): Promise<Redis> {
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one keyspace across instances — isolate each test.
  await redis.flushall();
  return redis;
}

function sessionId(n: number): SessionId {
  return `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}` as SessionId;
}

const WORKFLOW_RUN = 'e0000000-0000-4000-8000-000000000001';

/** A worker session serving a task of `runId`, as its hot state records the task. */
async function serves(redis: Redis, session: SessionId, runId: string, taskId: string) {
  await redis.hset(
    StreamKeys.sessionStateKey(TENANT, session),
    'workflowExecution',
    JSON.stringify({ runId, taskId, attempt: 1 }),
  );
}

/** Creates one schedule from `session`, and returns the code it was refused with, if any. */
async function create(redis: Redis, session: SessionId): Promise<string | undefined> {
  const before = (await stepResults(redis)).length;
  await handleScheduleCrudInline(buildArgs(redis, session));
  const results = await stepResults(redis);
  expect(results).toHaveLength(before + 1);
  return results.at(-1)?.error?.code;
}

describe('agent.schedule.create — the per-run limit', () => {
  it('counts every task of a workflow run against the workflow run, not each task', async () => {
    const redis = await freshRedis();
    for (let task = 0; task <= MAX_SCHEDULE_CREATES_PER_RUN; task += 1) {
      await serves(redis, sessionId(100 + task), WORKFLOW_RUN, `task-${String(task)}`);
    }

    // Each task has a worker session of its own, and creates once from it.
    for (let task = 0; task < MAX_SCHEDULE_CREATES_PER_RUN; task += 1) {
      expect(await create(redis, sessionId(100 + task))).not.toBe('SCHEDULE_RATE_LIMIT');
    }
    expect(await scheduleCreatesCounted(redis, TENANT, WORKFLOW_RUN)).toBe(
      MAX_SCHEDULE_CREATES_PER_RUN,
    );
    expect(await scheduleCreatesCounted(redis, TENANT, sessionId(100))).toBeUndefined();

    // A further task of the same workflow run finds the run's budget spent.
    expect(await create(redis, sessionId(100 + MAX_SCHEDULE_CREATES_PER_RUN))).toBe(
      'SCHEDULE_RATE_LIMIT',
    );

    // A direct run counts against itself, untouched by the workflow run's count.
    expect(await create(redis, sessionId(200))).not.toBe('SCHEDULE_RATE_LIMIT');
    expect(await scheduleCreatesCounted(redis, TENANT, sessionId(200))).toBe(1);
  });

  it('leaves no count behind for a direct run that reached a terminal state', async () => {
    const redis = await freshRedis();
    const run = sessionId(300);
    for (let n = 0; n < MAX_SCHEDULE_CREATES_PER_RUN; n += 1) await create(redis, run);
    expect(await create(redis, run)).toBe('SCHEDULE_RATE_LIMIT');

    await failRun(redis, TENANT, run, 'TEST_FAILED', 'The run failed.');

    expect(await scheduleCreatesCounted(redis, TENANT, run)).toBeUndefined();
  });

  // Two orchestrator processes are two clients of one Redis; ioredis-mock
  // instances share one keyspace, as they would.
  it("shares a workflow run's count between the processes serving its tasks", async () => {
    const first = await freshRedis();
    const second = new RedisMock() as unknown as Redis;
    for (let task = 0; task <= MAX_SCHEDULE_CREATES_PER_RUN; task += 1) {
      await serves(first, sessionId(400 + task), WORKFLOW_RUN, `task-${String(task)}`);
    }
    for (let task = 0; task < MAX_SCHEDULE_CREATES_PER_RUN; task += 1) {
      const process = task % 2 === 0 ? first : second;
      expect(await create(process, sessionId(400 + task))).not.toBe('SCHEDULE_RATE_LIMIT');
    }
    expect(await create(second, sessionId(400 + MAX_SCHEDULE_CREATES_PER_RUN))).toBe(
      'SCHEDULE_RATE_LIMIT',
    );
  });

  it('is released by whichever process ends the run, for every process', async () => {
    const first = await freshRedis();
    const second = new RedisMock() as unknown as Redis;
    const run = sessionId(500);
    for (let n = 0; n < MAX_SCHEDULE_CREATES_PER_RUN; n += 1) await create(first, run);

    await failRun(second, TENANT, run, 'TEST_FAILED', 'The run failed.');

    expect(await scheduleCreatesCounted(first, TENANT, run)).toBeUndefined();
  });

  it('lets a count whose release was lost expire rather than stay', async () => {
    const redis = await freshRedis();
    await create(redis, sessionId(600));
    const ttl = await redis.ttl(StreamKeys.scheduleCreateCountKey(TENANT, sessionId(600)));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SCHEDULE_CREATE_COUNT_TTL_SECONDS);
  });
});
