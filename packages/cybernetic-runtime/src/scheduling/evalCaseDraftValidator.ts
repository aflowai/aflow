import { z } from 'zod';
import {
  GoldenCaseContentSchema,
  registerAdvisoryValidator,
  registerValidator,
  type AdvisoryFinding,
} from '@aflow/schemas';

import { deriveCaseCoverage } from '@aflow/schemas';

import { findPolarityMismatches } from '../mutationGate.js';
import { validateGoldenCase } from '../goldenCaseValidity.js';

/**
 * Stable validatorRef for the eval-suite-design `design` output.
 *
 * Whether a check agrees in polarity with the requirement it claims is a
 * cross-field rule no JSON-Schema projection can express, and getting it wrong
 * produces a check that fails precisely when the skill behaves. Wiring it as
 * the authoritative submit_output validatorRef makes the drafting turn see it
 * in-session — where the model can repair the case it just wrote — instead of
 * failing the propose hop after the turn has ended.
 */
export const EVAL_CASE_DRAFT_VALIDATOR_REF = 'eval.case-draft' as const;

const EvalCaseDraftOutputSchema = z
  .object({
    cases: z.array(GoldenCaseContentSchema).min(1).max(20),
    rationale: z.string().min(1).max(8000),
  })
  .superRefine((data, ctx) => {
    data.cases.forEach((content, i) => {
      for (const mismatch of findPolarityMismatches(content)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cases', i, 'expectations', mismatch.checkIndex, 'check'],
          message: `${mismatch.detail} Cover a must_not_do requirement with a check asserting ABSENCE, and a must_do requirement with one asserting presence.`,
        });
      }

      // Coverage is advisory where a case is WRITTEN, because a requirement may
      // legitimately be recorded before the check that catches it. Submitting is
      // the opposite moment: the case is finished and going to an operator to
      // ratify, and a requirement nothing checks is a claim the suite cannot
      // keep — the run that violates it passes, and the suite reads as covering
      // ground it does not. The author is still in the turn and holding the
      // draft, so this is the cheapest place it will ever be fixable.
      for (const id of deriveCaseCoverage({
        requirements: content.requirements,
        expectations: content.expectations,
        rubrics: content.rubrics,
      }).uncovered) {
        const requirement = content.requirements.find((r) => r.id === id);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cases', i, 'requirements'],
          message:
            `Nothing checks '${requirement?.statement ?? id}', so a run violating it would still pass. ` +
            `Add claims: ['${id}'] to the expectation or rubric that would catch it, or drop the requirement.`,
        });
      }
    });
  });

registerValidator(EVAL_CASE_DRAFT_VALIDATOR_REF, EvalCaseDraftOutputSchema);

/**
 * What a suite would pass with and still be weak at.
 *
 * What is left once the gate above refuses everything mechanically decidable:
 * a check kind the authoring gate cannot exercise, a sealed fixture that does
 * not pin its clock, a direction that disagrees with its terminal expectation.
 * Each needs a judgement the drafting agent cannot supply — only the case's
 * author knows whether a world has relative dates, or whether pausing is the
 * reference behaviour — so they reach the operator at ratification instead of
 * failing a turn that cannot resolve them.
 */
registerAdvisoryValidator(EVAL_CASE_DRAFT_VALIDATOR_REF, (data): AdvisoryFinding[] => {
  const cases = (data as { cases?: unknown[] } | null)?.cases;
  if (!Array.isArray(cases)) return [];

  const findings: AdvisoryFinding[] = [];
  cases.forEach((raw, index) => {
    const parsed = GoldenCaseContentSchema.safeParse(raw);
    // An unparseable case is the blocking validator's business; reporting it
    // twice in two registers would teach an author that advisories are errors.
    if (!parsed.success) return;
    for (const diagnostic of validateGoldenCase(parsed.data, { tasks: [] })) {
      if (diagnostic.severity !== 'advisory') continue;
      // Now refused by the blocking validator above. Reporting it in both
      // registers would teach an author that advisories are errors.
      if (diagnostic.code === 'case_requirement_uncovered') continue;
      findings.push({
        code: diagnostic.code,
        detail: `${parsed.data.title}: ${diagnostic.detail}`,
        path: ['cases', index],
      });
    }
  });
  return findings;
});
