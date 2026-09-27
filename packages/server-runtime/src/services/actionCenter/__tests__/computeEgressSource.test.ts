import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCenterContext } from '../types.js';
import { ActionCenterResolveError } from '../types.js';
import { createComputeEgressSource } from '../sources/computeEgressSource.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-0000-0000-000000000002';
const OTHER_SPACE_ID = '00000000-0000-0000-0000-000000000003';
const ADMIN_ID = '00000000-0000-0000-0000-000000000004';
const EDITOR_ID = '00000000-0000-0000-0000-000000000005';
const REQUEST_ID = '00000000-0000-0000-0000-000000000099';

interface Row {
  requestId: string;
  tenantId: string;
  scope: 'tenant' | 'space';
  spaceId: string | null;
  requestedHosts: string[];
  requestedBy: string;
  requestedAt: Date;
  reason: string | null;
  status: 'pending_approval' | 'approved' | 'rejected';
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    requestId: REQUEST_ID,
    tenantId: TENANT_ID,
    scope: 'space',
    spaceId: SPACE_ID,
    requestedHosts: ['storage.googleapis.com', 'api.openai.com'],
    requestedBy: 'agent:bind-capability',
    requestedAt: new Date('2026-05-23T10:00:00.000Z'),
    reason: 'Kaggle download redirect target',
    status: 'pending_approval',
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  };
}

/**
 * Stubs the drizzle chain to return whatever `selectResult` we set,
 * captures the value passed to `update().set()`, and records the
 * post-update `returning()` result so tests can simulate the
 * race-loss-on-concurrent-resolve case.
 */
interface DbStub {
  selectResult: Row[];
  updateReturns: Row[];
  setCalls: Array<Record<string, unknown>>;
  db: {
    select: () => {
      from: () => {
        where: () => Promise<Row[]>;
      };
    };
    update: () => {
      set: (values: Record<string, unknown>) => {
        where: () => {
          returning: () => Promise<Row[]>;
        };
      };
    };
  };
}

function makeDbStub(initialSelect: Row[] = []): DbStub {
  const stub: DbStub = {
    selectResult: initialSelect,
    updateReturns: [],
    setCalls: [],
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(stub.selectResult),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          stub.setCalls.push(values);
          return {
            where: () => ({
              returning: () => Promise.resolve(stub.updateReturns),
            }),
          };
        },
      }),
    },
  };
  return stub;
}

function ctx(role: 'admin' | 'editor' | 'viewer' = 'admin'): ActionCenterContext {
  return {
    tenantId: TENANT_ID as never,
    spaceId: SPACE_ID,
    actorUserId: role === 'admin' ? ADMIN_ID : EDITOR_ID,
    actorSpaceRole: role,
    actorIsTenantAdmin: role === 'admin',
  };
}

function makeSource(stub: DbStub) {
  return createComputeEgressSource({
    db: stub.db as never,
    redis: {} as never,
    payloadStore: {} as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeEgressSource — listOpen', () => {
  it('maps a pending space-scoped row to an open human_approval ActionCenterItem', async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const items = await src.listOpen(ctx('admin'));
    expect(items).toHaveLength(1);
    const it = items[0]!;
    expect(it.id).toBe(`settings:egress-${REQUEST_ID}`);
    expect(it.kind).toBe('human_approval');
    expect(it.status).toBe('open');
    expect(it.origin).toEqual({
      type: 'settings',
      recordKind: 'egress_request',
      recordId: REQUEST_ID,
      recordVersion: 0,
    });
    expect(it.spaceId).toBe(SPACE_ID);
    // Admin sees approve + reject.
    expect(projectActionCenterItem(ctx('admin'), it).allowedActions).toEqual(['approve', 'reject']);
  });

  it('elevates priority for tenant-scoped requests (they affect everyone)', async () => {
    const stub = makeDbStub([row({ scope: 'tenant', spaceId: null })]);
    const src = makeSource(stub);
    const items = await src.listOpen(ctx('admin'));
    expect(items[0]!.priority).toBe('high');
    expect(items[0]!.title.toLowerCase()).toContain('tenant');
  });

  it("strips actions for non-admin actors (resolverPolicy: ['admin'] only)", async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const items = await src.listOpen(ctx('editor'));
    // Editor is not in candidateResolvers (['admin']), so allowedActions
    // collapses to empty — the AC card renders read-only.
    expect(projectActionCenterItem(ctx('editor'), items[0]!).allowedActions).toEqual([]);
  });
});

