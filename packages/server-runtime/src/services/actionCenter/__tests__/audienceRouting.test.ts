/**
 * One queue, several people. A request that names a particular approver is
 * waiting on *them* — everyone else can see the team is blocked, but nobody
 * else is being told to act. Getting this wrong in either direction is what
 * turns a shared queue into something people stop reading: broadcast it and
 * every badge is permanently lit, hide it and a blocked team looks idle.
 */
import { describe, it, expect } from 'vitest';
import type { ActionCenterItem, ActionCenterResolution } from '@aflow/schemas';
import { inMemoryDecisionPlane } from './inMemoryDecisionPlane.js';
import { buildAggregator } from '../aggregator.js';
import { actionCenterItemMarker } from '../itemMarker.js';
import type { ActionCenterAggregator } from '../aggregator.js';
import type { ActionCenterContext, ActionCenterSource, ActionCenterSourceItem } from '../types.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-0000000000f0';
const SARA = '00000000-0000-4000-8000-00000000e5a1';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';

function request(overrides: Partial<ActionCenterItem> = {}): ActionCenterSourceItem {
  return {
    id: 'step:1',
    spaceId: SPACE,
    kind: 'human_approval',
    origin: { type: 'step', stepExecutionId: 'se-1', sessionId: 's-1', attempt: 1 },
    title: 'Approve the deploy',
    summary: 'Ship 2.1 to production',
    requestedAt: new Date(0).toISOString(),
    requestedBy: { kind: 'agent', label: 'Helmsman' },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
    ...overrides,
  } as ActionCenterSourceItem;
}

function sourceOf(items: ActionCenterSourceItem[]): ActionCenterSource {
  return {
    name: 'stub',
    rowScope: 'space',
    handlesOriginTypes: ['step'],
    listOpen: async () => items,
    getById: async (_ctx, id) => items.find((i) => i.id === id) ?? null,
    resolve: async () => ({
      resolvedAt: new Date(0).toISOString(),
      dispatchedOperationId: 'op',
      reportedOperationId: 'op',
    }),
  };
}

function reader(actorUserId: string, actorSpaceRole: 'admin' | 'editor' = 'editor') {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    actorUserId,
    actorSpaceRole,
    actorIsTenantAdmin: false,
  } as ActionCenterContext;
}

/**
 * The badge rule, applied where the client applies it: a request named for a
 * teammate stays in the list and out of your count.
 */
async function attention(
  ac: ActionCenterAggregator,
  who: ActionCenterContext,
  kind?: ActionCenterItem['kind'],
): Promise<number> {
  const items = (await ac.list(who)).filter((i) => i.audience !== 'someone_else');
  return kind ? items.filter((i) => i.kind === kind).length : items.length;
}

const named = (who: string[]) =>
  request({ resolverPolicy: { minResolvers: 1, requireAll: false, candidateResolvers: who } });

describe('who a request is waiting on', () => {
  const db = {} as never;

  it('is the person named on it, and someone else to everyone watching', async () => {
    const ac = buildAggregator({
      db,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceOf([named([SARA])])],
    });

    expect((await ac.list(reader(SARA)))[0]?.audience).toBe('you');
    expect((await ac.list(reader(KARIM)))[0]?.audience).toBe('someone_else');
  });

  it('is anyone when the request named nobody', async () => {
    const ac = buildAggregator({
      db,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceOf([request()])],
    });

    expect((await ac.list(reader(KARIM)))[0]?.audience).toBe('anyone');
  });

  it('answers a role the same way it answers a name', async () => {
    const ac = buildAggregator({
      db,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceOf([named(['admin'])])],
    });

    expect((await ac.list(reader(KARIM, 'admin')))[0]?.audience).toBe('you');
    expect((await ac.list(reader(SARA, 'editor')))[0]?.audience).toBe('someone_else');
  });

  it('keeps a teammate’s request visible but out of your badge', async () => {
    const ac = buildAggregator({
      db,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceOf([named([SARA]), request({ id: 'step:2' })])],
    });

    // Karim can still see both — a blocked team must not look idle.
    expect((await ac.list(reader(KARIM))).map((i) => i.id).sort()).toEqual(['step:1', 'step:2']);
    // But only the untargeted one is asking him for anything.
    expect(await attention(ac, reader(KARIM))).toBe(1);
    expect(await attention(ac, reader(SARA))).toBe(2);
  });

  it('counts the same request for Sara that it de-emphasises for Karim', async () => {
    const ac = buildAggregator({
      db,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceOf([named([SARA])])],
    });

    expect(await attention(ac, reader(SARA), 'human_approval')).toBe(1);
    expect(await attention(ac, reader(KARIM), 'human_approval')).toBe(0);
    expect(await attention(ac, reader(KARIM))).toBe(0);
  });

  it('answers a single fetch the same way it answers the list', async () => {
    const ac = buildAggregator({
      db,
      decisionPlane: inMemoryDecisionPlane().store,
      sources: [sourceOf([named([SARA])])],
    });

    expect((await ac.get(reader(KARIM), 'step:1'))?.audience).toBe('someone_else');
    expect((await ac.get(reader(SARA), 'step:1'))?.audience).toBe('you');
  });
});

