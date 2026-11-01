/**
 * What waits on a person, in the Helmsman's attention block (Plan 338 D2): a
 * count per kind and the newest few items, each a title, an Action Center id
 * and, for a plan step, its link. The plan-step count reads as the sidebar's,
 * the section holds no item body, and it fits its measured ceiling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  ACTION_CENTER_ITEM_ID_PREFIX,
  ACTION_CENTER_LIST_LIMIT,
  estimateStringTokens,
  PLAN_OPEN_ASKS_LIMIT,
  pendingPlanStepCount,
  planItemTitle,
  type PlanNode,
} from '@aflow/schemas';
import { InMemoryPlanNodeStore } from './planStoreFake.js';
import type { WaitingGates } from '../waitingOnPerson.js';

const fakeStore = { current: new InMemoryPlanNodeStore() };
const fakeGates: { current: { gates: WaitingGates; spaceSlug?: string } } = {
  current: { gates: { runGates: 0, consents: 0, newest: [] } },
};

vi.mock('../plan/store.js', async () => {
  const actual = await vi.importActual<typeof import('../plan/store.js')>('../plan/store.js');
  return { ...actual, createPlanNodeStore: () => fakeStore.current };
});
vi.mock('../waitingOnPerson.js', async () => {
  const actual =
    await vi.importActual<typeof import('../waitingOnPerson.js')>('../waitingOnPerson.js');
  return { ...actual, readWaitingGates: () => Promise.resolve(fakeGates.current) };
});
vi.mock('../ledger/queries.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/queries.js')>('../ledger/queries.js');
  return {
    ...actual,
    listActiveRunsWithLiveness: () => Promise.resolve([]),
    listPlanNodeIdsDrivenBySession: () => Promise.resolve([]),
  };
});
vi.mock('../ledger/attention.js', async () => {
  const actual =
    await vi.importActual<typeof import('../ledger/attention.js')>('../ledger/attention.js');
  return { ...actual, readPendingRunAttention: () => Promise.resolve({ items: [], counts: [] }) };
});
vi.mock('../skill.js', async () => {
  const actual = await vi.importActual<typeof import('../skill.js')>('../skill.js');
  return { ...actual, listSkillsForSpace: () => Promise.resolve([]) };
});
vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    withTenantSchema: () => Promise.resolve([]),
    createAppletPersistence: () => ({
      transact: () => Promise.resolve({ items: [], total: 0 }),
    }),
  };
});

const { readAttentionForTurn } = await import('../attentionTurn.js');
const {
  renderWaitingOnPerson,
  waitingItemTitle,
  WAITING_ON_PERSON_LINE_LIMIT,
  WAITING_ON_PERSON_TITLE_MAX_CHARS,
  WAITING_ON_PERSON_TOKEN_CEILING,
} = await import('../waitingOnPerson.js');
const { listWaitingNodes } = await import('../plan/asks.js');
const { listOpenDecisions, openPlanNode } = await import('../plan/operations.js');

const TENANT = 'a0000000-0000-4000-8000-000000000338';
const SPACE = '5e1d0000-0000-4000-8000-000000000338';
const SLUG = 'helm-338';
const SESSION = 'c0000000-0000-4000-8000-000000000338';

let redis: RedisType;

beforeEach(async () => {
  fakeStore.current = new InMemoryPlanNodeStore();
  fakeGates.current = { gates: { runGates: 0, consents: 0, newest: [] }, spaceSlug: SLUG };
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

/** The attention block one Helmsman turn reads. */
async function turn(): Promise<string> {
  const read = await readAttentionForTurn({
    tenantId: TENANT,
    spaceId: SPACE,
    conversation: { sessionId: SESSION, planRootIds: [] },
    db: {} as never,
    redis,
  });
  return read.text;
}

/** The section's lines, from its heading to the blank line that ends it. */
async function section(): Promise<string[]> {
  const lines = (await turn()).split('\n');
  const from = lines.findIndex((line) => line.startsWith('Waiting on a person:'));
  expect(from).toBeGreaterThanOrEqual(0);
  const to = lines.indexOf('', from);
  return lines.slice(from, to === -1 ? undefined : to);
}

