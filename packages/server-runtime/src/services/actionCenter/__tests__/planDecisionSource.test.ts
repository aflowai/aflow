/**
 * A `decide` node raises an Action Center item (Plan 322 P3.2): read from the
 * plan on every list, answered in words, and the answer written as the node's
 * outcome through the plan engine — compare-and-set on the revision the item
 * was shown at — with who answered left to the aggregator's audit row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionCenterItemSchema, type PlanNode } from '@aflow/schemas';

const mockListOpenDecisions = vi.fn();
const mockFindOpenDecision = vi.fn();
const mockUpdatePlanNode = vi.fn();
const mockRequestResidentWake = vi.fn();
const mockCreatePlanNodeStore = vi.fn((..._args: unknown[]) => ({ store: 'tenant-store' }));

vi.mock('@aflow/cybernetic-runtime', () => ({
  createResidentScheduleStore: () => ({ schedules: 'resident' }),
  requestResidentWake: (...a: unknown[]) => mockRequestResidentWake(...a),
  listOpenDecisions: (...a: unknown[]) => mockListOpenDecisions(...a),
  findOpenDecision: (...a: unknown[]) => mockFindOpenDecision(...a),
  updatePlanNode: (...a: unknown[]) => mockUpdatePlanNode(...a),
  createPlanNodeStore: (...a: unknown[]) => mockCreatePlanNodeStore(...a),
}));

/** The audit rows the aggregator writes, as `hitl_action_audit` would hold them. */
const auditRows: Array<Record<string, unknown>> = [];

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({}),
  hitlActionAudit: { __table: 'hitl_action_audit' },
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          auditRows.push(row);
          return Promise.resolve();
        },
      }),
    }),
}));

vi.mock('@aflow/observability', () => ({
  recordActionCenterResolved: () => undefined,
  recordHitlGateLatency: () => undefined,
}));

const { createPlanDecisionSource } = await import('../sources/planDecisionSource.js');
const { buildAggregator } = await import('../aggregator.js');
const { inMemoryDecisionPlane } = await import('./inMemoryDecisionPlane.js');
const { actionCenterItemMarker } = await import('../itemMarker.js');
const { ActionCenterResolveError } = await import('../types.js');
const { ActionCenterAuthzError } = await import('../authz.js');

const TENANT_ID = 'a0000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const NODE_ID = '00000000-0000-4000-8000-0000000000d1';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000e1';
const DB = { db: 'tenant-db' };
const REDIS = { redis: 'shared' };

function decision(extra: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: NODE_ID,
    spaceId: SPACE_ID,
    parentId: null,
    kind: 'decide',
    title: 'Where the decide answer is recorded',
    goal: 'In the node’s outcome, or as a link to the Action Center item?',
    criteria: 'One is chosen and stated in the decision record.',
    status: 'active',
    revision: 3,
    position: 0,
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T09:30:00.000Z',
    ...extra,
  };
}

function ctx(role: 'admin' | 'editor' | 'viewer' = 'editor', interactive = true) {
  return {
    tenantId: TENANT_ID as never,
    spaceId: SPACE_ID,
    actorUserId: ACTOR_ID,
    actorSpaceRole: role,
    actorIsTenantAdmin: false,
    actorIsInteractiveUser: interactive,
  };
}

const ITEM_ID = `plan-decision:${NODE_ID}`;
/** The origin the operator read the decision at, as the resolve route passes it on. */
const SHOWN = { type: 'plan_decision' as const, nodeId: NODE_ID, revision: 3 };

const source = () =>
  createPlanDecisionSource({ db: DB as never, redis: REDIS as never, payloadStore: {} as never });

const aggregator = () =>
  buildAggregator({
    db: {} as never,
    decisionPlane: inMemoryDecisionPlane().store,
    sources: [source()],
  });

beforeEach(() => {
  vi.clearAllMocks();
  auditRows.length = 0;
  mockListOpenDecisions.mockResolvedValue([decision()]);
  mockFindOpenDecision.mockResolvedValue(decision());
});

