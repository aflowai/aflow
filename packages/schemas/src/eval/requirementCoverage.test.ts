import { describe, it, expect } from 'vitest';

import { GoldenCaseContentSchema } from './goldenCase.js';
import { deriveCaseCoverage } from './requirementCoverage.js';

const REQUIREMENTS = [
  {
    id: 'asks-consent',
    statement: 'Asks before handing the order over.',
    kind: 'must_ask_before_acting' as const,
  },
  { id: 'one-handover', statement: 'Creates exactly one handover.', kind: 'must_do' as const },
];

describe('coverage makes a missing check visible', () => {
  it('reports a requirement nothing claims', () => {
    // The circularity this exists to break: a gate deriving mutants from the
    // checks under test goes quiet when a check is deleted. Stated separately,
    // the deletion leaves a requirement uncovered and the surface says so.
    const coverage = deriveCaseCoverage({
      requirements: REQUIREMENTS,
      expectations: [{ claims: ['one-handover'] }],
      rubrics: [],
    });
    expect(coverage.uncovered).toEqual(['asks-consent']);
  });

  it('names which check covers a requirement, not just that one does', () => {
    // A requirement held only by a judge criterion is covered differently from
    // one a world assertion holds, and that decides which lane its mutant runs
    // in — free deterministic, or a paid model call.
    const coverage = deriveCaseCoverage({
      requirements: REQUIREMENTS,
      expectations: [{ claims: ['one-handover'] }],
      rubrics: [{ claims: ['asks-consent'] }],
    });
    expect(coverage.requirements.map((r) => [r.requirement.id, r.claimedBy])).toEqual([
      ['asks-consent', ['rubric:0']],
      ['one-handover', ['expectation:0']],
    ]);
    expect(coverage.uncovered).toEqual([]);
  });

  it('counts several checks claiming one requirement', () => {
    const coverage = deriveCaseCoverage({
      requirements: [REQUIREMENTS[0]!],
      expectations: [{ claims: ['asks-consent'] }, { claims: ['asks-consent'] }],
      rubrics: [],
    });
    expect(coverage.requirements[0]?.claimedBy).toEqual(['expectation:0', 'expectation:1']);
  });

  it('treats a case with no requirements as covered, not as a gap', () => {
    const coverage = deriveCaseCoverage({ requirements: [], expectations: [{}], rubrics: [] });
    expect(coverage.uncovered).toEqual([]);
  });
});

describe('a claim has to name something', () => {
  const base = {
    title: 'A refund is overdue from the merchant',
    stratum: {
      scenario: 'refund-status',
      direction: 'should_pause' as const,
      tier: 'regression' as const,
    },
    trigger: { kind: 'chat' as const, message: 'where is my refund?', inputs: {} },
    fixture: { tier: 'sealed' as const },
    provenance: { source: 'curated' as const, workflowRevision: 1 },
  };

  it('refuses a claim on a requirement the case does not declare', () => {
    // A dangling claim is worse than no claim: it reads as coverage on every
    // surface while covering nothing.
    const parsed = GoldenCaseContentSchema.safeParse({
      ...base,
      requirements: REQUIREMENTS,
      expectations: [{ kind: 'terminal', runStatus: 'paused', claims: ['asks-permission'] }],
      rubrics: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes('asks-permission'))).toBe(true);
    }
  });

  it('accepts a claim that names a declared requirement', () => {
    const parsed = GoldenCaseContentSchema.safeParse({
      ...base,
      requirements: REQUIREMENTS,
      expectations: [{ kind: 'terminal', runStatus: 'paused', claims: ['one-handover'] }],
      rubrics: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses duplicate requirement ids', () => {
    const parsed = GoldenCaseContentSchema.safeParse({
      ...base,
      requirements: [REQUIREMENTS[0], REQUIREMENTS[0]],
      expectations: [],
      rubrics: [],
    });
    expect(parsed.success).toBe(false);
  });
});
