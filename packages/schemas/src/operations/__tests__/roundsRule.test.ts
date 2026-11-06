/**
 * The rounds rule as a table: each case a publication's review can be in —
 * its round, its severest finding and its verdict — is decided by one row, or
 * by none, which is the decision model's case.
 */
import { describe, expect, it } from 'vitest';

import { NEEDS_SETUP_FINDING_KIND } from '../hostCommitDescribe.js';
import {
  ROUNDS_RULE,
  ROUNDS_RULE_FIRST_MINOR_REASON,
  ROUNDS_RULE_LATER_REASON,
  ROUNDS_RULE_MAJOR_REASON,
  ROUNDS_RULE_NITS_ONLY_REASON,
  ROUNDS_RULE_ROUNDS,
  ROUNDS_RULE_SEVERESTS,
  ROUNDS_RULE_VERDICTS,
  RoundsRuleTableSchema,
  roundsRuleRound,
  roundsRuleRow,
  roundsRuleSeverest,
  type RoundsRuleRound,
  type RoundsRuleSeverest,
  type RoundsRuleVerdict,
} from '../roundsRule.js';

type Expected = readonly [string, string] | null;

const FIX = 'fix_before_merge';
const PUBLISH = 'publish_as_is';

/** The operator's rule, case by case: what each round, severest finding and verdict decides. */
function expected(
  round: RoundsRuleRound,
  severest: RoundsRuleSeverest,
  verdict: RoundsRuleVerdict,
): Expected {
  if (severest === 'blocker' || severest === 'major') return [FIX, ROUNDS_RULE_MAJOR_REASON];
  if (round === 'first' && severest === 'minor' && verdict !== 'request_changes') {
    return [FIX, ROUNDS_RULE_FIRST_MINOR_REASON];
  }
  if (round === 'later' && (severest === 'minor' || severest === 'nit')) {
    return [PUBLISH, ROUNDS_RULE_LATER_REASON];
  }
  if (verdict === 'approve' && (severest === 'none' || (round === 'first' && severest === 'nit'))) {
    return [PUBLISH, ROUNDS_RULE_NITS_ONLY_REASON];
  }
  return null;
}

describe('the rounds rule table', () => {
  for (const round of ROUNDS_RULE_ROUNDS) {
    for (const severest of ROUNDS_RULE_SEVERESTS) {
      for (const verdict of ROUNDS_RULE_VERDICTS) {
        const want = expected(round, severest, verdict);
        it(`${round} round, severest ${severest}, ${verdict}: ${want?.[0] ?? 'no row'}`, () => {
          const row = roundsRuleRow({ round, severest, verdict });
          expect(row === null ? null : [row.decision, row.reason]).toEqual(want);
        });
      }
    }
  }

  it('decides a round 2 `comment` over minors and nits publish_as_is', () => {
    const row = roundsRuleRow({
      round: roundsRuleRound(2),
      severest: roundsRuleSeverest([{ severity: 'minor' }, { severity: 'nit' }]),
      verdict: 'comment',
    });
    expect(row?.decision).toBe(PUBLISH);
  });

  it('decides a round 1 minor fix_before_merge, and a major fix_before_merge at every round', () => {
    expect(roundsRuleRow({ round: 'first', severest: 'minor', verdict: 'approve' })?.decision).toBe(
      FIX,
    );
    for (const round of [1, 2, 7]) {
      for (const verdict of ROUNDS_RULE_VERDICTS) {
        expect(
          roundsRuleRow({ round: roundsRuleRound(round), severest: 'major', verdict })?.decision,
        ).toBe(FIX);
      }
    }
  });

  it('keeps the approve path over no findings on round 1', () => {
    expect(roundsRuleRow({ round: 'first', severest: 'none', verdict: 'approve' })).toMatchObject({
      decision: PUBLISH,
      reason: ROUNDS_RULE_NITS_ONLY_REASON,
    });
  });

  it('leaves to the model a review short of approve that names nothing above a nit on round 1', () => {
    for (const verdict of ['comment', 'request_changes'] as const) {
      for (const severest of ['nit', 'none'] as const) {
        expect(roundsRuleRow({ round: 'first', severest, verdict })).toBeNull();
      }
    }
    expect(roundsRuleRow({ round: 'first', severest: 'none', verdict: null })).toBeNull();
  });

  it('refuses a table whose rows overlap', () => {
    const overlapping = RoundsRuleTableSchema.safeParse([
      ...ROUNDS_RULE,
      { ...ROUNDS_RULE[0]!, rounds: ['later'], severest: ['major'], verdicts: ['comment'] },
    ]);
    expect(overlapping.success).toBe(false);
    expect(overlapping.error?.issues[0]?.message).toContain('later/major/comment');
  });
});

describe('the facts the table reads', () => {
  it('reads a missing round, and round 1, as the first', () => {
    expect([null, undefined, 1].map(roundsRuleRound)).toEqual(['first', 'first', 'first']);
    expect([2, 6].map(roundsRuleRound)).toEqual(['later', 'later']);
  });

  it('names the severest finding, a needs_setup minor counting as none', () => {
    expect(roundsRuleSeverest([])).toBe('none');
    expect(roundsRuleSeverest([{ severity: 'nit' }, { severity: 'major' }])).toBe('major');
    expect(roundsRuleSeverest([{ severity: 'minor', kind: NEEDS_SETUP_FINDING_KIND }])).toBe(
      'none',
    );
    expect(
      roundsRuleSeverest([
        { severity: 'nit' },
        { severity: 'minor', kind: NEEDS_SETUP_FINDING_KIND },
      ]),
    ).toBe('nit');
  });
});
