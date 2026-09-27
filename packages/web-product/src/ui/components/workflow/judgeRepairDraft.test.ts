import { describe, expect, it } from 'vitest';

import { buildJudgeRepairDraft, type JudgeDisagreement } from './judgeRepairDraft.js';

const base = {
  criterionName: 'Tone stays civil',
  criterionId: 'tone',
  evalSuitePath: '/evals/support/suite.json',
  scopeKey: 'goal',
};

function disagreement(n: number, critique: string): JudgeDisagreement {
  return {
    runId: `run-${String(n)}`,
    verdict: 'pass',
    judgeLabel: 'fail',
    critique,
  };
}

describe('buildJudgeRepairDraft', () => {
  it('carries the criterion, the suite and every recorded critique', () => {
    const draft = buildJudgeRepairDraft({
      ...base,
      disagreements: [disagreement(1, 'The reply was direct, not rude.')],
    });
    expect(draft).toContain('Tone stays civil');
    expect(draft).toContain('tone (goal)');
    expect(draft).toContain('/evals/support/suite.json');
    expect(draft).toContain('run-1');
    expect(draft).toContain('The reply was direct, not rude.');
    expect(draft).not.toContain('further');
  });

  it('says so when the labels it read are only a page of them', () => {
    const draft = buildJudgeRepairDraft({
      ...base,
      disagreements: [disagreement(1, 'wrong')],
      sampledFrom: { read: 100, total: 240 },
    });
    expect(draft).toContain('100 most recent of 240 labels');
    expect(encodeURIComponent(draft).length).toBeLessThanOrEqual(6000);
  });

  it('claims nothing about truncation when it read everything', () => {
    const draft = buildJudgeRepairDraft({
      ...base,
      disagreements: [disagreement(1, 'wrong')],
      sampledFrom: { read: 12, total: 12 },
    });
    expect(draft).not.toContain('most recent');
  });

  it('leaves the judge the option of being right', () => {
    const draft = buildJudgeRepairDraft({ ...base, disagreements: [disagreement(1, 'wrong')] });
    expect(draft).toContain('say so instead of changing it');
  });

  it('names a label that recorded no judge verdict rather than inventing one', () => {
    const draft = buildJudgeRepairDraft({
      ...base,
      disagreements: [{ ...disagreement(1, 'why'), judgeLabel: null }],
    });
    expect(draft).toContain('no recorded verdict');
  });

  it('quotes whole critiques within the budget and reports the remainder', () => {
    const long = 'x'.repeat(1000);
    const draft = buildJudgeRepairDraft({
      ...base,
      disagreements: Array.from({ length: 20 }, (_, i) => disagreement(i, long)),
    });
    expect(encodeURIComponent(draft).length).toBeLessThanOrEqual(6000);
    expect(draft).toContain('further');
    expect(draft).toContain('not quoted here');
    // No critique is cut mid-word: every quoted one appears whole.
    const quoted = draft.split(long).length - 1;
    expect(quoted).toBeGreaterThan(0);
    expect(draft).toContain(`${String(20 - quoted)} further`);
  });

  it('holds the ceiling even when the only critique is oversized', () => {
    // The draft travels as a query parameter. Quoting a critique past the
    // budget produced a link that fails on navigation, which loses the whole
    // request rather than one quotation.
    const huge = 'y'.repeat(9000);
    const draft = buildJudgeRepairDraft({ ...base, disagreements: [disagreement(1, huge)] });
    expect(draft).not.toContain(huge);
    expect(encodeURIComponent(draft).length).toBeLessThanOrEqual(6000);
    expect(draft).toContain('longer than a link can carry');
  });

  it('measures the budget after percent-encoding, not before', () => {
    // Newlines and spaces triple under encoding, so a draft inside the budget
    // as plain text can be well past it as a URL.
    const spaced = 'a '.repeat(1200);
    const draft = buildJudgeRepairDraft({
      ...base,
      disagreements: [disagreement(1, spaced), disagreement(2, spaced)],
    });
    expect(encodeURIComponent(draft).length).toBeLessThanOrEqual(6000);
  });
});