describe('computeEgressSource — getById', () => {
  it('returns null for ids without the egress prefix (lets the aggregator probe others)', async () => {
    const stub = makeDbStub([]);
    const src = makeSource(stub);
    const result = await src.getById(ctx(), 'proposal:abc');
    expect(result).toBeNull();
  });

  it("returns null for a 'space'-scoped row visible from a different space", async () => {
    // Visibility leak guard: a row belonging to OTHER_SPACE_ID must
    // not be readable when ctx.spaceId is SPACE_ID.
    const stub = makeDbStub([row({ scope: 'space', spaceId: OTHER_SPACE_ID })]);
    const src = makeSource(stub);
    const result = await src.getById(ctx(), `settings:egress-${REQUEST_ID}`);
    expect(result).toBeNull();
  });

  it("returns 'tenant'-scoped rows from any space", async () => {
    const stub = makeDbStub([row({ scope: 'tenant', spaceId: null })]);
    const src = makeSource(stub);
    const result = await src.getById(ctx(), `settings:egress-${REQUEST_ID}`);
    expect(result).not.toBeNull();
    expect(result!.origin.type).toBe('settings');
  });
});

describe('computeEgressSource — resolve', () => {
  it("refuses resolutions other than approve / reject (egress doesn't use submit/ratify/dismiss)", async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;
    await expect(src.resolve(ctx('admin'), item, { kind: 'submit', payload: {} })).rejects.toThrow(
      ActionCenterResolveError,
    );
  });

  it('writes status=approved + reviewedBy + reviewedAt on approve', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    stub.updateReturns = [{ ...target, status: 'approved', reviewedBy: ADMIN_ID }];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    const outcome = await src.resolve(ctx('admin'), item, { kind: 'approve' });
    expect(outcome.dispatchedOperationId).toBe('tenant.egress_requests.patch');
    expect(stub.setCalls).toHaveLength(1);
    const setArgs = stub.setCalls[0]!;
    expect(setArgs['status']).toBe('approved');
    expect(setArgs['reviewedBy']).toBe(ADMIN_ID);
    expect(setArgs['reviewedAt']).toBeInstanceOf(Date);
  });

  it('writes status=rejected on reject', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    stub.updateReturns = [{ ...target, status: 'rejected', reviewedBy: ADMIN_ID }];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    await src.resolve(ctx('admin'), item, { kind: 'reject' });
    expect(stub.setCalls[0]!['status']).toBe('rejected');
  });

  it('throws STALE_ACTION_CENTER_ITEM when the row is already non-pending', async () => {
    const target = row({ status: 'approved', reviewedBy: 'someone-else' });
    const stub = makeDbStub([target]);
    const src = makeSource(stub);
    // Synthesize an item that BELIEVES the row is pending (the AC fold
    // raced a backend update). The resolve path's re-read picks up the
    // real status and rejects.
    const staleItem = {
      ...(await src.getById(ctx(), `settings:egress-${REQUEST_ID}`))!,
    };
    staleItem.status = 'open';
    staleItem.origin = { ...staleItem.origin, recordVersion: 0 } as typeof staleItem.origin;

    let err: unknown;
    try {
      await src.resolve(ctx('admin'), staleItem, { kind: 'approve' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect((err as ActionCenterResolveError).code).toBe('STALE_ACTION_CENTER_ITEM');
    expect((err as ActionCenterResolveError).latestItem).toBeDefined();
  });

  it('throws STALE when the UPDATE returns 0 rows (race-loss between SELECT and UPDATE)', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    // Initial SELECT sees pending; UPDATE returns empty (concurrent
    // resolver flipped the row out from under us).
    stub.updateReturns = [];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    // Re-read after race-loss returns the now-approved row.
    stub.selectResult = [{ ...target, status: 'approved', reviewedBy: 'someone-else' }];

    let err: unknown;
    try {
      await src.resolve(ctx('admin'), item, { kind: 'approve' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect((err as ActionCenterResolveError).code).toBe('STALE_ACTION_CENTER_ITEM');
  });
});
