import { describe, it, expect } from 'vitest';
import { GoldenCaseContentSchema } from '@aflow/schemas';
import { validateGoldenCase } from '@aflow/cybernetic-runtime';

import { csDeskStarterCases } from './cases.js';

/**
 * The starter set passes the gate that now guards the operator write path.
 *
 * Wiring the gate to authoring means an existing case that cannot fail becomes
 * unwritable — so the set it ships with has to clear the bar it imposes.
 */
describe('the cs-desk set clears its own authoring gate', () => {
  for (const testCase of csDeskStarterCases(1)) {
    it(`${testCase.title}`, () => {
      const diagnostics = validateGoldenCase(GoldenCaseContentSchema.parse(testCase), {
        tasks: [],
      });
      expect(
        diagnostics.filter((d) => d.severity === 'error'),
        JSON.stringify(diagnostics.filter((d) => d.severity === 'error')),
      ).toEqual([]);
    });
  }
});
