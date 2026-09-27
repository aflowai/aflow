import { describe, it, expect } from 'vitest';
import { deriveCaseCoverage, GoldenCaseContentSchema } from '@aflow/schemas';

import { csDeskStarterCases } from './cases.js';

/**
 * Every requirement the starter set declares is claimed by a check.
 *
 * A requirement nothing claims is not a schema error — a case may legitimately
 * be authored before its checks — but in a curated set it means the policy was
 * written down and never tested, which is the gap this set exists to have none
 * of.
 */
describe('the cs-desk set covers what it requires', () => {
  const cases = csDeskStarterCases(1);

  it('parses, so every claim names a requirement the case declares', () => {
    for (const testCase of cases) {
      const parsed = GoldenCaseContentSchema.safeParse(testCase);
      expect(parsed.success, `${testCase.title}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it('leaves no requirement unclaimed', () => {
    const gaps = cases
      .map((c) => ({
        title: c.title,
        uncovered: deriveCaseCoverage({
          requirements: c.requirements,
          expectations: c.expectations,
          rubrics: c.rubrics,
        }).uncovered,
      }))
      .filter((c) => c.uncovered.length > 0);
    expect(gaps).toEqual([]);
  });

  it('declares a requirement for every case', () => {
    // A case with none cannot have a coverage gap, which would read as
    // perfectly covered rather than as unstated.
    for (const testCase of cases) {
      expect(testCase.requirements.length, testCase.title).toBeGreaterThan(0);
    }
  });
});
