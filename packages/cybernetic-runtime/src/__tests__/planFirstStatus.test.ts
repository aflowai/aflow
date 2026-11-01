/**
 * A node's first status is data (Plan 339 D6): approved work in the queue
 * starts active, and a node starts blocked only for a decision that is the
 * operator's, its card naming that decision. The rule is read through the
 * create schema and the engine, as the Helmsman's and the resident's writes go.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_ASK_HEAD,
  PlanNodeCreateInputSchema,
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

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('a node’s first status (Plan 339 D6)', () => {
  const approved: { work: PlanNodeWork; title: string }[] = [
    { work: 'approved_phase', title: 'P2 — a phase of an approved plan' },
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
    { reason: 'design_document', decision: 'Approve Plan 340’s design document.' },
    { reason: 'decision_change', decision: 'Amend Plan 322 D2.' },
    { reason: 'authority', decision: 'Let the resident push without asking.' },
    { reason: 'operator_question', decision: 'Answer the open question on the card.' },
  ];

  it.each(decisions)(
    'starts $reason blocked, its card naming the decision and its note saying it',
    async ({ reason, decision }) => {
      expect(planNodeFirstStatus(reason)).toBe('blocked');
      const node = await create({
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
});