describe('planDecisionSource — the item', () => {
  it('lists each open decision as an input asking for the operator’s words', async () => {
    const [item] = await source().listOpen({ tenantId: TENANT_ID as never, spaceId: SPACE_ID });

    expect(mockCreatePlanNodeStore).toHaveBeenCalledWith(DB, TENANT_ID);
    expect(mockListOpenDecisions).toHaveBeenCalledWith({
      store: { store: 'tenant-store' },
      spaceId: SPACE_ID,
    });
    expect(item).toMatchObject({
      id: `plan-decision:${NODE_ID}`,
      kind: 'human_input',
      origin: { type: 'plan_decision', nodeId: NODE_ID, revision: 3 },
      title: 'Pending decision · Where the decide answer is recorded',
      uiHints: { mode: 'textarea', submitLabel: 'Decide' },
      resolutionSchema: { type: 'string', minLength: 1 },
      resolverAuthority: { kind: 'space' },
      status: 'open',
      priority: 'normal',
    });
    expect(item?.summary).toContain('In the node’s outcome, or as a link');
    expect(item?.summary).toContain('Decided when: One is chosen');
  });

  it('is a valid Action Center item, bounded where the node’s prose is longer than the item holds', async () => {
    mockListOpenDecisions.mockResolvedValue([
      decision({ title: 't'.repeat(500), goal: 'g'.repeat(10_000), status: 'blocked' }),
    ]);

    const items = await aggregator().list(ctx());

    expect(items).toHaveLength(1);
    expect(ActionCenterItemSchema.safeParse(items[0]).success).toBe(true);
    expect(items[0]?.priority).toBe('high');
    expect(items[0]?.allowedActions).toEqual(['submit', 'reassign']);
  });

  it('cuts a long title before an open code span and closes a fence the summary cut leaves open', async () => {
    const title = `${'w '.repeat(115)}\`a code span that runs past the ceiling\``;
    const goal = `Pick one:\n\`\`\`ts\n${'const a = 1;\n'.repeat(200)}\`\`\``;
    mockListOpenDecisions.mockResolvedValue([decision({ title, goal })]);

    const [item] = await source().listOpen({ tenantId: TENANT_ID as never, spaceId: SPACE_ID });

    expect(item?.title.length).toBeLessThanOrEqual(256);
    expect(item?.title.startsWith('Pending decision · ')).toBe(true);
    expect(item?.title.endsWith('…')).toBe(true);
    expect(item?.title).not.toContain('`');
    expect(item?.summary.length).toBeLessThanOrEqual(2_000);
    expect(item?.summary.endsWith('\n```')).toBe(true);
  });

  it('shows a viewer the decision without a way to answer it', async () => {
    const [item] = await aggregator().list(ctx('viewer'));
    expect(item?.allowedActions).toEqual([]);
  });

  it('finds its own items by id and no others', async () => {
    expect(await source().getById(ctx(), `plan-decision:${NODE_ID}`)).toMatchObject({
      origin: { revision: 3 },
    });
    expect(mockFindOpenDecision).toHaveBeenCalledWith(
      { store: { store: 'tenant-store' }, spaceId: SPACE_ID },
      NODE_ID,
    );
    expect(await source().getById(ctx(), 'plan-decision:not-a-uuid')).toBeNull();
    expect(await source().getById(ctx(), `step:${NODE_ID}`)).toBeNull();
    mockFindOpenDecision.mockResolvedValue(null);
    expect(await source().getById(ctx(), `plan-decision:${NODE_ID}`)).toBeNull();
  });

  it('marks a new revision as a change a live viewer must see', () => {
    const at = (revision: number) =>
      actionCenterItemMarker({
        origin: { type: 'plan_decision', nodeId: NODE_ID, revision },
        status: 'open',
      });
    expect(at(3)).not.toEqual(at(4));
  });
});

