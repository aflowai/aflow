/**
 * The one table of plan state labels (Plan 338 D5), the item title written
 * from it, and the walk's merge-wait flag on a summary (D1).
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_NODE_MERGE_WAIT_LINE,
  PLAN_STATE_LABELS,
  PlanNodeSummarySchema,
  planItemTitle,
  planNoteHoldsMergeWait,
} from '../../index.js';

describe('PLAN_STATE_LABELS', () => {
  it('names each state as D5’s table does', () => {
    expect(PLAN_STATE_LABELS.column).toEqual({
      needs_you: 'Pending',
      in_flight: 'Running',
      up_next: 'Queued',
      done: 'Done',
      dropped: 'Dropped',
    });
    expect(PLAN_STATE_LABELS.reason).toEqual({
      blocked: 'Approval',
      decide: 'Decision',
      stranded: 'Under a closed step',
    });
    expect(PLAN_STATE_LABELS).toMatchObject({
      planNeedsYou: 'Pending approval',
      pendingCountNoun: 'pending',
      pendingEmpty: 'Nothing pending',
      workbenchSection: 'Pending',
    });
  });

  it('titles an item from the table, cut to the item title’s length', () => {
    expect(planItemTitle('blocked', 'Ship it')).toBe('Pending approval · Ship it');
    expect(planItemTitle('merge_wait', 'Merge')).toBe('Pending review · Merge');
    expect(planItemTitle('decide', 'Which way')).toBe('Pending decision · Which way');
    expect(planItemTitle('blocked', 'x'.repeat(400))).toHaveLength(256);
    expect(planItemTitle('blocked', 'x'.repeat(400)).endsWith('…')).toBe(true);
    const fits = `Pending approval · ${'y'.repeat(256 - 'Pending approval · '.length)}`;
    expect(planItemTitle('blocked', fits.slice('Pending approval · '.length))).toBe(fits);
  });

  describe('a title cut to fit', () => {
    const head = 'Pending approval · ';
    /** Pads before `tail` so the full title runs `over` characters past the ceiling. */
    const pastCeiling = (tail: string, over = 20) =>
      `${'w '.repeat(Math.ceil((256 - head.length - tail.length + over) / 2))}${tail}`;

    it.each([
      ['a code span', '`some code that runs on`'],
      ['emphasis', '**strong words that run on**'],
      ['underscore emphasis', '_leaning words that run on_'],
      ['strikethrough', '~~struck words that run on~~'],
      ['a link’s text', '[the linked words](https://example.com/a)'],
      ['a link’s destination', '[link](https://example.com/a/long/path/that/runs)'],
      ['an autolink', '<https://example.com/a/long/path/that/runs/on>'],
    ])('cuts before %s the ceiling falls inside, never in it', (_, tail) => {
      const title = pastCeiling(tail);
      const cut = planItemTitle('blocked', title);
      expect(cut.length).toBeLessThanOrEqual(256);
      expect(cut).toBe(`${head}${title.slice(0, title.indexOf(tail)).trimEnd()}…`);
    });

    it('keeps a construct that closes before the ceiling', () => {
      const title = `**done** and \`code\` and [a](https://x.y) ${'z'.repeat(400)}`;
      const cut = planItemTitle('blocked', title);
      expect(cut).toHaveLength(256);
      expect(cut.startsWith(`${head}**done** and \`code\` and [a](https://x.y) zzz`)).toBe(true);
    });

    it('reads an underscore inside a word and an escaped star as text', () => {
      const title = `snake_case and \\*literal ${'z'.repeat(400)}`;
      const cut = planItemTitle('blocked', title);
      expect(cut).toHaveLength(256);
      expect(cut.startsWith(`${head}snake_case and \\*literal zzz`)).toBe(true);
    });

    it.each([
      ['a stray backtick', '`', '\\`'],
      ['a "<" followed by a letter', '<b', '\\<b'],
      ['an intra-word "*"', 'snake*case', 'snake\\*case'],
      ['a code span the ceiling falls in', '``a code span', '\\`\\`a code span'],
    ])(
      'cuts at the ceiling and escapes %s that opens before the last 80 characters',
      (_, raw, escaped) => {
        const title = `${raw} ${'w '.repeat(200)}`;
        const cut = planItemTitle('blocked', title);
        expect(cut.length).toBeLessThanOrEqual(256);
        expect(cut.startsWith(`${head}${escaped} w w`)).toBe(true);
        const kept = cut.slice(head.length, -1).replace(escaped, raw);
        expect(title.startsWith(kept)).toBe(true);
        expect(kept.length).toBeGreaterThanOrEqual(256 - head.length - 1 - 80);
      },
    );

    it('escapes what an escaped opener exposes', () => {
      const title = `\`*lean ${'w '.repeat(200)}`;
      const cut = planItemTitle('blocked', title);
      expect(cut.startsWith(`${head}\\\`\\*lean w`)).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(256);
    });

    it('does not cut a surrogate pair in half', () => {
      const budget = 256 - head.length - 1;
      // One letter first, where the budget is even, puts the ceiling inside a pair.
      const lead = budget % 2 === 0 ? 'a' : '';
      const cut = planItemTitle('blocked', `${lead}${'😀'.repeat(200)}`);
      expect(cut).toBe(`${head}${lead}${'😀'.repeat(Math.floor((budget - lead.length) / 2))}…`);
      expect(cut.length).toBe(255);
    });
  });
});

describe('the merge-wait flag', () => {
  it('reads the line anywhere in the note', () => {
    expect(planNoteHoldsMergeWait(`Context\n${PLAN_NODE_MERGE_WAIT_LINE}`)).toBe(true);
    expect(planNoteHoldsMergeWait('Waiting on you: approve it')).toBe(false);
    expect(planNoteHoldsMergeWait(undefined)).toBe(false);
  });

  it('is carried on a summary as true or not at all', () => {
    const summary = {
      nodeId: '00000000-0000-4000-8000-000000000001',
      parentId: null,
      kind: 'execute',
      title: 'Merge',
      status: 'active',
      revision: 2,
      position: 0,
      createdAt: '2026-10-31T10:00:00.000Z',
      updatedAt: '2026-10-31T10:00:00.000Z',
    };
    expect(PlanNodeSummarySchema.safeParse({ ...summary, mergeWait: true }).success).toBe(true);
    expect(PlanNodeSummarySchema.safeParse({ ...summary, mergeWait: false }).success).toBe(false);
    expect(PlanNodeSummarySchema.safeParse(summary).success).toBe(true);
  });
});