function blocked(title: string, extra: Partial<PlanNode> = {}): PlanNode {
  return fakeStore.current.seed(SPACE, { title, status: 'blocked', ...extra });
}

function decision(title: string): PlanNode {
  return fakeStore.current.seed(SPACE, { title, kind: 'decide', status: 'active' });
}

/** The count the sidebar shows for the space's Action Center list as it stands. */
async function sidebarCount(): Promise<string> {
  const ctx = { store: fakeStore.current, spaceId: SPACE };
  const asks = (await listWaitingNodes(ctx)).length;
  const decisions = (await listOpenDecisions(ctx)).length;
  return pendingPlanStepCount({
    asks,
    decisions,
    listMayBeCut: asks + decisions >= ACTION_CENTER_LIST_LIMIT,
  }).label;
}

describe('the section names the item and the place', () => {
  it("carries a plan step's title, its item id and its plan link", async () => {
    const step = blocked('P1 — the source lists every waiting node');
    const lines = await section();
    expect(lines[0]).toBe(
      'Waiting on a person: 1 plan step, 0 run gates, 0 consents. Point with the plan link or `human.action_center.focus`:',
    );
    expect(lines[1]).toBe(
      `- plan step "${planItemTitle('blocked', step.title)}" [itemId: ${ACTION_CENTER_ITEM_ID_PREFIX.planAsk}${step.nodeId}] /s/${SLUG}/plan?node=${step.nodeId}`,
    );
  });

  it('carries a decision under its own item id, and a run gate with no plan link', async () => {
    const choice = decision('Pick the store');
    fakeGates.current = {
      gates: {
        runGates: 1,
        consents: 0,
        newest: [
          {
            kind: 'run_gate',
            itemId: 'step:5e1d0000-0000-4000-8000-0000000000aa',
            title: 'Approve write: send the invoice',
            requestedAt: '2099-01-01T00:00:00.000Z',
          },
        ],
      },
      spaceSlug: SLUG,
    };
    const lines = await section();
    expect(lines[0]).toContain('1 plan step, 1 run gate, 0 consents.');
    // Newest first: the gate was asked after the decision.
    expect(lines[1]).toBe(
      '- run gate "Approve write: send the invoice" [itemId: step:5e1d0000-0000-4000-8000-0000000000aa]',
    );
    expect(lines[2]).toBe(
      `- plan step "${planItemTitle('decide', choice.title)}" [itemId: ${ACTION_CENTER_ITEM_ID_PREFIX.planDecision}${choice.nodeId}] /s/${SLUG}/plan?node=${choice.nodeId}`,
    );
  });

  it('says so when nothing waits, and lists nothing', async () => {
    expect(await section()).toEqual([
      'Waiting on a person: 0 plan steps, 0 run gates, 0 consents.',
    ]);
  });

  it('names a count it could not read as unread rather than zero', () => {
    expect(renderWaitingOnPerson({ planSteps: { asks: 2, decisions: 0 }, items: [] })).toEqual([
      'Waiting on a person: 2 plan steps. The run gates and consents could not be read.',
    ]);
  });
});

describe("the plan-step count agrees with the sidebar's rule", () => {
  it.each([
    { blockedNodes: 49, decisions: 0, shown: '49' },
    { blockedNodes: 50, decisions: 0, shown: '50+' },
    { blockedNodes: 52, decisions: 0, shown: '50+' },
    { blockedNodes: 50, decisions: 2, shown: '52+' },
  ])(
    'reads $shown for $blockedNodes waiting nodes and $decisions decisions',
    async ({ blockedNodes, decisions, shown }) => {
      for (let i = 0; i < blockedNodes; i++) blocked(`step ${String(i)}`);
      for (let i = 0; i < decisions; i++) decision(`choice ${String(i)}`);
      expect(await sidebarCount()).toBe(shown);
      const [heading] = await section();
      expect(heading).toMatch(
        new RegExp(`^Waiting on a person: ${shown.replace('+', '\\+')} plan steps,`),
      );
    },
  );
});