describe('planDecisionSource — the answer', () => {
  it('writes the answer as the node’s outcome, marking it done against the revision shown', async () => {
    mockUpdatePlanNode.mockResolvedValue({
      ok: true,
      node: decision({ status: 'done', outcome: 'In the outcome.', revision: 4 }),
    });

    const result = await aggregator().resolve(
      ctx(),
      ITEM_ID,
      { kind: 'submit', payload: '  In the outcome.  ' },
      SHOWN,
    );

    expect(mockUpdatePlanNode).toHaveBeenCalledWith(
      {
        store: { store: 'tenant-store' },
        spaceId: SPACE_ID,
        redis: REDIS,
        tenantId: TENANT_ID,
        createdBy: ACTOR_ID,
        actorKind: 'human',
      },
      { nodeId: NODE_ID, expectedRevision: 3, status: 'done', outcome: 'In the outcome.' },
    );
    expect(result).toMatchObject({
      reportedOperationId: 'plan.node.update',
      item: { status: 'resolved', resolvedBy: ACTOR_ID },
    });
    expect(mockRequestResidentWake).toHaveBeenCalledWith(
      { redis: REDIS, schedules: { schedules: 'resident' } },
      { tenantId: TENANT_ID, spaceId: SPACE_ID, cause: 'node_written' },
    );
    // Who answered is the server's record, not the node's prose.
    expect(auditRows).toEqual([
      expect.objectContaining({
        originKind: 'plan_decision',
        originId: `plan-decision:${NODE_ID}`,
        operationId: 'plan.node.update',
        resolverUserId: ACTOR_ID,
        resolutionKind: 'submit',
      }),
    ]);
  });

  it('refuses an answer that is not words, before writing anything', async () => {
    for (const payload of [undefined, '   ', 42, { choice: 'a' }]) {
      await expect(
        aggregator().resolve(ctx(), ITEM_ID, { kind: 'submit', payload }, SHOWN),
      ).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
    }
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses an approval: a decision is answered, not approved', async () => {
    await expect(
      aggregator().resolve(ctx(), ITEM_ID, { kind: 'approve' }, SHOWN),
    ).rejects.toBeInstanceOf(ActionCenterAuthzError);
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses an answer to a question rewritten since, handing back the decision as it stands', async () => {
    mockUpdatePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'stale',
      details: { nodeId: NODE_ID, revision: 4 },
    });
    mockFindOpenDecision
      .mockResolvedValueOnce(decision())
      .mockResolvedValueOnce(decision({ revision: 4, goal: 'Rewritten question?' }));

    const failure = await aggregator()
      .resolve(ctx(), ITEM_ID, { kind: 'submit', payload: 'The first.' }, SHOWN)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ActionCenterResolveError);
    expect(failure).toMatchObject({
      code: 'STALE_ACTION_CENTER_ITEM',
      latestItem: { origin: { revision: 4 }, summary: expect.stringContaining('Rewritten') },
    });
    expect((failure as Error).message).toContain('revision 4');
    expect((failure as Error).message).toContain('revision 3');
  });

  it('writes against the revision the operator read, not the one re-read for the call', async () => {
    // The Helmsman rewrote the question between the route's comparison and
    // this write: the re-read item is at 4, the operator answered 3.
    mockFindOpenDecision
      .mockResolvedValueOnce(decision({ revision: 4, goal: 'Rewritten question?' }))
      .mockResolvedValueOnce(decision({ revision: 4, goal: 'Rewritten question?' }));
    mockUpdatePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'stale',
      details: { nodeId: NODE_ID, revision: 4 },
    });

    await expect(
      aggregator().resolve(ctx(), ITEM_ID, { kind: 'submit', payload: 'The first.' }, SHOWN),
    ).rejects.toMatchObject({
      code: 'STALE_ACTION_CENTER_ITEM',
      latestItem: { origin: { revision: 4 } },
    });
    expect(mockUpdatePlanNode.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 3 });
  });

  it('refuses an answer that names no observed revision, or another node’s, and writes nothing', async () => {
    for (const observed of [
      undefined,
      { ...SHOWN, nodeId: '00000000-0000-4000-8000-0000000000d9' },
      {
        type: 'trigger_armed' as const,
        scheduleId: NODE_ID,
        createdAt: '2026-10-22T09:00:00.000Z',
      },
    ]) {
      await expect(
        aggregator().resolve(ctx(), ITEM_ID, { kind: 'submit', payload: 'A.' }, observed),
      ).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
    }
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses an answer from a credential that is not a person signed in, whatever its role', async () => {
    for (const role of ['editor', 'admin'] as const) {
      const failure = await aggregator()
        .resolve(ctx(role, false), ITEM_ID, { kind: 'submit', payload: 'A.' }, SHOWN)
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ActionCenterResolveError);
      expect(failure).toMatchObject({ code: 'FORBIDDEN' });
    }
    const { actorIsInteractiveUser: _absent, ...unattributed } = ctx();
    await expect(
      aggregator().resolve(unattributed, ITEM_ID, { kind: 'submit', payload: 'A.' }, SHOWN),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it('lets a non-interactive caller route the decision to a person, which writes nothing to the plan', async () => {
    const result = await buildAggregator({
      db: {} as never,
      decisionPlane: inMemoryDecisionPlane([ACTOR_ID]).store,
      sources: [source()],
    }).resolve(ctx('editor', false), ITEM_ID, { kind: 'reassign', assigneeUserId: ACTOR_ID });
    expect(result.item.assignee).toBe(ACTOR_ID);
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('says a decision closed since it was shown took no answer', async () => {
    mockUpdatePlanNode.mockResolvedValue({ ok: false, code: 'PLAN_NODE_STALE', message: 's' });
    mockFindOpenDecision.mockResolvedValueOnce(decision()).mockResolvedValueOnce(null);

    await expect(
      aggregator().resolve(ctx(), ITEM_ID, { kind: 'submit', payload: 'A.' }, SHOWN),
    ).rejects.toMatchObject({ code: 'STALE_ACTION_CENTER_ITEM', latestItem: undefined });
  });
});
