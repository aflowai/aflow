/**
 * A node's first status is data (Plan 339 D6): approved work in the queue
 * starts active, as a new plan's P0 does. A node starts blocked only for
 * a decision that is the operator's, its card naming that decision. The rule
 * is read through the create schema and the engine, as the Helmsman's and the
 * resident's writes go.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_ASK_HEAD,
  PlanNodeCreateInputSchema,
  PlanNodeUpdateSchema,
  planNodeFirstStatus,
  type PlanNodeCard,
  type PlanNodeCreateInput,
  type PlanNodeWaitReason,
  type PlanNodeWork,
} from '@aflow/schemas';
import {
  createPlanNode,
  linkPlanNode,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const { warn, debug } = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ getCyberneticLogger: () => ({ warn, debug }) }));

const TENANT = 'a0000000-0000-4000-8000-000000000339';
const SPACE = '5e1d0000-0000-4000-8000-000000000339';

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function ctx(): PlanWriteContext {
  return {
    store,
    redis,
    tenantId: TENANT,
    spaceId: SPACE,
    createdBy: 'operator',
    actorKind: 'human',
  };
}

function card(waitsOn?: PlanNodeCard['waitsOn']): PlanNodeCard {
  return {
    change: { today: 'The loop waits.', after: 'The loop moves.' },
    why: ['The operator approves only decisions.'],
    affects: ['The plan rail.'],
    risks: [],
    questions: [],
    notDoing: [],
    ...(waitsOn !== undefined ? { waitsOn } : {}),
  };
}

/** A create as the inline handler takes it: parsed by the schema, then written by the engine. */
async function create(input: Omit<PlanNodeCreateInput, 'kind' | 'goal' | 'criteria'>) {
  const parsed = PlanNodeCreateInputSchema.parse({
    kind: 'execute',
    goal: `Goal of ${input.title}.`,
    criteria: `Criteria of ${input.title}.`,
    ...input,
  });
  const result = await createPlanNode(ctx(), parsed);
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

/** A plan whose P0 has closed done with its design document linked. */
async function mergedP0() {
  const root = await create({ title: 'Plan 340 · the loop works against any forge' });
  const p0 = await create({ parentId: root.nodeId, title: 'P0', work: 'design_document' });
  await linkPlanNode(ctx(), { nodeId: p0.nodeId, kind: 'document', ref: 'docs/plans/340.md' });
  const closed = await updatePlanNode(ctx(), {
    nodeId: p0.nodeId,
    expectedRevision: p0.revision,
    status: 'done',
    outcome: 'Merged after review.',
  });
  if (!closed.ok) throw new Error(closed.message);
  return { root, p0: closed.node };
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('a node’s first status (Plan 339 D6)', () => {
  const approved: { work: PlanNodeWork; title: string }[] = [
    { work: 'approved_phase', title: 'P2 — a phase of an approved plan' },
    { work: 'design_document', title: 'P0 — the design document of a new plan' },
    { work: 'defect_fix', title: 'Fix CI red on main' },
    { work: 'findings_follow_up', title: 'Carry the review’s open findings' },
  ];

  it.each(approved)('starts $work active, with no wait line', async ({ work, title }) => {
    expect(planNodeFirstStatus(work)).toBe('active');
    const node = await create({ title, work });
    expect(node.status).toBe('active');
    expect(node.note).toBeUndefined();
  });

  it('starts the carrier a done-close writes for open findings active', async () => {
    const step = await create({ title: 'P1 — reviewed', work: 'approved_phase' });
    await linkPlanNode(ctx(), { nodeId: step.nodeId, kind: 'finding', ref: 'review:open-1' });
    const closed = await updatePlanNode(ctx(), {
      nodeId: step.nodeId,
      expectedRevision: step.revision,
      status: 'done',
      outcome: 'Merged with a finding open.',
    });
    expect(closed).toMatchObject({ ok: true, carrier: { status: 'active' } });
    expect(planNodeFirstStatus('findings_follow_up')).toBe('active');
  });

  const decisions: { reason: PlanNodeWaitReason; decision: string }[] = [
    { reason: 'design_decision', decision: 'Choose where the wait primitive lives.' },
    { reason: 'design_approval', decision: 'Approve Plan 340’s merged design document.' },
    { reason: 'decision_change', decision: 'Amend Plan 322 D2.' },
    { reason: 'authority', decision: 'Let the resident push without asking.' },
    { reason: 'operator_question', decision: 'Answer the open question on the card.' },
  ];

  it.each(decisions)(
    'starts $reason blocked, its card naming the decision and its note saying it',
    async ({ reason, decision }) => {
      expect(planNodeFirstStatus(reason)).toBe('blocked');
      const parentId = reason === 'design_approval' ? (await mergedP0()).root.nodeId : undefined;
      const node = await create({
        ...(parentId !== undefined ? { parentId } : {}),
        title: decision,
        work: reason,
        card: card({ reason, decision }),
      });
      expect(node.status).toBe('blocked');
      expect(node.card?.waitsOn).toEqual({ reason, decision });
      expect(node.note).toBe(`${PLAN_NODE_ASK_HEAD}${decision}`);
    },
  );

  it.each(decisions)(
    'refuses $reason without the decision its card asks, and writes nothing',
    ({ reason }) => {
      const parsed = PlanNodeCreateInputSchema.safeParse({
        kind: 'execute',
        title: 'No decision named',
        goal: 'A goal.',
        criteria: 'Criteria.',
        work: reason,
        card: card(),
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['card', 'waitsOn']);
      expect(store.nodes.size).toBe(0);
    },
  );

  it('refuses approved work whose card names a wait, and a wait under another reason', () => {
    const base = { kind: 'execute', title: 'Fix it', goal: 'A goal.', criteria: 'Criteria.' };
    const asked = { reason: 'authority', decision: 'Widen egress.' } as const;
    expect(
      PlanNodeCreateInputSchema.safeParse({ ...base, work: 'defect_fix', card: card(asked) })
        .success,
    ).toBe(false);
    expect(
      PlanNodeCreateInputSchema.safeParse({ ...base, work: 'design_decision', card: card(asked) })
        .success,
    ).toBe(false);
  });

  it('starts a new plan’s P0 active and asks at the phase after it once the document merged', async () => {
    const root = await create({ title: 'Plan 340 · the loop works against any forge' });
    const p0 = await create({
      parentId: root.nodeId,
      title: 'P0 — the design document',
      work: 'design_document',
    });
    expect(p0).toMatchObject({ status: 'active' });
    expect(p0.note).toBeUndefined();
    const decision = 'Approve Plan 340’s merged design document.';
    const asking = () =>
      createPlanNode(
        ctx(),
        PlanNodeCreateInputSchema.parse({
          parentId: root.nodeId,
          kind: 'decide',
          title: 'P1 — the forge seam',
          goal: 'Approve the design.',
          criteria: 'The operator approved it.',
          position: 1,
          work: 'design_approval',
          card: card({ reason: 'design_approval', decision }),
        }),
      );

    // P0 is still writing its document: there is nothing to approve yet.
    expect(await asking()).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    const closed = await updatePlanNode(ctx(), {
      nodeId: p0.nodeId,
      expectedRevision: p0.revision,
      status: 'done',
      outcome: 'Merged after review.',
    });
    expect(closed.ok).toBe(true);
    // Done, but with no document linked: still nothing to approve.
    expect(await asking()).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    expect(store.nodes.size).toBe(2);

    await linkPlanNode(ctx(), {
      nodeId: p0.nodeId,
      kind: 'document',
      ref: 'docs/plans/340-the-loop-works-against-any-forge.md@abc1234',
    });
    const p1 = await asking();
    if (!p1.ok) throw new Error(p1.message);
    expect(p1.node).toMatchObject({
      status: 'blocked',
      note: `${PLAN_NODE_ASK_HEAD}${decision}`,
    });
  });

  it('refuses a card that asks for design_approval with no work named, until P0 merged', async () => {
    const root = await create({ title: 'Plan 340 · the loop works against any forge' });
    await create({ parentId: root.nodeId, title: 'P0', work: 'design_document' });
    const decision = 'Approve Plan 340’s merged design document.';
    const result = await createPlanNode(
      ctx(),
      PlanNodeCreateInputSchema.parse({
        parentId: root.nodeId,
        kind: 'decide',
        title: 'P1 — the forge seam',
        goal: 'Approve the design.',
        criteria: 'The operator approved it.',
        card: card({ reason: 'design_approval', decision }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    expect(store.nodes.size).toBe(2);
  });

  it('asks for design_approval only on P0’s design document, not on another done step', async () => {
    const root = await create({ title: 'Plan 340 · the loop works against any forge' });
    await create({ parentId: root.nodeId, title: 'P0', work: 'design_document' });
    const other = await create({ parentId: root.nodeId, title: 'A side note' });
    await linkPlanNode(ctx(), { nodeId: other.nodeId, kind: 'document', ref: 'docs/notes.md' });
    const closed = await updatePlanNode(ctx(), {
      nodeId: other.nodeId,
      expectedRevision: other.revision,
      status: 'done',
      outcome: 'Written.',
    });
    expect(closed.ok).toBe(true);
    const decision = 'Approve Plan 340’s merged design document.';
    const result = await createPlanNode(
      ctx(),
      PlanNodeCreateInputSchema.parse({
        parentId: root.nodeId,
        kind: 'decide',
        title: 'P1 — the forge seam',
        goal: 'Approve the design.',
        criteria: 'The operator approved it.',
        work: 'design_approval',
        card: card({ reason: 'design_approval', decision }),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
  });

  it('offers no design_document wait: the card schema refuses it on every write', () => {
    const asked = { ...card(), waitsOn: { reason: 'design_document', decision: 'Approve it.' } };
    expect(
      PlanNodeCreateInputSchema.safeParse({
        kind: 'execute',
        title: 'An ask under a reason the schema does not offer',
        goal: 'A goal.',
        criteria: 'Criteria.',
        card: asked,
      }).success,
    ).toBe(false);
    expect(
      PlanNodeUpdateSchema.safeParse({
        nodeId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
        card: asked,
      }).success,
    ).toBe(false);
  });

  it('refuses an update that puts a design_approval ask on a node until P0 merged', async () => {
    const root = await create({ title: 'Plan 340 · the loop works against any forge' });
    const p0 = await create({ parentId: root.nodeId, title: 'P0', work: 'design_document' });
    const p1 = await create({ parentId: root.nodeId, title: 'P1 — the forge seam' });
    const asking = { reason: 'design_approval', decision: 'Approve Plan 340’s design.' } as const;
    const ask = async () => {
      const now = store.nodes.get(p1.nodeId)!;
      return updatePlanNode(ctx(), {
        nodeId: p1.nodeId,
        expectedRevision: now.revision,
        card: card(asking),
      });
    };

    expect(await ask()).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    expect(store.nodes.get(p1.nodeId)?.card).toBeUndefined();

    await linkPlanNode(ctx(), { nodeId: p0.nodeId, kind: 'document', ref: 'docs/plans/340.md' });
    const closed = await updatePlanNode(ctx(), {
      nodeId: p0.nodeId,
      expectedRevision: p0.revision,
      status: 'done',
      outcome: 'Merged after review.',
    });
    expect(closed.ok).toBe(true);
    expect(await ask()).toMatchObject({ ok: true, node: { card: { waitsOn: asking } } });
  });

  it('refuses an update that moves a design_approval ask under a plan whose P0 has not merged', async () => {
    const { root } = await mergedP0();
    const decision = 'Approve Plan 340’s merged design document.';
    const p1 = await create({
      parentId: root.nodeId,
      title: 'P1 — the forge seam',
      card: card({ reason: 'design_approval', decision }),
    });
    const other = await create({ title: 'Plan 341 · another plan' });
    await create({ parentId: other.nodeId, title: 'P0', work: 'design_document' });
    const moved = await updatePlanNode(ctx(), {
      nodeId: p1.nodeId,
      expectedRevision: p1.revision,
      parentId: other.nodeId,
      card: card({ reason: 'design_approval', decision }),
    });
    expect(moved).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
  });

  it('asks for design_approval below the plan root once the root’s P0 merged', async () => {
    const { root } = await mergedP0();
    const phase = await create({ parentId: root.nodeId, title: 'P1 — the forge seam' });
    const result = await createPlanNode(
      ctx(),
      PlanNodeCreateInputSchema.parse({
        parentId: phase.nodeId,
        kind: 'decide',
        title: 'Approve the design',
        goal: 'Approve the design.',
        criteria: 'The operator approved it.',
        work: 'design_approval',
        card: card({ reason: 'design_approval', decision: 'Approve Plan 340’s design.' }),
      }),
    );
    expect(result).toMatchObject({ ok: true, node: { status: 'blocked' } });
  });

  it('takes P0 as the first step not dropped, so a replaced P0 opens the ask once it merged', async () => {
    const root = await create({ title: 'Plan 340 · the loop works against any forge' });
    const first = await create({
      parentId: root.nodeId,
      title: 'P0 — first try',
      work: 'design_document',
      position: 0,
    });
    const dropped = await updatePlanNode(ctx(), {
      nodeId: first.nodeId,
      expectedRevision: first.revision,
      status: 'dropped',
      outcome: 'Replaced.',
    });
    expect(dropped.ok).toBe(true);
    const p0 = await create({
      parentId: root.nodeId,
      title: 'P0 — the design document',
      work: 'design_document',
      position: 1,
    });
    await linkPlanNode(ctx(), { nodeId: p0.nodeId, kind: 'document', ref: 'docs/plans/340.md' });
    const closed = await updatePlanNode(ctx(), {
      nodeId: p0.nodeId,
      expectedRevision: p0.revision,
      status: 'done',
      outcome: 'Merged after review.',
    });
    expect(closed.ok).toBe(true);
    const result = await createPlanNode(
      ctx(),
      PlanNodeCreateInputSchema.parse({
        parentId: root.nodeId,
        kind: 'decide',
        title: 'P1 — approve the design',
        goal: 'Approve the design.',
        criteria: 'The operator approved it.',
        position: 2,
        work: 'design_approval',
        card: card({ reason: 'design_approval', decision: 'Approve Plan 340’s design.' }),
      }),
    );
    expect(result).toMatchObject({ ok: true, node: { status: 'blocked' } });
  });

  it('starts a P0 the operator writes by hand as its card says, as before', async () => {
    const decision = 'Approve the design document.';
    const written = await create({ title: 'P0 — written by hand' });
    const asking = await create({
      title: 'P0 — written by hand, asking',
      card: card({ reason: 'decision_change', decision }),
    });
    expect(written.status).toBe('active');
    expect(asking).toMatchObject({ status: 'blocked', note: `${PLAN_NODE_ASK_HEAD}${decision}` });
  });

  /** An ask under `parentId`, as the engine answers it. */
  function ask(parentId: string, position?: number) {
    return createPlanNode(
      ctx(),
      PlanNodeCreateInputSchema.parse({
        parentId,
        kind: 'decide',
        title: 'P1 — approve the design',
        goal: 'Approve the design.',
        criteria: 'The operator approved it.',
        ...(position !== undefined ? { position } : {}),
        work: 'design_approval',
        card: card({ reason: 'design_approval', decision: 'Approve Plan 340’s design.' }),
      }),
    );
  }

  /** A plan whose P0 stands at `position`, closed done with its document linked. */
  async function mergedP0At(position: number) {
    const root = await create({ title: 'Plan 340 · the loop works against any forge' });
    const p0 = await create({
      parentId: root.nodeId,
      title: 'P0',
      work: 'design_document',
      position,
    });
    await linkPlanNode(ctx(), { nodeId: p0.nodeId, kind: 'document', ref: 'docs/plans/340.md' });
    const closed = await updatePlanNode(ctx(), {
      nodeId: p0.nodeId,
      expectedRevision: p0.revision,
      status: 'done',
      outcome: 'Merged after review.',
    });
    if (!closed.ok) throw new Error(closed.message);
    return { root, p0: closed.node };
  }

  it('refuses a move that carries a stored ask under a plan whose P0 has not merged, its card not resent', async () => {
    const { root } = await mergedP0();
    const p1 = await ask(root.nodeId);
    if (!p1.ok) throw new Error(p1.message);
    const other = await create({ title: 'Plan 341 · another plan' });
    await create({ parentId: other.nodeId, title: 'P0', work: 'design_document' });
    const moved = await updatePlanNode(ctx(), {
      nodeId: p1.node.nodeId,
      expectedRevision: p1.node.revision,
      parentId: other.nodeId,
    });
    expect(moved).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    expect(store.nodes.get(p1.node.nodeId)?.parentId).toBe(root.nodeId);
  });

  it('refuses an ask created ahead of a merged P0, since it would stand first', async () => {
    const { root } = await mergedP0At(5);
    expect(await ask(root.nodeId, 2)).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_DESIGN_NOT_MERGED',
    });
    // Its id is drawn on insert, so a create at P0’s own position may stand first too.
    expect(await ask(root.nodeId, 5)).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_DESIGN_NOT_MERGED',
    });
    expect(await ask(root.nodeId, 6)).toMatchObject({ ok: true, node: { status: 'blocked' } });
    expect(await ask(root.nodeId)).toMatchObject({ ok: true, node: { status: 'blocked' } });
  });

  it('refuses an update that puts a stored ask ahead of P0 among its siblings', async () => {
    const { root } = await mergedP0At(5);
    const p1 = await ask(root.nodeId, 6);
    if (!p1.ok) throw new Error(p1.message);
    const placed = await updatePlanNode(ctx(), {
      nodeId: p1.node.nodeId,
      expectedRevision: p1.node.revision,
      position: 1,
    });
    expect(placed).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    expect(store.nodes.get(p1.node.nodeId)?.position).toBe(6);
  });

  it('judges a write that leaves the card by the stored ask, and lands one that closes it', async () => {
    const { root, p0 } = await mergedP0();
    const p1 = await ask(root.nodeId);
    if (!p1.ok) throw new Error(p1.message);
    const reopened = await updatePlanNode(ctx(), {
      nodeId: p0.nodeId,
      expectedRevision: p0.revision,
      status: 'active',
    });
    expect(reopened.ok).toBe(true);
    const noted = await updatePlanNode(ctx(), {
      nodeId: p1.node.nodeId,
      expectedRevision: p1.node.revision,
      note: 'Still asking.',
    });
    expect(noted).toMatchObject({ ok: false, code: 'PLAN_NODE_DESIGN_NOT_MERGED' });
    const dropped = await updatePlanNode(ctx(), {
      nodeId: p1.node.nodeId,
      expectedRevision: p1.node.revision,
      status: 'dropped',
      outcome: 'P0 reopened.',
    });
    expect(dropped).toMatchObject({ ok: true, node: { status: 'dropped' } });
  });
});
