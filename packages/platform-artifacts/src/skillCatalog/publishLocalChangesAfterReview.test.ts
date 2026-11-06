/**
 * The rounds rule's table as the publication's decide steps carry it: every
 * case the table covers is decided by the compiled rules exactly as the table
 * decides it, and every case it leaves open is `uncovered` there.
 */
import { describe, expect, it } from 'vitest';
import { decideByRules } from '@aflow/cybernetic-runtime';
import {
  ROUNDS_RULE,
  ROUNDS_RULE_SEVERESTS,
  ROUNDS_RULE_VERDICTS,
  WORKFLOW_RUN_DECIDE_RULES_MAX,
  roundsRuleCases,
  roundsRuleRound,
  roundsRuleRow,
} from '@aflow/schemas';
import {
  AFTER_REVIEW_SETTLE_OTHERWISE,
  AFTER_REVIEW_SETTLE_RULES,
  GRADE_FINDINGS_RULES,
  ROUNDS_RULE_DECIDE_RULES,
  RULE_AFTER_REVIEW_OTHERWISE,
  UNCOVERED,
} from './publishLocalChangesAfterReview.js';

const ROUNDS = [null, 1, 2, 7] as const;
const VERDICTS = [...ROUNDS_RULE_VERDICTS, null] as const;

describe('the rounds rule as decide rules', () => {
  it('compiles every row, and each rule set fits the decide step', () => {
    const reasons = new Set(ROUNDS_RULE_DECIDE_RULES.map((rule) => rule.reason));
    expect([...reasons].sort()).toEqual([...new Set(ROUNDS_RULE.map((row) => row.reason))].sort());
    expect(ROUNDS_RULE.flatMap(roundsRuleCases).length).toBeGreaterThan(0);
    for (const rules of [
      GRADE_FINDINGS_RULES,
      ROUNDS_RULE_DECIDE_RULES,
      AFTER_REVIEW_SETTLE_RULES,
    ]) {
      expect(rules.length).toBeLessThanOrEqual(WORKFLOW_RUN_DECIDE_RULES_MAX);
    }
  });

  for (const round of ROUNDS) {
    for (const severest of ROUNDS_RULE_SEVERESTS) {
      for (const verdict of VERDICTS) {
        const label = `round ${String(round)}, severest ${severest}, verdict ${String(verdict)}`;
        it(`${label}: decides as the table does, with no model answer read`, () => {
          const row = roundsRuleRow({ round: roundsRuleRound(round), severest, verdict });
          // A missing round is bound as 1 by the step's template.
          const state = { round: round ?? 1, severest, verdict };
          const ruled = decideByRules({
            state,
            rules: [...ROUNDS_RULE_DECIDE_RULES],
            otherwise: RULE_AFTER_REVIEW_OTHERWISE,
          });
          expect([ruled.decision, ruled.reason]).toEqual(
            row === null
              ? [UNCOVERED, RULE_AFTER_REVIEW_OTHERWISE.reason]
              : [row.decision, row.reason],
          );
          // A covered case is recorded by its row, whatever a model would have said.
          if (row !== null) {
            const settled = decideByRules({
              state: {
                ...state,
                answer: row.decision === 'fix_before_merge' ? 'publish_as_is' : 'fix_before_merge',
              },
              rules: [...AFTER_REVIEW_SETTLE_RULES],
              otherwise: AFTER_REVIEW_SETTLE_OTHERWISE,
            });
            expect(settled.decision).toBe(row.decision);
          }
        });
      }
    }
  }
});
