import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCenterContext } from '../types.js';
import { ActionCenterResolveError } from '../types.js';
import { createIntegrationHostRequestSource } from '../sources/integrationHostRequestSource.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-0000-0000-000000000002';
const ADMIN_ID = '00000000-0000-0000-0000-000000000004';
const EDITOR_ID = '00000000-0000-0000-0000-000000000005';
const REQUEST_ID = '00000000-0000-0000-0000-000000000099';

interface Row {
  requestId: string;
  tenantId: string;
  scope: string;
  spaceId: string | null;
  requestedHosts: string[];
  requestedBy: string;
  requestedAt: Date;
  reason: string | null;
  status: 'pending_approval' | 'approved' | 'rejected';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  integrationKind: string | null;
  reviewNote: string | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    requestId: REQUEST_ID,
    tenantId: TENANT_ID,
    scope: 'integration',
    spaceId: SPACE_ID,
    requestedHosts: ['api.example.com'],
    requestedBy: 'agent:helmsman',
    requestedAt: new Date('2026-05-23T10:00:00.000Z'),
    reason: 'Weather data for the briefing skill',
    status: 'pending_approval',
    reviewedBy: null,
    reviewedAt: null,
    integrationKind: 'api',
    reviewNote: null,
    ...overrides,
  };
}

interface DbStub {
  selectResult: Row[];
  updateReturns: Row[];
  setCalls: Array<Record<string, unknown>>;
  insertedValues: Array<Record<string, unknown>>;
  db: Record<string, unknown>;
}

function makeDbStub(initialSelect: Row[] = []): DbStub {
  const stub: DbStub = {
    selectResult: initialSelect,
    updateReturns: [],
    setCalls: [],
    insertedValues: [],
    db: {},
  };
  const chain = {
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
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        stub.insertedValues.push(values);
        return { onConflictDoNothing: () => Promise.resolve([]) };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(chain),
  };
  stub.db = chain as unknown as Record<string, unknown>;
  return stub;
}

function ctx(
  role: 'admin' | 'editor' = 'admin',
  opts: { tenantAdmin?: boolean } = {},
): ActionCenterContext {
  return {
    tenantId: TENANT_ID as never,
    spaceId: SPACE_ID,
    actorUserId: role === 'admin' ? ADMIN_ID : EDITOR_ID,
    actorSpaceRole: role,
    actorIsTenantAdmin: opts.tenantAdmin ?? role === 'admin',
  };
}

const auditRecord = vi.fn();

function makeSource(stub: DbStub) {
  return createIntegrationHostRequestSource({
    db: stub.db as never,
    redis: {} as never,
    payloadStore: {} as never,
    audit: { record: auditRecord },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('integrationHostRequestSource — listOpen', () => {
  it('maps a pending request to a high-priority human_approval item', async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const items = await src.listOpen(ctx('admin'));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toBe(`settings:integration-host-${REQUEST_ID}`);
    expect(item.kind).toBe('human_approval');
    expect(item.status).toBe('open');
    expect(item.priority).toBe('high');
    expect(item.title).toContain('api.example.com');
    expect(item.origin).toEqual({
      type: 'settings',
      recordKind: 'integration_host_request',
      recordId: REQUEST_ID,
      recordVersion: 0,
    });
    expect(projectActionCenterItem(ctx('admin'), item).allowedActions).toEqual([
      'approve',
      'reject',
    ]);
  });

  it("strips actions for non-admin actors (resolverPolicy: ['admin'] only)", async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const items = await src.listOpen(ctx('editor'));
    expect(projectActionCenterItem(ctx('editor'), items[0]!).allowedActions).toEqual([]);
  });

  it('strips actions for a space admin who is not a tenant admin', async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const items = await src.listOpen(ctx('admin', { tenantAdmin: false }));
    expect(
      projectActionCenterItem(ctx('admin', { tenantAdmin: false }), items[0]!).allowedActions,
    ).toEqual([]);
  });
});

