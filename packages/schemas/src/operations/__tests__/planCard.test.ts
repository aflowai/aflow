/**
 * The decision card on a plan node (Plan 337 D1, §5 "Shape"): six stored
 * sections, storage ceilings only, and Done when derived from `criteria`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCoreToolSpec,
  estimateStringTokens,
  PLAN_NODE_CARD_ITEM_MAX_CHARS,
  PLAN_NODE_CARD_KEYS_MESSAGE,
  PLAN_NODE_CARD_MAX_CHARS,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_UPDATE_FIELDS,
  planNodeCardInOrder,
  PlanNodeCardSchema,
  PlanNodeCreateInputSchema,
  PlanNodeGetOutputSchema,
  PlanNodeUpdateInputSchema,
  PlanStreamBriefNodeSchema,
  type PlanNodeCard,
} from '../../index.js';

const NODE_ID = '7b0c4b52-58a4-4c39-9a51-0d3f3c0b8a11';

const NODE = {
  kind: 'decide' as const,
  title: '337 · Plans the operator can decide from',
  goal: 'The operator decides a plan node from the board.',
  criteria: 'The operator approves or amends §3 from this card.',
};

/** Plan 337's own decision card, as its document opens with it. */
const PLAN_337_CARD: PlanNodeCard = {
  change: {
    today:
      'A node shows its goal, criteria and note as blocks of prose. The operator reads all of it to find the decision.',
    after:
      'A node that asks for a decision carries a card with fixed sections. The rail shows each section as a heading and a list.',
  },
  why: [
    'The operator has said that plans are hard to read and lack the structure a decision needs.',
    'The rail renders the goal, the criteria and the note each as one prose block (`PlanRail.tsx`).',
    'No field on the node holds a risk, an open question or a recommended answer (`plan.ts`).',
  ],
  affects: [
    '`@aflow/schemas`: the card on the node record and on its create and update inputs.',
    '`@aflow/database`: one nullable `card` column on `plan_nodes`, added by tenant migration.',
    '`@aflow/cybernetic-runtime`: the plan store reads and writes the column.',
    '`@aflow/web-product`: the rail renders the card and offers **Read the plan**.',
    'The Helmsman’s prompt, the `plan.node.*` usage text and the plan-document template in `docs/plans/README.md`.',
  ],
  risks: [
    {
      risk: 'Writers may fill each item with long prose. The card then reads as badly as the goal does today.',
    },
    {
      risk: 'The card on the node may drift from a plan document that changes after it.',
      mitigation: 'The node links the document at the sha the card matches.',
    },
    {
      risk: 'A tight ceiling refuses a useful card and makes the writer retry.',
      mitigation: 'The ceilings are storage ceilings, set generously.',
    },
    {
      risk: 'The card adds tokens to every `plan.node.get` the Helmsman reads.',
      mitigation: 'P1 measures the cost of a full card.',
    },
  ],
  questions: [
    {
      question: 'Does a node that asks for no decision carry a card?',
      recommended:
        'The field is optional on every node. The guidance asks for it only on nodes that ask for a decision.',
    },
    {
      question: 'Does **Approve** with no answer accept every recommended answer?',
      recommended: 'Yes. The note records each recommended answer under `Approved: …`.',
    },
    {
      question: 'Does the commission result carry the card as data?',
      recommended: 'Yes, as an optional field, added in P3.',
    },
    {
      question: 'How does a node link a plan document in a folder with no remote?',
      recommended: 'The link’s ref is the path and the sha, shown as text.',
    },
  ],
  notDoing: [
    'No validator reads the card’s style. Plan 333 D3 holds.',
    'No existing node or plan document is migrated.',
    'No plan body is stored in memory.',
    'No whole plan document is stored on the node.',
  ],
};

function withCard(card: unknown) {
  return PlanNodeCreateInputSchema.safeParse({ ...NODE, card });
}

