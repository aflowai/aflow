import { describe, expect, it, vi } from 'vitest';
import type { AgentScheduleRow } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import type { ActionCenterContext, ActionCenterSourceDeps } from '../types.js';

const table = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => Promise.resolve(table.rows),
    limit: () => Promise.resolve(table.rows),
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: () => query }),
  };
});

const { createTriggerArmedSource } = await import('./triggerArmedSource.js');

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const SPACE = 'b0000000-0000-4000-8000-000000000002';
const ARMING_SESSION = 'f0000000-0000-4000-8000-000000000011';
const ORIGINAL = '5247eee7-0000-4000-8000-000000000001';
const SUCCESSOR = '6247eee7-0000-4000-8000-000000000002';

function schedule(id: string, overrides: Partial<AgentScheduleRow>): AgentScheduleRow {
  const at = new Date();
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
    nextFireAt: null,
    expiresAt: null,
    lastError: null,
    createdBy: null,
    createdBySessionId: ARMING_SESSION,
    metadata: {},
    renewsScheduleId: null,
    creatorUserId: null,
    creatorTenantRole: null,
    creatorSpaceRole: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const armed = schedule(ORIGINAL, {});
const renewal = schedule(SUCCESSOR, { renewsScheduleId: ORIGINAL });
const source = createTriggerArmedSource({} as ActionCenterSourceDeps);
const ctx = { tenantId: TENANT, spaceId: SPACE } as ActionCenterContext;

describe('a renewal is not news of an arming', () => {
  it('lists the schedule armed in chat and not its renewal', async () => {
    table.rows = [renewal, armed];
    const items = await source.listOpen({ tenantId: TENANT, spaceId: SPACE });
    expect(items.map((item) => item.id)).toEqual([`trigger-armed:${ORIGINAL}`]);
  });

  it('lists neither a schedule the operator made nor a deleted or aged-out one', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    table.rows = [
      schedule(ORIGINAL, { createdBySessionId: null }),
      schedule(ORIGINAL, { status: 'deleted' }),
      schedule(ORIGINAL, { createdAt: old }),
    ];
    expect(await source.listOpen({ tenantId: TENANT, spaceId: SPACE })).toEqual([]);
  });

  it('finds no item for a renewal by its id', async () => {
    table.rows = [renewal];
    expect(await source.getById(ctx, `trigger-armed:${SUCCESSOR}`)).toBeNull();
    table.rows = [armed];
    expect(await source.getById(ctx, `trigger-armed:${ORIGINAL}`)).not.toBeNull();
  });
});
