import { describe, it, expect } from 'vitest';
import { GoldenCaseContentSchema } from '@aflow/schemas';
import { runDeterministicGate, findPolarityMismatches } from '@aflow/cybernetic-runtime';

import { csDeskStarterCases } from './cases.js';

/**
 * Every deterministic check in the starter set rejects the defect it claims to
 * catch, and accepts a reference that does not contain it.
 *
 * Run against the real set rather than a fixture: a gate that only ever sees
 * synthetic cases proves it works on synthetic cases.
 */
describe('the cs-desk checks can fail', () => {
  const cases = csDeskStarterCases(1).map((c) => GoldenCaseContentSchema.parse(c));

  for (const testCase of cases) {
    it(`${testCase.title}`, () => {
      const report = runDeterministicGate({ expectations: testCase.expectations });
      expect(
        report.referenceFailures,
        'the reference must pass, or a rejection proves nothing',
      ).toEqual([]);
      expect(report.unwitnessed, 'defects no check would notice').toEqual([]);
      expect(report.unsupported, 'check kinds the gate cannot synthesise').toEqual([]);
    });
  }

  it('asserts the direction each requirement states', () => {
    // The mutation gate proves a check CAN fail; it cannot tell that a check
    // fails for the opposite reason to the one intended. Relaxing 'opened no
    // case' to 'opened a case' leaves a check that rejects its own defect
    // perfectly and demands the thing the policy forbids.
    for (const testCase of cases) {
      expect(
        findPolarityMismatches({
          requirements: testCase.requirements,
          expectations: testCase.expectations,
        }),
        testCase.title,
      ).toEqual([]);
    }
  });

  it('witnesses at least one defect per case', () => {
    // A case whose checks generate no mutants has nothing proven about it, and
    // an empty witness list would otherwise read as a pass.
    for (const testCase of cases) {
      const report = runDeterministicGate({ expectations: testCase.expectations });
      expect(report.witnesses.length, testCase.title).toBeGreaterThan(0);
    }
  });
});