function messages(result: ReturnType<typeof withCard>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('PlanNodeCardSchema — shape (Plan 337 §5)', () => {
  it('accepts a card with every section and an item at the item ceiling', () => {
    const item = 'x'.repeat(PLAN_NODE_CARD_ITEM_MAX_CHARS);
    expect(withCard({ ...PLAN_337_CARD, why: [item] }).success).toBe(true);
    expect(withCard(PLAN_337_CARD).success).toBe(true);
  });

  it('accepts empty risks, questions, affects and notDoing lists', () => {
    expect(withCard({ ...PLAN_337_CARD, risks: [] }).success).toBe(true);
    expect(
      withCard({ ...PLAN_337_CARD, risks: [], questions: [], affects: [], notDoing: [] }).success,
    ).toBe(true);
  });

  it('refuses a card that omits a section, an empty why and a change without after', () => {
    const { risks: _risks, ...noRisks } = PLAN_337_CARD;
    expect(withCard(noRisks).success).toBe(false);
    expect(withCard({ ...PLAN_337_CARD, why: [] }).success).toBe(false);
    expect(withCard({ ...PLAN_337_CARD, change: { today: 'Prose.' } }).success).toBe(false);
  });

  it('refuses a question with no recommended answer', () => {
    expect(
      withCard({ ...PLAN_337_CARD, questions: [{ question: 'Which store holds the body?' }] })
        .success,
    ).toBe(false);
  });

  it('refuses a card whose serialised form passes the whole-card ceiling, and says so', () => {
    const item = 'x'.repeat(PLAN_NODE_CARD_ITEM_MAX_CHARS);
    const count = Math.ceil(PLAN_NODE_CARD_MAX_CHARS / PLAN_NODE_CARD_ITEM_MAX_CHARS) + 1;
    const card = { ...PLAN_337_CARD, why: Array.from({ length: count }, () => item) };
    expect(JSON.stringify(card).length).toBeGreaterThan(PLAN_NODE_PROSE_MAX_CHARS);

    const result = withCard(card);
    expect(result.success).toBe(false);
    expect(messages(result).join(' ')).toContain(`at most ${String(PLAN_NODE_CARD_MAX_CHARS)}`);
  });

  it('accepts a card just under the whole-card ceiling', () => {
    const item = 'x'.repeat(PLAN_NODE_CARD_ITEM_MAX_CHARS);
    const base = { ...PLAN_337_CARD, why: [] as string[] };
    const room = PLAN_NODE_CARD_MAX_CHARS - JSON.stringify(base).length;
    const whole = Math.floor(room / (PLAN_NODE_CARD_ITEM_MAX_CHARS + 3));
    const card = { ...base, why: Array.from({ length: whole }, () => item) };
    expect(JSON.stringify(card).length).toBeLessThanOrEqual(PLAN_NODE_CARD_MAX_CHARS);
    expect(withCard(card).success).toBe(true);
  });
});

describe('PlanNodeCardSchema — no style check (Plan 333 D3)', () => {
  it('accepts an item of one 60-word sentence with a semicolon', () => {
    const sentence = `${Array.from({ length: 59 }, (_, i) => `word${String(i)}`).join(' ')}; end.`;
    expect(sentence.split(/\s+/)).toHaveLength(60);
    expect(withCard({ ...PLAN_337_CARD, why: [sentence] }).success).toBe(true);
  });
});

describe('PlanNodeCardSchema — Done when is derived from criteria', () => {
  it('refuses a card holding doneWhen as an unknown key, and names the sections', () => {
    const result = withCard({ ...PLAN_337_CARD, doneWhen: ['The operator approves §3.'] });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(PLAN_NODE_CARD_KEYS_MESSAGE);
  });

  it('keeps the card out of the brief a round is commissioned from', () => {
    expect(Object.keys(PlanStreamBriefNodeSchema.shape)).not.toContain('card');
  });
});

describe('card on the node record and its writes', () => {
  it('rides on plan.node.get and on an update alone, and is never null', () => {
    const node = {
      nodeId: NODE_ID,
      spaceId: NODE_ID,
      parentId: null,
      kind: 'decide',
      title: NODE.title,
      goal: NODE.goal,
      criteria: NODE.criteria,
      status: 'blocked',
      card: PLAN_337_CARD,
      revision: 1,
      position: 0,
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    };
    expect(PlanNodeGetOutputSchema.shape.node.safeParse(node).success).toBe(true);
    expect(PLAN_NODE_UPDATE_FIELDS).toContain('card');
    for (const [card, accepted] of [
      [PLAN_337_CARD, true],
      [null, false],
    ] as const) {
      expect(
        PlanNodeUpdateInputSchema.safeParse({ nodeId: NODE_ID, expectedRevision: 1, card }).success,
      ).toBe(accepted);
    }
  });

  it('returns a card in the schema’s section order, whatever order it was stored in', () => {
    const stored = Object.fromEntries(Object.entries(PLAN_337_CARD).reverse());
    expect(Object.keys(planNodeCardInOrder(stored))).toEqual(
      Object.keys(PlanNodeCardSchema.innerType().shape),
    );
  });

  it('declares the card’s whole shape to a turn, derived from the schema, without its ceilings', () => {
    for (const operationId of ['plan.node.create', 'plan.node.update']) {
      const spec = buildCoreToolSpec(operationId);
      const properties = (spec?.inputSchema as { properties: Record<string, unknown> }).properties;
      const declared = JSON.stringify(properties['card']);
      for (const key of [
        ...Object.keys(PlanNodeCardSchema.innerType().shape),
        'today',
        'after',
        'risk',
        'mitigation?',
        'question',
        'recommended',
      ]) {
        expect(declared).toContain(key);
      }
      expect(declared).not.toContain(String(PLAN_NODE_CARD_ITEM_MAX_CHARS));
    }
  });
});

describe('the token cost of a full card in plan.node.get (Plan 337 D1)', () => {
  it('costs 685 tokens for Plan 337’s own card, and at most 18,286 at the ceiling', () => {
    const own = estimateStringTokens(JSON.stringify(PLAN_337_CARD));
    expect(own).toBeGreaterThan(600);
    expect(own).toBeLessThan(800);
    expect(estimateStringTokens('x'.repeat(PLAN_NODE_CARD_MAX_CHARS))).toBe(18_286);
  });
});