describe('routing a request to a person', () => {
  const db = {} as never;
  const ALEX = '00000000-0000-4000-8000-00000000a1e0';

  function build(items: ActionCenterSourceItem[], members: string[] = [SARA, KARIM, ALEX]) {
    const plane = inMemoryDecisionPlane(members);
    const ac = buildAggregator({ db, decisionPlane: plane.store, sources: [sourceOf(items)] });
    return { ac, plane };
  }

  const reassignTo = (who: string, reason?: string): ActionCenterResolution => ({
    kind: 'reassign',
    assigneeUserId: who,
    ...(reason ? { reason } : {}),
  });

  it('puts the request on the named person’s desk and tells them', async () => {
    const { ac, plane } = build([request()]);

    const result = await ac.resolve(reader(KARIM), 'step:1', reassignTo(ALEX, 'you ran this last'));

    expect(result.item.status).toBe('open');
    expect(result.item.assignee).toBe(ALEX);
    expect(plane.assignments.get('step:1')).toBe(ALEX);
    expect([...plane.notifications.keys()]).toEqual([`reassign|step:1|${ALEX}`]);
  });

  it('does not close the request or touch the source', async () => {
    let sourceResolved = false;
    const src = sourceOf([request()]);
    const originalResolve = src.resolve.bind(src);
    src.resolve = async (...args) => {
      sourceResolved = true;
      return originalResolve(...args);
    };
    const plane = inMemoryDecisionPlane([ALEX]);
    const ac = buildAggregator({ db, decisionPlane: plane.store, sources: [src] });

    await ac.resolve(reader(KARIM), 'step:1', reassignTo(ALEX));

    expect(sourceResolved).toBe(false);
    expect((await ac.get(reader(KARIM), 'step:1'))?.status).toBe('open');
  });

  it('assignment narrows the audience below the resolver policy', async () => {
    const { ac } = build([named([SARA, KARIM])]);

    await ac.resolve(reader(KARIM), 'step:1', reassignTo(SARA));

    // Sara leads; Karim — still fully authorised to answer — reads it as hers.
    expect((await ac.get(reader(SARA), 'step:1'))?.audience).toBe('you');
    const karimView = await ac.get(reader(KARIM), 'step:1');
    expect(karimView?.audience).toBe('someone_else');
    expect(karimView?.allowedActions).toContain('approve');
  });

  it('refuses to route a request outside the space', async () => {
    const { ac } = build([request()], [SARA, KARIM]);

    await expect(ac.resolve(reader(KARIM), 'step:1', reassignTo(ALEX))).rejects.toMatchObject({
      code: 'INVALID_RESOLUTION',
    });
  });

  it('tells a person once no matter how often the routing is repeated', async () => {
    const { ac, plane } = build([request()]);

    await ac.resolve(reader(KARIM), 'step:1', reassignTo(ALEX));
    await ac.resolve(reader(SARA), 'step:1', reassignTo(ALEX));

    expect(plane.notifications.size).toBe(1);
  });

  it('moves the badge with the assignment', async () => {
    const { ac } = build([request()]);

    expect(await attention(ac, reader(KARIM))).toBe(1);
    await ac.resolve(reader(KARIM), 'step:1', reassignTo(ALEX));

    expect(await attention(ac, reader(KARIM))).toBe(0);
    expect(await attention(ac, reader(ALEX))).toBe(1);
  });
});

describe('a routed request reaches the person it was handed to', () => {
  const db = {} as never;
  const ALEX = '00000000-0000-4000-8000-00000000a1e0';

  it('changes the marker the live channel diffs on', () => {
    // Routing changes nothing about the pause underneath — same origin, same
    // status — so a marker built from those alone stays byte-identical and the
    // topic never pushes the assignment to the person who just received it.
    const before = actionCenterItemMarker(request());
    const after = actionCenterItemMarker({ ...request(), assignee: ALEX });

    expect(after).not.toBe(before);
  });

  it('refuses to route to someone who cannot act on it', async () => {
    // A viewer can neither answer nor pass it on, so handing them a request
    // parks it where nobody is looking.
    const plane = inMemoryDecisionPlane([SARA]); // Alex is present but cannot be asked
    const ac = buildAggregator({
      db,
      decisionPlane: plane.store,
      sources: [sourceOf([request()])],
    });

    await expect(
      ac.resolve(reader(KARIM), 'step:1', { kind: 'reassign', assigneeUserId: ALEX }),
    ).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
    expect(plane.assignments.size).toBe(0);
  });

  it('refuses to route a request that has already been answered', async () => {
    const plane = inMemoryDecisionPlane([ALEX]);
    const ac = buildAggregator({
      db,
      decisionPlane: plane.store,
      sources: [sourceOf([request({ status: 'resolved' })])],
    });

    await expect(
      ac.resolve(reader(KARIM), 'step:1', { kind: 'reassign', assigneeUserId: ALEX }),
    ).rejects.toMatchObject({ code: 'STALE_ACTION_CENTER_ITEM' });
    expect(plane.notifications.size).toBe(0);
  });
});
