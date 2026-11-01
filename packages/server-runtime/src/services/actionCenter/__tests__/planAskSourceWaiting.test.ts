/**
 * The plan's Action Center source by the waiting rule (Plan 338 D1, D5): it
 * lists a node the moment it is blocked, with no wake and no ask record,
 * resolves what it listed, and titles the item from the schema's one table
 * of state labels.
 */
import { configureLogging } from '@aflow/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { PLAN_NODE_MERGE_WAIT_LINE, PLAN_STATE_LABELS, planItemSummary } from '@aflow/schemas';
import { InMemoryPlanNodeStore } from '../../../../../cybernetic-runtime/src/__tests__/planStoreFake.js';

let store: InMemoryPlanNodeStore;
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  ...(await original<typeof import('@aflow/cybernetic-runtime')>()),
  createPlanNodeStore: () => store,
  createResidentScheduleStore: () => ({}),
  requestResidentWake: vi.fn(),
}));

import { askedKey, createPlanNode, updatePlanNode } from '@aflow/cybernetic-runtime';
import type { ActionCenterContext } from '../types.js';
import { createPlanAskSource } from '../sources/planAskSource.js';
import { createPlanDecisionSource } from '../sources/planDecisionSource.js';

const scope = {
  tenantId: 'a0000000-0000-4000-8000-000000000338' as never,
  spaceId: '00000000-0000-4000-8000-000000000338',
};
const actor: ActionCenterContext = {
  ...scope,
  actorUserId: 'operator',
  actorSpaceRole: 'editor',
  actorIsTenantAdmin: false,
  actorIsInteractiveUser: true,
};

let redis: RedisType;

beforeEach(() => {
  configureLogging({ service: 'plan-ask-waiting-test', level: 'error', prettyPrint: false });
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
});

afterEach(() => {
  redis.disconnect();
});

const source = () => createPlanAskSource({ redis, db: {} as never, payloadStore: {} as never });

async function blocked(title: string) {
  const created = await createPlanNode(
    { ...scope, redis, store },
    { kind: 'execute', title, goal: 'g', criteria: 'c', proposed: 'Worth doing' },
  );
  if (!created.ok) throw new Error(created.message);
  return created.node;
}

it('lists a blocked root with no steps and no wake, titled from the table, and approving it opens it', async () => {
  const node = await blocked('Approve **the next step**');
  expect(node).toMatchObject({ parentId: null, status: 'blocked' });
  expect(await redis.get(askedKey(scope.tenantId, scope.spaceId, node.nodeId))).toBeNull();

  const items = await source().listOpen(scope);
  expect(items).toMatchObject([
    {
      id: `plan-ask:${node.nodeId}`,
      kind: 'human_approval',
      origin: { type: 'plan_ask', nodeId: node.nodeId, revision: node.revision },
      // The node's markdown reaches the client as written, for it to render.
      title: 'Pending approval · Approve **the next step**',
      uiHints: { approveLabel: 'Approve', rejectLabel: 'Drop' },
    },
  ]);
  const item = items[0]!;
  expect(await source().getById(actor, item.id)).toEqual(item);

  await source().resolve(actor, item, { kind: 'approve' }, item.origin);
  expect(store.nodes.get(node.nodeId)?.status).toBe('active');
  expect(await source().listOpen(scope)).toEqual([]);
});

it('titles a merge wait Pending review and keeps Close done on its control', async () => {
  const created = await createPlanNode(
    { ...scope, redis, store },
    { kind: 'execute', title: 'Merge', goal: 'g', criteria: 'c' },
  );
  if (!created.ok) throw new Error(created.message);
  const written = await updatePlanNode(
    { ...scope, redis, store },
    {
      nodeId: created.node.nodeId,
      expectedRevision: created.node.revision,
      note: PLAN_NODE_MERGE_WAIT_LINE,
    },
  );
  expect(written.ok).toBe(true);
  expect(await source().listOpen(scope)).toMatchObject([
    { title: 'Pending review · Merge', uiHints: { approveLabel: 'Close done' } },
  ]);
});

