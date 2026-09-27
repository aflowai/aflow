import { describe, expect, it, vi } from 'vitest';
import type { ActionCenterItem, ActionCenterResolution } from '@aflow/schemas';
import type { ActionCenterSourceItem } from '../types.js';
import { inMemoryDecisionPlane } from './inMemoryDecisionPlane.js';
import { buildAggregator } from '../aggregator.js';
import {
  ActionCenterResolveError,
  type ActionCenterContext,
  type ActionCenterSource,
  type ActionCenterResolveOutcome,
} from '../types.js';
import { ActionCenterAuthzError } from '../authz.js';

const SPACE_ID = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID = '00000000-0000-0000-0000-000000000002';

function ctx(): ActionCenterContext {
  return {
    tenantId: 't-1' as never,
    spaceId: SPACE_ID,
    actorUserId: ACTOR_ID,
    actorSpaceRole: 'editor',
    actorIsTenantAdmin: false,
  };
}

function item(overrides: Partial<ActionCenterSourceItem> = {}): ActionCenterSourceItem {
  return {
    id: 'step:abc',
    spaceId: SPACE_ID,
    kind: 'human_approval',
    origin: {
      type: 'step',
      runId: 'r-1',
      stepExecutionId: 'se-1',
      sessionId: 's-1',
      pauseVersion: 0,
      operationId: 'user.interaction.approve',
    },
    title: 't',
    summary: 's',
    requestedAt: '2026-05-21T12:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'agent' },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
    ...overrides,
  } as unknown as ActionCenterSourceItem;
}

function makeStubSource(
  name: string,
  items: ActionCenterSourceItem[],
  resolveImpl?: (
    ctx: ActionCenterContext,
    item: ActionCenterSourceItem,
    resolution: ActionCenterResolution,
  ) => Promise<ActionCenterResolveOutcome>,
): ActionCenterSource {
  return {
    name,
    rowScope: 'space',
    handlesOriginTypes: ['step', 'gate', 'proposal', 'settings'],
    async listOpen() {
      return items;
    },
    async getById(_c, itemId) {
      return items.find((i) => i.id === itemId) ?? null;
    },
    async resolve(c, it, r) {
      if (resolveImpl) return resolveImpl(c, it, r);
      return {
        resolvedAt: new Date().toISOString(),
        dispatchedOperationId: 'mock.op',
        reportedOperationId: 'mock.op',
      };
    },
  };
}

// The aggregator's audit write uses Drizzle; we hand it a stub `db` whose
// insert path throws — the aggregator swallows audit failures so the test
// still exercises the rest of the resolve flow.
const dbStub: unknown = {};

describe('buildAggregator', () => {
  it('merges items from every source and sorts by requestedAt desc', async () => {
    const older = item({ id: 'step:old', requestedAt: '2026-05-21T10:00:00.000Z' });
    const newer = item({ id: 'proposal:new', requestedAt: '2026-05-21T14:00:00.000Z' });
    const middle = item({ id: 'step:mid', requestedAt: '2026-05-21T12:00:00.000Z' });
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [makeStubSource('a', [older, middle]), makeStubSource('b', [newer])],
    });
    const list = await agg.list(ctx());
    expect(list.map((i) => i.id)).toEqual(['proposal:new', 'step:mid', 'step:old']);
  });

  it('splits the read into the space-shared half and the reader\u2019s own', async () => {
    const shared = item({ id: 'step:shared' });
    const mine = item({ id: 'session-invite:s1:me' });
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [
        makeStubSource('shared', [shared]),
        { ...makeStubSource('personal', [mine]), rowScope: 'actor' } as ActionCenterSource,
      ],
    });

    expect((await agg.listSpaceScoped(ctx())).map((i) => i.id)).toEqual(['step:shared']);
    expect((await agg.listActorScoped(ctx())).map((i) => i.id)).toEqual(['session-invite:s1:me']);
    expect((await agg.list(ctx())).map((i) => i.id).sort()).toEqual([
      'session-invite:s1:me',
      'step:shared',
    ]);
  });

  it('get probes each source until one matches', async () => {
    const sourceA = makeStubSource('a', [item({ id: 'step:1' })]);
    const sourceB = makeStubSource('b', [item({ id: 'proposal:2' })]);
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceA, sourceB],
    });
    expect((await agg.get(ctx(), 'step:1'))?.id).toBe('step:1');
    expect((await agg.get(ctx(), 'proposal:2'))?.id).toBe('proposal:2');
    expect(await agg.get(ctx(), 'nonexistent')).toBeNull();
  });

  it('throws NOT_FOUND when resolving an unknown item', async () => {
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [makeStubSource('a', [])],
    });
    await expect(agg.resolve(ctx(), 'step:missing', { kind: 'approve' })).rejects.toThrow(
      ActionCenterResolveError,
    );
  });

  it('throws ActionCenterAuthzError when the actor lacks role for the action', async () => {
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [makeStubSource('a', [item({ id: 'step:1', kind: 'human_approval' })])],
    });
    const viewerCtx: ActionCenterContext = { ...ctx(), actorSpaceRole: 'viewer' };
    await expect(agg.resolve(viewerCtx, 'step:1', { kind: 'approve' })).rejects.toThrow(
      ActionCenterAuthzError,
    );
  });

  it('propagates STALE_ACTION_CENTER_ITEM from the source', async () => {
    const resolveImpl = vi.fn(async () => {
      throw new ActionCenterResolveError(
        'STALE_ACTION_CENTER_ITEM',
        'CAS mismatch',
        'stale_target',
      );
    });
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [makeStubSource('a', [item({ id: 'step:1', kind: 'human_approval' })], resolveImpl)],
    });
    await expect(agg.resolve(ctx(), 'step:1', { kind: 'approve' })).rejects.toMatchObject({
      code: 'STALE_ACTION_CENTER_ITEM',
    });
  });

  it('wraps non-ActionCenterResolveError throws into DISPATCH_FAILED', async () => {
    const resolveImpl = vi.fn(async () => {
      throw new Error('redis blip');
    });
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [makeStubSource('a', [item({ id: 'step:1', kind: 'human_approval' })], resolveImpl)],
    });
    await expect(agg.resolve(ctx(), 'step:1', { kind: 'approve' })).rejects.toMatchObject({
      code: 'DISPATCH_FAILED',
    });
  });

  it('stamps resolution + resolvedBy on the returned item', async () => {
    const resolveImpl = vi.fn(async (): Promise<ActionCenterResolveOutcome> => ({
      resolvedAt: '2026-05-21T15:00:00.000Z',
      dispatchedOperationId: 'mock.op',
      reportedOperationId: 'mcp.tool.call',
    }));
    const agg = buildAggregator({
      db: dbStub as never,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [makeStubSource('a', [item({ id: 'step:1', kind: 'human_approval' })], resolveImpl)],
    });
    const out = await agg.resolve(ctx(), 'step:1', { kind: 'approve', comment: 'lgtm' });
    expect(out.item.status).toBe('resolved');
    expect(out.item.resolvedBy).toBe(ACTOR_ID);
    expect(out.item.resolvedAt).toBe('2026-05-21T15:00:00.000Z');
    expect(out.item.resolution).toEqual({ kind: 'approve', comment: 'lgtm' });
    expect(out.reportedOperationId).toBe('mcp.tool.call');
  });
});
