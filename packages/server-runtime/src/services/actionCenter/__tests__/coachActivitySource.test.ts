import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aflow/database', () => ({
  coachActivity: { __token: 'coach_activity' },
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (..._args: unknown[]) => ({ __op: 'and' }),
  desc: (..._args: unknown[]) => ({ __op: 'desc' }),
  eq: (..._args: unknown[]) => ({ __op: 'eq' }),
  inArray: (..._args: unknown[]) => ({ __op: 'inArray' }),
}));

import { createCoachActivitySource } from '../sources/coachActivitySource.js';
import { withTenantSchema } from '@aflow/database';
import { ActionCenterResolveError, type ActionCenterContext } from '../types.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-0000-0000-000000000002';
const ACTIVITY_ID = '00000000-0000-0000-0000-000000000099';
const COACH_SESSION_ID = '00000000-0000-0000-0000-000000000077';

function ctx(): ActionCenterContext {
  return {
    tenantId: TENANT_ID as never,
    spaceId: SPACE_ID,
    actorUserId: '00000000-0000-0000-0000-000000000004',
    actorSpaceRole: 'admin',
    actorIsTenantAdmin: true,
  };
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ACTIVITY_ID,
    spaceId: SPACE_ID,
    coachSessionId: COACH_SESSION_ID,
    skillSlug: 'optimize-x',
    triggerKind: 'eval_signal',
    triggerCause: 'regression detected',
    outcome: 'silent',
    status: 'completed',
    proposalCount: 0,
    observationCount: 0,
    learningCount: 0,
    previewFailedCount: 0,
    bypassesGate: false,
    costCents: null,
    durationMs: 4321,
    contextDocPath: `/coach/contexts/${COACH_SESSION_ID}.json`,
    factsDocPath: `/coach/facts/${COACH_SESSION_ID}.json`,
    rationale: 'Coach found no actionable signal.',
    createdAt: new Date('2026-05-27T10:00:00.000Z'),
    ...overrides,
  };
}

function makeSource() {
  return createCoachActivitySource({
    db: {} as never,
    redis: {} as never,
    payloadStore: {} as never,
  });
}

beforeEach(() => {
  vi.mocked(withTenantSchema).mockReset();
});

describe('coachActivitySource — listOpen', () => {
  it('maps a silent row into a read-only ActionCenterItem', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([row()]);
    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.id).toBe(`coach-activity:${ACTIVITY_ID}`);
    expect(it.kind).toBe('coach_activity');
    expect(projectActionCenterItem(ctx(), it).allowedActions).toEqual([]);
    expect(it.status).toBe('open');
    expect(it.origin).toEqual({
      type: 'coach_activity',
      activityId: ACTIVITY_ID,
      outcome: 'silent',
      createdAt: '2026-05-27T10:00:00.000Z',
    });
    expect(it.title).toContain('silent');
    expect(it.title).toContain('optimize-x');
    expect(it.summary).toContain('trigger=eval_signal');
  });

  it('maps a suppressed:rate_cap row with no skillSlug', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([
      row({
        skillSlug: null,
        coachSessionId: null,
        triggerKind: 'directive_sampled',
        triggerCause: 'sampling policy: sampled (rate=0.200)',
        outcome: 'suppressed',
        status: 'suppressed:rate_cap',
      }),
    ]);
    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.title).toBe('Coach suppressed');
    expect(it.summary).toContain('status=suppressed:rate_cap');
    expect(it.requestedBy.sessionId).toBeUndefined();
  });

  it('returns an empty list when no rows match', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([]);
    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(0);
  });
});

describe('coachActivitySource — getById', () => {
  it('returns null for ids without the coach-activity prefix', async () => {
    const item = await makeSource().getById(ctx(), `proposal:${ACTIVITY_ID}`);
    expect(item).toBeNull();
    expect(withTenantSchema).not.toHaveBeenCalled();
  });

  it('returns the row when found', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([row()]);
    const item = await makeSource().getById(ctx(), `coach-activity:${ACTIVITY_ID}`);
    expect(item).not.toBeNull();
    expect(item?.id).toBe(`coach-activity:${ACTIVITY_ID}`);
  });

  it('returns null when no row matches', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([]);
    const item = await makeSource().getById(ctx(), `coach-activity:${ACTIVITY_ID}`);
    expect(item).toBeNull();
  });

  it('returns null for with_proposals rows (those belong to coachProposalSource)', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([row({ outcome: 'with_proposals' })]);
    const item = await makeSource().getById(ctx(), `coach-activity:${ACTIVITY_ID}`);
    expect(item).toBeNull();
  });
});

describe('coachActivitySource — resolve', () => {
  it('throws INVALID_RESOLUTION for every kind', async () => {
    const src = makeSource();
    const fakeItem = {} as never;
    await expect(src.resolve(ctx(), fakeItem, { kind: 'approve' } as never)).rejects.toBeInstanceOf(
      ActionCenterResolveError,
    );
    await expect(src.resolve(ctx(), fakeItem, { kind: 'ratify' } as never)).rejects.toBeInstanceOf(
      ActionCenterResolveError,
    );
    await expect(src.resolve(ctx(), fakeItem, { kind: 'dismiss' } as never)).rejects.toMatchObject({
      code: 'INVALID_RESOLUTION',
    });
  });
});
