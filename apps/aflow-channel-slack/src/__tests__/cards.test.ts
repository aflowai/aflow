/**
 * Plan 327 D3 and §6, "the ceiling holds": the card offers buttons for the D3
 * table's rows only. Every other item renders with no buttons, a plan decision
 * and a plan ask included, and says it needs the operator at Aflow.
 */
import {
  ActionCenterItemKindSchema,
  ActionCenterItemOriginSchema,
  type ActionCenterItem,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { atAflowNote, cardHead, openFoot, planCard } from '../cards.js';
import type { SlackBlock } from '../slack.js';
import { STEP_ORIGIN, buttonsOf, makeItem, textOf, writeApproval } from './cardFixtures.js';

/** The rows of the D3 table that carry buttons, as kind and origin. */
const TABLE_ROWS = new Set([
  'human_input/step',
  'human_approval/step',
  'write_approval/step',
  'write_approval/workflow_task',
]);

const KINDS = ActionCenterItemKindSchema.options;
const ORIGIN_TYPES = ActionCenterItemOriginSchema.options.map((option) => option.shape.type.value);

/**
 * The item of this kind and origin most likely to earn buttons: open, every
 * action allowed, a boolean question, and a medium API write with its preview.
 * Built without the schema's parse, because only the origin's type is read.
 */
function bestCase(kind: ActionCenterItem['kind'], originType: string): ActionCenterItem {
  const base = makeItem({ resolutionSchema: { type: 'boolean' } });
  return {
    ...base,
    kind,
    origin: { ...STEP_ORIGIN, type: originType } as unknown as ActionCenterItem['origin'],
    allowedActions: ['submit', 'approve', 'reject', 'ratify', 'dismiss', 'connect'],
    ...(kind === 'write_approval' ? { extension: writeApproval('medium').extension } : {}),
  } as ActionCenterItem;
}

function rendered(item: ActionCenterItem) {
  const plan = planCard(item);
  return { plan, blocks: [...cardHead('Look at this.', item), ...openFoot(plan, item.title)] };
}

describe('the D3 table', () => {
  it('offers Yes and No for a boolean question from a paused step', () => {
    const { plan, blocks } = rendered(
      makeItem({ kind: 'human_input', resolutionSchema: { type: 'boolean' } }),
    );
    expect(plan.row).toBe('choices');
    expect(plan.controls.map((control) => control.resolution)).toEqual([
      { kind: 'submit', payload: true },
      { kind: 'submit', payload: false },
    ]);
    expect(buttonsOf(blocks)).toEqual(['choice:0', 'choice:1']);
  });

  it('offers one button per value for an enum question', () => {
    const { plan } = rendered(
      makeItem({
        kind: 'human_input',
        resolutionSchema: { type: 'string', enum: ['staging', 'prod'] },
      }),
    );
    expect(plan.controls.map((control) => [control.label, control.resolution])).toEqual([
      ['staging', { kind: 'submit', payload: 'staging' }],
      ['prod', { kind: 'submit', payload: 'prod' }],
    ]);
  });

  it('asks for a thread reply for a string question, with no button', () => {
    const { plan, blocks } = rendered(
      makeItem({ kind: 'human_input', resolutionSchema: { type: 'string' } }),
    );
    expect(plan.row).toBe('text_reply');
    expect(buttonsOf(blocks)).toEqual([]);
    expect(textOf(blocks)).toContain('Reply in this message’s thread to answer');
  });

  it('offers Approve and Deny for an approval from a paused step', () => {
    const { plan, blocks } = rendered(makeItem());
    expect(plan.row).toBe('approval');
    expect(plan.controls.map((control) => control.resolution.kind)).toEqual(['approve', 'reject']);
    expect(buttonsOf(blocks)).toEqual(['approve', 'reject']);
  });

  it.each(['low', 'medium'] as const)(
    'offers Approve and Deny for a %s API write, with the preview Plan 253 computed',
    (tier) => {
      const { plan, blocks } = rendered(writeApproval(tier));
      expect(plan.row).toBe('write_approval');
      expect(buttonsOf(blocks)).toEqual(['approve', 'reject']);
      const shown = textOf(blocks);
      expect(shown).toContain('POST api.github.com');
      expect(shown).toContain(`tier ${tier}`);
      expect(shown).toContain('\\"tag_name\\":\\"v1.4.0\\"');
      expect(shown).toContain('[redacted]');
    },
  );
});

describe('the ceiling', () => {
  const outside = KINDS.flatMap((kind) =>
    ORIGIN_TYPES.filter((type) => !TABLE_ROWS.has(`${kind}/${type}`)).map(
      (type) => [kind, type] as const,
    ),
  );

  it('covers every kind and every origin the schemas name', () => {
    expect(outside.length + TABLE_ROWS.size).toBe(KINDS.length * ORIGIN_TYPES.length);
  });

  it.each(outside)('renders %s from origin %s with no buttons, at Aflow', (kind, type) => {
    const item = bestCase(kind, type);
    const { plan, blocks } = rendered(item);
    expect(plan.controls).toEqual([]);
    expect(buttonsOf(blocks)).toEqual([]);
    expect(textOf(blocks)).toContain('it needs you at Aflow');
  });

  it.each([
    ['a plan decision', 'human_input', 'plan_decision'],
    ['a plan ask', 'human_approval', 'plan_ask'],
  ] as const)('gives %s no buttons, because its route refuses an API key', (_case, kind, type) => {
    const { plan, blocks } = rendered(bestCase(kind, type));
    expect(plan.row).toBe('at_aflow');
    expect(buttonsOf(blocks)).toEqual([]);
    expect(textOf(blocks)).toContain(atAflowNote('Ship the release'));
  });

  const narrowed: Array<[string, ActionCenterItem]> = [
    ['a high-tier API write', writeApproval('high')],
    [
      'a read-tier API write',
      {
        ...writeApproval(),
        extension: { ...writeApproval().extension, writeRiskTier: 'read' },
      } as ActionCenterItem,
    ],
    ...(['browser', 'local_model'] as const).map((target): [string, ActionCenterItem] => [
      `a ${target} write approval`,
      {
        ...makeItem({ kind: 'write_approval' }),
        extension: { kind: 'write_approval', target },
      } as ActionCenterItem,
    ]),
    ['a write approval with no preview', makeItem({ kind: 'write_approval' })],
    [
      'a question asking for an object',
      makeItem({ kind: 'human_input', resolutionSchema: { type: 'object', properties: {} } }),
    ],
    [
      'a question the author asked as a form',
      makeItem({
        kind: 'human_input',
        resolutionSchema: { type: 'boolean' },
        uiHints: { mode: 'form' },
      }),
    ],
    [
      'an enum too long for one row of buttons',
      makeItem({
        kind: 'human_input',
        resolutionSchema: { enum: Array.from({ length: 26 }, (_v, index) => `v${String(index)}`) },
      }),
    ],
    ['an approval no longer open', makeItem({ status: 'resolved' })],
    ['an approval the key may not approve', makeItem({ allowedActions: ['reassign'] })],
    [
      'a question the key may not answer',
      makeItem({ kind: 'human_input', allowedActions: [], resolutionSchema: { type: 'string' } }),
    ],
  ];

  it.each(narrowed)('renders %s with no buttons', (_case, item) => {
    const { plan, blocks } = rendered(item);
    expect(plan.controls).toEqual([]);
    expect(plan.row).toBe('at_aflow');
    expect(buttonsOf(blocks)).toEqual([]);
  });
});

describe('the card’s text across sections', () => {
  /** The mrkdwn text of each section block, in order. */
  function sectionTexts(blocks: readonly SlackBlock[]): string[] {
    return blocks.flatMap((block) => {
      const text = (block as { text?: { text?: unknown } }).text?.text;
      return block['type'] === 'section' && typeof text === 'string' ? [text] : [];
    });
  }

  /** True when `text` ends inside an entity, as `…&am` or `…&lt` does. */
  function endsInsideEntity(text: string): boolean {
    return /&[a-z]*$/.test(text);
  }

  it('never splits an entity where one section ends and the next begins', () => {
    const text = `${'a'.repeat(2_998)}&<>${'b'.repeat(10)}`;
    const agentText = sectionTexts(cardHead(text, makeItem())).slice(0, -1);

    expect(agentText.map((section) => section.length <= 3_000)).toEqual([true, true]);
    expect(agentText.some(endsInsideEntity)).toBe(false);
    expect(agentText[1]?.startsWith('&')).toBe(true);
    expect(agentText.join('')).toBe(`${'a'.repeat(2_998)}&amp;&lt;&gt;${'b'.repeat(10)}`);
  });

  it('cuts a text past the last section on a whole entity, and ends it with an ellipsis', () => {
    const agentText = sectionTexts(cardHead('&'.repeat(30_000), makeItem())).slice(0, -1);

    expect(agentText).toHaveLength(40);
    expect(agentText.every((section) => section.length <= 3_000)).toBe(true);
    expect(agentText.at(-1)?.endsWith('&amp;…')).toBe(true);
    expect(agentText.some((section) => endsInsideEntity(section.replace(/…$/, '')))).toBe(false);
  });

  it('cuts a summary that escapes past one section on a whole entity', () => {
    const item = makeItem({ summary: '<'.repeat(2_000) });
    const what = sectionTexts(cardHead('Look at this.', item)).at(-1) ?? '';

    expect(what.length).toBeLessThanOrEqual(3_000);
    expect(what.endsWith('&lt;…')).toBe(true);
  });
});