describe('the item summary', () => {
  const prose = (n: number) => 'p'.repeat(n);

  it('keeps a text that fits as written, an open fence included', () => {
    expect(planItemSummary('Waiting on you: approve it')).toBe('Waiting on you: approve it');
    expect(planItemSummary('Look:\n```ts\nconst a = 1;')).toBe('Look:\n```ts\nconst a = 1;');
  });

  it('keeps a text of exactly 2,000 characters whole, with no mark', () => {
    expect(planItemSummary(prose(2_000))).toBe(prose(2_000));
  });

  it('cuts a long text with no fence open at the cut and ends it with an ellipsis', () => {
    const text = `${prose(10)}\n\`\`\`\ncode\n\`\`\`\n${prose(3_000)}`;
    expect(planItemSummary(text)).toBe(`${text.slice(0, 1_998)}…`);
  });

  it('cuts prose before an inline construct the cut would leave open, as a title is cut', () => {
    const text = `${prose(1_990)} [a link](https://example.com/${prose(50)}) ${prose(100)}`;
    expect(planItemSummary(text)).toBe(`${prose(1_990)}…`);
  });

  it('puts the ellipsis on a line of its own below a closing fence', () => {
    const text = `\`\`\`\ncode\n\`\`\`\n*${'x'.repeat(3_000)}`;
    expect(planItemSummary(text)).toBe('```\ncode\n```\n…');
  });

  it('closes a fence the cut leaves open and puts the ellipsis below it, within 2,000 characters', () => {
    const text = `${prose(100)}\n~~~~python\n${'x = 1\n'.repeat(600)}~~~~\nAfter the code.`;
    const summary = planItemSummary(text);
    expect(summary.length).toBeLessThanOrEqual(2_000);
    expect(summary.length).toBeGreaterThan(1_990);
    expect(summary.endsWith('\n~~~~\n…')).toBe(true);
    expect(text.startsWith(summary.slice(0, -'\n~~~~\n…'.length))).toBe(true);
  });

  it('closes a backtick fence with a run as long as the one that opened it', () => {
    const text = `\`\`\`\`\n${'y'.repeat(3_000)}`;
    const summary = planItemSummary(text);
    expect(summary).toHaveLength(2_000);
    expect(summary.endsWith('\n````\n…')).toBe(true);
  });

  it('reads a closing run shorter than the opening one as code, not as the close', () => {
    const text = `\`\`\`\`\n\`\`\`\n${'y'.repeat(3_000)}`;
    expect(planItemSummary(text).endsWith('\n````\n…')).toBe(true);
  });
});

describe('the two plan sources cut alike', () => {
  /** A waiting node's item and an open decision's item over one overlong text. */
  async function bothItems(text: string) {
    const waiting = await createPlanNode(
      { ...scope, redis, store },
      { kind: 'execute', title: 'Merge', goal: 'g', criteria: 'c' },
    );
    if (!waiting.ok) throw new Error(waiting.message);
    const noted = await updatePlanNode(
      { ...scope, redis, store },
      {
        nodeId: waiting.node.nodeId,
        expectedRevision: waiting.node.revision,
        note: `${PLAN_NODE_MERGE_WAIT_LINE}\n${text}`,
      },
    );
    if (!noted.ok) throw new Error(noted.message);
    const choice = await createPlanNode(
      { ...scope, redis, store },
      {
        kind: 'decide',
        title: 'Which way',
        goal: `${PLAN_NODE_MERGE_WAIT_LINE}\n${text}`,
        criteria: 'c',
      },
    );
    if (!choice.ok) throw new Error(choice.message);
    const [ask] = await source().listOpen(scope);
    const [decision] = await createPlanDecisionSource({
      redis,
      db: {} as never,
      payloadStore: {} as never,
    }).listOpen(scope);
    if (!ask || !decision) throw new Error('Both sources should list their node');
    return { ask, decision };
  }

  it.each([
    ['prose', 'p'.repeat(3_000)],
    ['an inline construct across the cut', `${'p'.repeat(1_900)} **bold ${'b'.repeat(500)}**`],
    ['an open fence', `\`\`\`ts\n${'const a = 1;\n'.repeat(300)}\`\`\``],
  ])('cuts %s at the same place, with the same mark', async (_name, text) => {
    const { ask, decision } = await bothItems(text);
    expect(ask.summary).toBe(decision.summary);
    expect(ask.summary.length).toBeLessThanOrEqual(2_000);
    expect(ask.summary.endsWith('…')).toBe(true);
  });
});

it('writes the item title from the schema table, so a label changed there changes the item', async () => {
  await blocked('Ship it');
  const labels = PLAN_STATE_LABELS.itemTitle as { blocked: string };
  const before = labels.blocked;
  labels.blocked = 'Awaiting sign-off';
  try {
    expect((await source().listOpen(scope))[0]?.title).toBe('Awaiting sign-off · Ship it');
  } finally {
    labels.blocked = before;
  }
});
