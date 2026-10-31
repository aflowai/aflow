/**
 * The decision card through the plan's writes (Plan 337 P1): created and read
 * whole, compared whole, replaced whole, and kept from a resident's rewrite
 * as the goal and criteria are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type { PlanNodeRow } from '@aflow/database';
import { PlanNodeGetOutputSchema, type PlanNode, type PlanNodeCard } from '@aflow/schemas';
import {
  createPlanNode,
  getPlanNode,
  revisePlanNode,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import { rowToPlanNode } from '../plan/store.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../logger.js', () => ({ getCyberneticLogger: () => ({ warn }) }));

const TENANT = 'a0000000-0000-4000-8000-000000000337';
const SPACE = '5e1d0000-0000-4000-8000-000000000337';

const CARD: PlanNodeCard = {
  change: { today: 'The rail shows prose.', after: 'The rail shows the card.' },
  why: ['The operator reads all of the prose to find the decision.'],
  affects: ['The plan rail.'],
  risks: [{ risk: 'Items grow long.', mitigation: 'The guidance asks for short items.' }],
  questions: [{ question: 'Is the card optional?', recommended: 'Yes, on every node.' }],
  notDoing: [],
};

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function ctx(): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId: SPACE, createdBy: 'operator' };
}

const resident = (): PlanWriteContext => ({ ...ctx(), actorKind: 'agent', resident: true });

async function carded(): Promise<PlanNode> {
  const result = await createPlanNode(ctx(), {
    kind: 'decide',
    title: 'Decide the card',
    goal: 'Decide whether nodes carry a card.',
    criteria: 'The operator approves the card.',
    card: CARD,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('the card on a plan node', () => {
  it('is created with the node and read back whole', async () => {
    const node = await carded();
    expect(node.card).toEqual(CARD);

    const read = await getPlanNode({ store, spaceId: SPACE }, node.nodeId);
    expect(read).toMatchObject({ ok: true, node: { card: CARD } });
  });

  it('refuses the same card in another key order as a write that changes nothing', async () => {
    const node = await carded();
    const reordered = Object.fromEntries(Object.entries(CARD).reverse()) as PlanNodeCard;

    expect(
      await updatePlanNode(ctx(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        card: reordered,
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });
  });

  it('is replaced whole, and named among the differing fields of a stale write', async () => {
    const node = await carded();
    const replaced = await updatePlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      card: { ...CARD, notDoing: ['No backfill of open nodes.'] },
    });
    if (!replaced.ok) throw new Error(replaced.message);
    expect(replaced.node.card?.notDoing).toEqual(['No backfill of open nodes.']);

    expect(
      await updatePlanNode(ctx(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        card: CARD,
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE', details: { differingFields: ['card'] } });
    expect(store.nodes.get(node.nodeId)?.card?.notDoing).toEqual(['No backfill of open nodes.']);
  });

  it('carries no card where none was written', async () => {
    const result = await createPlanNode(ctx(), {
      kind: 'execute',
      title: 'No decision here',
      goal: 'Build the column.',
      criteria: 'The column exists.',
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && 'card' in result.node).toBe(false);
  });

  it('reads a stored card the schema now refuses as no card, and the node passes its output schema', () => {
    const at = new Date('2026-10-31T00:00:00.000Z');
    const row: PlanNodeRow = {
      id: '7b0c4b52-58a4-4c39-9a51-0d3f3c0b8a11',
      spaceId: SPACE,
      parentId: null,
      kind: 'decide',
      title: 'Decide the card',
      goal: 'Decide whether nodes carry a card.',
      criteria: 'The operator approves the card.',
      status: 'blocked',
      outcome: null,
      note: null,
      revision: 2,
      position: 0,
      createdBy: null,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      openedAt: null,
      spendCents: null,
      card: { change: 'Prose becomes a card.', doneWhen: 'It reads.' } as unknown as PlanNodeCard,
    };
    const node = rowToPlanNode(row);
    expect(node).not.toHaveProperty('card');
    expect(PlanNodeGetOutputSchema.shape.node.safeParse(node).success).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('stored card refused'),
      expect.objectContaining({ nodeId: row.id, refusal: expect.stringContaining('why') }),
    );

    warn.mockClear();
    expect(rowToPlanNode({ ...row, card: CARD }).card).toEqual(CARD);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a resident wake and the card (Plan 337 D4)', () => {
  it('proposes a node with a card', async () => {
    const result = await createPlanNode(resident(), {
      kind: 'execute',
      title: 'Propose the rail',
      goal: 'Render the card on the rail.',
      criteria: 'The rail shows each section.',
      proposed: 'The card is stored and nothing shows it.',
      card: CARD,
    });
    expect(result).toMatchObject({ ok: true, node: { status: 'blocked', card: CARD } });
  });

  it('may not rewrite the card of a blocked proposal no Revise sent back', async () => {
    const node = store.seed(SPACE, {
      title: 'proposed',
      status: 'blocked',
      note: 'Proposed by the resident',
      card: CARD,
    });

    expect(
      await updatePlanNode(resident(), {
        nodeId: node.nodeId,
        expectedRevision: 1,
        card: { ...CARD, why: ['Rewritten.'] },
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    expect(store.nodes.get(node.nodeId)?.card).toEqual(CARD);
  });

  it('rewrites the card of a proposal the operator sent back', async () => {
    const node = store.seed(SPACE, {
      title: 'proposed',
      status: 'blocked',
      note: 'Proposed by the resident',
      card: CARD,
    });
    const revised = await revisePlanNode(ctx(), {
      nodeId: node.nodeId,
      expectedRevision: 1,
      why: 'Say why the rail comes first.',
    });
    if (!revised.ok) throw new Error(revised.message);

    const result = await updatePlanNode(resident(), {
      nodeId: node.nodeId,
      expectedRevision: revised.node.revision,
      card: { ...CARD, why: ['The rail is where the operator decides.'] },
      note: 'Revised: the card says why the rail comes first.\nProposed by the resident',
    });
    expect(result).toMatchObject({
      ok: true,
      node: { status: 'blocked', card: { why: ['The rail is where the operator decides.'] } },
    });
  });
});