describe('the section holds no item body', () => {
  it('carries neither the step’s note nor its goal, nor the item’s summary', async () => {
    blocked('Ship the importer', {
      note: 'NOTE-SENTINEL: the vendor contract needs legal sign-off first.',
      goal: 'GOAL-SENTINEL: the importer reads every vendor file.',
      criteria: 'CRITERIA-SENTINEL',
    });
    decision('Pick the store');
    const text = (await section()).join('\n');
    expect(text).toContain('Ship the importer');
    expect(text).not.toMatch(/SENTINEL/);
    // The item's summary is what it waits on, written from the note or the ask line.
    expect(text).not.toContain('Waiting on you:');
    expect(text).not.toContain('Decided when');
  });
});

describe('the section moves with the plan', () => {
  it('drops the count by one once a step is approved, and is not consumed by a turn', async () => {
    const first = blocked('Approve the first step');
    blocked('Approve the second step');
    expect((await section())[0]).toContain('2 plan steps,');
    // Shown again: a turn does not consume these lines.
    expect((await section())[0]).toContain('2 plan steps,');

    const approved = await openPlanNode(
      {
        store: fakeStore.current,
        redis,
        tenantId: TENANT,
        spaceId: SPACE,
        createdBy: 'operator',
        actorKind: 'human',
      },
      { nodeId: first.nodeId, expectedRevision: first.revision },
    );
    expect(approved.ok).toBe(true);
    const lines = await section();
    expect(lines[0]).toContain('1 plan step,');
    expect(lines.join('\n')).not.toContain(first.nodeId);
  });
});

describe('the ceiling', () => {
  it(`holds five lines at the longest title and id within ${String(WAITING_ON_PERSON_TOKEN_CEILING)} tokens`, () => {
    const longestSlug = 'a'.repeat(64);
    const nodeId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    // Every line at its longest: the plan-step line, which adds the link to
    // its id, against the longest gate id, a human task's at a 64-character task id.
    const planStepLine = {
      kind: 'plan_step' as const,
      itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.planDecision}${nodeId}`,
      title: waitingItemTitle('W'.repeat(400)),
      requestedAt: '2026-11-01T00:00:00.000Z',
      planNodeId: nodeId,
    };
    const gateLine = {
      kind: 'run_gate' as const,
      itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowHumanTask}${nodeId}:${'t'.repeat(64)}`,
      title: waitingItemTitle('W'.repeat(400)),
      requestedAt: '2026-11-01T00:00:00.000Z',
    };
    const render = (item: typeof planStepLine | typeof gateLine) =>
      renderWaitingOnPerson({ items: [item], spaceSlug: longestSlug })[1]!;
    const longest =
      render(planStepLine).length >= render(gateLine).length ? planStepLine : gateLine;

    const text = renderWaitingOnPerson({
      planSteps: { asks: PLAN_OPEN_ASKS_LIMIT, decisions: PLAN_OPEN_ASKS_LIMIT },
      gates: { runGates: 99_999, consents: 99_999 },
      items: Array.from({ length: WAITING_ON_PERSON_LINE_LIMIT }, () => longest),
      spaceSlug: longestSlug,
    }).join('\n');

    expect(planStepLine.title).toHaveLength(WAITING_ON_PERSON_TITLE_MAX_CHARS);
    expect(text.split('\n')).toHaveLength(WAITING_ON_PERSON_LINE_LIMIT + 1);
    expect(estimateStringTokens(text)).toBeLessThanOrEqual(WAITING_ON_PERSON_TOKEN_CEILING);
  });

  it('cuts a title to 120 characters on one line, never inside a surrogate pair', () => {
    expect(waitingItemTitle('a\nb')).toBe('a b');
    const cut = waitingItemTitle(`${'x'.repeat(118)}😀😀😀`);
    expect(cut).toHaveLength(WAITING_ON_PERSON_TITLE_MAX_CHARS - 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});
