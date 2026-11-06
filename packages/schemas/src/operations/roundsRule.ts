/**
 * The rounds rule a publication decides its review's findings by (Plan 315
 * D22), as a table rather than prose: each row names the rounds, the severest
 * finding and the verdicts it covers, and the decision it makes there. The
 * rows never overlap, so no row's place in the table changes what it decides.
 * A case no row covers is the decision model's.
 */
import { z } from 'zod';
import { AfterReviewSchema, isNeedsSetupFinding } from './hostCommitDescribe.js';

/** The slice's first publication, or one after a fix round of it has run. */
export const ROUNDS_RULE_ROUNDS = ['first', 'later'] as const;
export type RoundsRuleRound = (typeof ROUNDS_RULE_ROUNDS)[number];

/** The severest of a review's findings, most severe first, and `none` where it returned none. */
export const ROUNDS_RULE_SEVERESTS = ['blocker', 'major', 'minor', 'nit', 'none'] as const;
export type RoundsRuleSeverest = (typeof ROUNDS_RULE_SEVERESTS)[number];

/** The verdicts a Local Code Review returns. */
export const ROUNDS_RULE_VERDICTS = ['approve', 'comment', 'request_changes'] as const;
export type RoundsRuleVerdict = (typeof ROUNDS_RULE_VERDICTS)[number];

export const ROUNDS_RULE_MAJOR_REASON =
  'The review found a blocker or a major. Under the rounds rule a major is fixed before the branch merges, whatever the round.';
export const ROUNDS_RULE_FIRST_MINOR_REASON =
  "The review found a minor on the slice's first publication. Under the rounds rule the first publication gets one fix round.";
export const ROUNDS_RULE_LATER_REASON =
  'A fix round of this slice has run, and the review found only minors or nits. Under the rounds rule the branch merges as it stands, and the pull request lists the findings open.';
export const ROUNDS_RULE_NITS_ONLY_REASON = 'nits-only review: the rounds rule ends the rounds';

export const RoundsRuleRowSchema = z
  .object({
    rounds: z.array(z.enum(ROUNDS_RULE_ROUNDS)).min(1),
    severest: z.array(z.enum(ROUNDS_RULE_SEVERESTS)).min(1),
    verdicts: z.array(z.enum(ROUNDS_RULE_VERDICTS)).min(1),
    decision: AfterReviewSchema,
    reason: z.string().min(1).max(4000),
  })
  .strict();
export type RoundsRuleRow = z.infer<typeof RoundsRuleRowSchema>;

/** Every case one row covers, as `round/severest/verdict`. */
export function roundsRuleCases(row: RoundsRuleRow): string[] {
  return row.rounds.flatMap((round) =>
    row.severest.flatMap((severest) =>
      row.verdicts.map((verdict) => `${round}/${severest}/${verdict}`),
    ),
  );
}

export const RoundsRuleTableSchema = z
  .array(RoundsRuleRowSchema)
  .min(1)
  .superRefine((rows, ctx) => {
    const seen = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
      for (const covered of roundsRuleCases(row)) {
        const earlier = seen.get(covered);
        if (earlier !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: `Rows ${String(earlier)} and ${String(index)} both cover ${covered}. A case is decided by one row.`,
          });
        }
        seen.set(covered, index);
      }
    }
  });
export type RoundsRuleTable = z.infer<typeof RoundsRuleTableSchema>;

/**
 * The operator's rounds rule. A major or a blocker is fixed at any round. The
 * first publication fixes a minor under `approve` or `comment`. A later round
 * publishes minors and nits as they stand. An approving review of nits alone,
 * or of none, publishes as it did before the table.
 */
export const ROUNDS_RULE: RoundsRuleTable = RoundsRuleTableSchema.parse([
  {
    rounds: ['first', 'later'],
    severest: ['blocker', 'major'],
    verdicts: [...ROUNDS_RULE_VERDICTS],
    decision: 'fix_before_merge',
    reason: ROUNDS_RULE_MAJOR_REASON,
  },
  {
    rounds: ['first'],
    severest: ['minor'],
    verdicts: ['approve', 'comment'],
    decision: 'fix_before_merge',
    reason: ROUNDS_RULE_FIRST_MINOR_REASON,
  },
  {
    rounds: ['later'],
    severest: ['minor', 'nit'],
    verdicts: [...ROUNDS_RULE_VERDICTS],
    decision: 'publish_as_is',
    reason: ROUNDS_RULE_LATER_REASON,
  },
  {
    rounds: ['first'],
    severest: ['nit', 'none'],
    verdicts: ['approve'],
    decision: 'publish_as_is',
    reason: ROUNDS_RULE_NITS_ONLY_REASON,
  },
  {
    rounds: ['later'],
    severest: ['none'],
    verdicts: ['approve'],
    decision: 'publish_as_is',
    reason: ROUNDS_RULE_NITS_ONLY_REASON,
  },
]);

/** A publication's declared `round` as the table reads it: absent or 1 is the first. */
export function roundsRuleRound(round: number | null | undefined): RoundsRuleRound {
  return round != null && round > 1 ? 'later' : 'first';
}

/**
 * The severest of a review's findings as the table reads it. A `needs_setup`
 * finding is setup on the machine, not a defect of the change, so it counts
 * as none.
 */
export function roundsRuleSeverest(
  findings: ReadonlyArray<{ readonly severity: string; readonly kind?: string | undefined }>,
): RoundsRuleSeverest {
  let severest: RoundsRuleSeverest = 'none';
  for (const finding of findings) {
    if (isNeedsSetupFinding(finding)) continue;
    const rank = ROUNDS_RULE_SEVERESTS.indexOf(finding.severity as RoundsRuleSeverest);
    if (rank !== -1 && rank < ROUNDS_RULE_SEVERESTS.indexOf(severest)) {
      severest = ROUNDS_RULE_SEVERESTS[rank]!;
    }
  }
  return severest;
}

/** The row covering one case, or null where none does and the decision model is asked. */
export function roundsRuleRow(
  facts: {
    round: RoundsRuleRound;
    severest: RoundsRuleSeverest;
    verdict: string | null;
  },
  table: RoundsRuleTable = ROUNDS_RULE,
): RoundsRuleRow | null {
  return (
    table.find(
      (row) =>
        row.rounds.includes(facts.round) &&
        row.severest.includes(facts.severest) &&
        row.verdicts.some((verdict) => verdict === facts.verdict),
    ) ?? null
  );
}
