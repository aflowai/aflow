import { describe, it, expect } from 'vitest';

import { alignJudgeEntries, foldJudgeVerdict } from './judgeVerdict.js';

describe('criterion names are matched across punctuation the model normalises', () => {
  it('matches a typographic apostrophe against a straight one', () => {
    // A live batch lost a real judgement this way: the rubric asked about the
    // "customer’s terms" and the model answered about the "customer's terms",
    // so the answer found no home and the criterion read as unanswered.
    const aligned = alignJudgeEntries([{ criterion: 'gives the reason in the customer’s terms' }], {
      entries: [
        {
          criterion: "gives the reason in the customer's terms",
          rationale: 'it does',
          verdict: 'pass',
        },
      ],
    });
    expect(aligned[0]?.verdict).toBe('pass');
  });

  it('matches across dash forms and collapsed whitespace', () => {
    const aligned = alignJudgeEntries([{ criterion: 'states the amount — and the merchant' }], {
      entries: [
        { criterion: 'states the amount -  and the merchant', rationale: 'yes', verdict: 'pass' },
      ],
    });
    expect(aligned[0]?.verdict).toBe('pass');
  });

  it('still records a genuinely unanswered criterion', () => {
    const aligned = alignJudgeEntries([{ criterion: 'something else entirely' }], {
      entries: [{ criterion: 'unrelated', rationale: 'x', verdict: 'pass' }],
    });
    expect(aligned[0]?.verdict).toBe('unclear');
  });
});

describe('the score is over what the judge answered', () => {
  it('does not dilute a pass with an abstention beside it', () => {
    const aligned = alignJudgeEntries([{ criterion: 'a' }, { criterion: 'b' }], {
      entries: [{ criterion: 'a', rationale: 'met', verdict: 'pass' }],
    });
    const folded = foldJudgeVerdict(aligned);
    // One answered, and it passed. The abstention is carried by the verdict,
    // which routes to quality_unverified — not by a lower score.
    expect(folded.score).toBe(1);
    expect(folded.verdict).toBe('unclear');
  });

  it('scores a mixed answer over the answered ones', () => {
    const folded = foldJudgeVerdict([
      { criterion: 'a', rationale: 'met', verdict: 'pass' },
      { criterion: 'b', rationale: 'not met', verdict: 'fail' },
      { criterion: 'c', rationale: 'could not read', verdict: 'unclear' },
    ]);
    expect(folded.score).toBe(0.5);
    expect(folded.verdict).toBe('fail');
  });

  it('scores zero when the judge answered nothing', () => {
    const folded = foldJudgeVerdict([{ criterion: 'a', rationale: 'x', verdict: 'unclear' }]);
    expect(folded.score).toBe(0);
    expect(folded.verdict).toBe('unclear');
  });
});
