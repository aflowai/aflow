/**
 * Thrown when the Coach proposes `eval.criterion.add` but the skill's
 * criterion count is at `maxEvalCriteriaPerSkill` and no `replacedCriterionId`
 * is provided. The operator sees a note: "retire a criterion or raise the cap."
 */
export class CoachProposalExceedsEvalCapError extends Error {
  readonly skillSlug: string;
  readonly currentCount: number;
  readonly cap: number;

  constructor(skillSlug: string, currentCount: number, cap: number) {
    super(
      `Eval criterion cap reached for skill "${skillSlug}": ` +
        `${String(currentCount)}/${String(cap)} criteria. ` +
        `Proposal must include replacedCriterionId or operator must raise the cap.`,
    );
    this.name = 'CoachProposalExceedsEvalCapError';
    this.skillSlug = skillSlug;
    this.currentCount = currentCount;
    this.cap = cap;
  }
}
