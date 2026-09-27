import type { CaseRequirement } from './goldenCase.js';

/**
 * Plan 301 §5.2 — which requirements a case's checks actually claim.
 *
 * The gate that proves a check can fail derives its mutants from requirements,
 * not from the checks under test. Deriving them from the checks would make the
 * gate blind in exactly the case it exists for: delete the consent expectation
 * and the consent mutant becomes irrelevant precisely when it should fire.
 *
 * So an uncovered requirement is the finding. It is not an error — a case may
 * legitimately be authored before its checks — but it is never silence.
 */

export interface RequirementCoverage {
  requirement: CaseRequirement;
  /**
   * Where the claim came from, as `expectation:{index}` / `rubric:{index}`.
   * A reader needs to know WHICH check claimed it: a requirement covered only
   * by a judge criterion is covered differently from one a world assertion
   * holds, and the difference decides which lane its mutant runs in.
   */
  claimedBy: string[];
  covered: boolean;
}

export interface CaseCoverage {
  requirements: RequirementCoverage[];
  /** Requirement ids nothing claims — the coverage gaps, in declaration order. */
  uncovered: string[];
}

export function deriveCaseCoverage(input: {
  requirements: readonly CaseRequirement[];
  expectations: ReadonlyArray<{ claims?: readonly string[] | undefined }>;
  rubrics: ReadonlyArray<{ claims?: readonly string[] | undefined }>;
}): CaseCoverage {
  const claimsById = new Map<string, string[]>();

  const record = (label: string, claims: readonly string[] | undefined): void => {
    for (const id of claims ?? []) {
      const existing = claimsById.get(id);
      if (existing === undefined) claimsById.set(id, [label]);
      else existing.push(label);
    }
  };

  input.expectations.forEach((expectation, index) => {
    record(`expectation:${String(index)}`, expectation.claims);
  });
  input.rubrics.forEach((rubric, index) => {
    record(`rubric:${String(index)}`, rubric.claims);
  });

  const requirements = input.requirements.map((requirement) => {
    const claimedBy = claimsById.get(requirement.id) ?? [];
    return { requirement, claimedBy, covered: claimedBy.length > 0 };
  });

  return {
    requirements,
    uncovered: requirements.filter((r) => !r.covered).map((r) => r.requirement.id),
  };
}
