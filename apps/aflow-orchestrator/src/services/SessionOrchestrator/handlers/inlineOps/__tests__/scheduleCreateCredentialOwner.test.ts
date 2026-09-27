import { describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  StepResultMessageSchema,
  type IdempotencyKey,
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

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const STEP_EXEC = 'c0000000-0000-4000-8000-000000000003' as StepExecutionId;
const CREATOR = '1eab6e64-861a-4b99-b396-74f35b111dbb';

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

async function readStepResult(redis: Redis): Promise<StepResultMessage> {
  const keys = (await redis.keys('aflow:shard:*:results')) as string[];
  const results: StepResultMessage[] = [];
  for (const key of keys) {
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
  expect(results).toHaveLength(1);
  return results[0]!;
}

async function freshRedis(): Promise<Redis> {
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one keyspace across instances — isolate each test.
  await redis.flushall();
  return redis;
}

describe('agent.schedule.create — credential owner requirement', () => {
  it('rejects creation with a teaching error when the run has no access grant', async () => {
    const redis = await freshRedis();
    const runId = 'd0000000-0000-4000-8000-000000000004' as SessionId;

    await handleScheduleCrudInline(buildArgs(redis, runId));

    const result = await readStepResult(redis);
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('SCHEDULE_NO_CREDENTIAL_OWNER');
    expect(result.error?.message).toContain('run as their creator');
    expect(dbMock.capturedInserts).toHaveLength(0);
  });

  it('stamps the grant holder as the schedule creator', async () => {
    const redis = await freshRedis();
    const runId = 'd0000000-0000-4000-8000-000000000005' as SessionId;
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

    await handleScheduleCrudInline(buildArgs(redis, runId));

    const result = await readStepResult(redis);
    expect(result.status).toBe('SUCCEEDED');
    expect(dbMock.capturedInserts).toHaveLength(1);
    const inserted = dbMock.capturedInserts[0]!;
    expect(inserted['creatorUserId']).toBe(CREATOR);
    expect(inserted['creatorTenantRole']).toBe('admin');
    expect(inserted['creatorSpaceRole']).toBe('admin');
  });
});