describe('integrationHostRequestSource — getById', () => {
  it('returns null for ids without the integration-host prefix', async () => {
    const stub = makeDbStub([]);
    const src = makeSource(stub);
    expect(await src.getById(ctx(), `settings:egress-${REQUEST_ID}`)).toBeNull();
  });

  it('resolves by id from any space (grants are tenant-wide)', async () => {
    const stub = makeDbStub([row({ spaceId: '00000000-0000-0000-0000-00000000000f' })]);
    const src = makeSource(stub);
    const item = await src.getById(ctx(), `settings:integration-host-${REQUEST_ID}`);
    expect(item).not.toBeNull();
  });
});

describe('integrationHostRequestSource — resolve', () => {
  it('approve resolves the request AND inserts the allowlist row', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    stub.updateReturns = [{ ...target, status: 'approved', reviewedBy: ADMIN_ID }];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    const outcome = await src.resolve(ctx('admin'), item, { kind: 'approve' });
    expect(outcome.dispatchedOperationId).toBe('tenant.integration_host_requests.patch');
    expect(stub.setCalls[0]!['status']).toBe('approved');
    expect(stub.setCalls[0]!['reviewedBy']).toBe(ADMIN_ID);
    expect(stub.insertedValues).toHaveLength(1);
    expect(stub.insertedValues[0]).toMatchObject({
      tenantId: TENANT_ID,
      kind: 'api',
      hostPattern: 'api.example.com',
      addedBy: ADMIN_ID,
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.integration_host_request.resolve',
        category: 'admin',
        outcome: 'success',
        actor: expect.objectContaining({ userId: ADMIN_ID, tenantId: TENANT_ID }),
        target: expect.objectContaining({
          resourceType: 'integration_host_request',
          resourceId: REQUEST_ID,
        }),
        details: { resolution: 'approved', hostPattern: 'api.example.com' },
      }),
    );
  });

  it('refuses a space admin who is not a tenant admin (fail closed, no audit)', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    stub.updateReturns = [{ ...target, status: 'approved', reviewedBy: ADMIN_ID }];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    let err: unknown;
    try {
      await src.resolve(ctx('admin', { tenantAdmin: false }), item, { kind: 'approve' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect((err as ActionCenterResolveError).code).toBe('FORBIDDEN');
    expect(stub.setCalls).toHaveLength(0);
    expect(stub.insertedValues).toHaveLength(0);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('reject resolves the request WITHOUT touching the allowlist', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    stub.updateReturns = [{ ...target, status: 'rejected', reviewedBy: ADMIN_ID }];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    await src.resolve(ctx('admin'), item, { kind: 'reject' });
    expect(stub.setCalls[0]!['status']).toBe('rejected');
    expect(stub.insertedValues).toHaveLength(0);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.integration_host_request.resolve',
        details: { resolution: 'rejected', hostPattern: 'api.example.com' },
      }),
    );
  });

  it('refuses resolutions other than approve / reject', async () => {
    const stub = makeDbStub([row()]);
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;
    await expect(src.resolve(ctx('admin'), item, { kind: 'submit', payload: {} })).rejects.toThrow(
      ActionCenterResolveError,
    );
  });

  it('throws STALE when the CAS update loses (row already resolved)', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    stub.updateReturns = [];
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    stub.selectResult = [{ ...target, status: 'approved', reviewedBy: 'someone-else' }];

    let err: unknown;
    try {
      await src.resolve(ctx('admin'), item, { kind: 'approve' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect((err as ActionCenterResolveError).code).toBe('STALE_ACTION_CENTER_ITEM');
    expect(stub.insertedValues).toHaveLength(0);
  });

  it('throws NOT_FOUND when the row does not exist', async () => {
    const target = row();
    const stub = makeDbStub([target]);
    const src = makeSource(stub);
    const item = (await src.listOpen(ctx('admin')))[0]!;

    stub.updateReturns = [];
    stub.selectResult = [];

    let err: unknown;
    try {
      await src.resolve(ctx('admin'), item, { kind: 'approve' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActionCenterResolveError);
    expect((err as ActionCenterResolveError).code).toBe('NOT_FOUND');
  });
});
