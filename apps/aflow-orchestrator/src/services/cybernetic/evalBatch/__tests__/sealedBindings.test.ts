/**
 * What a sealed case is allowed to decide about the world it faces.
 *
 * The pins are the entire difference between a trial that measures the agent
 * and one that measures the environment, and every refusal here has a fallback
 * that would look like it worked.
 */
import { describe, expect, it } from 'vitest';
import { chooseBaselineVersion, SealedProvisioningError } from '../sealedBindings.js';

describe('chooseBaselineVersion', () => {
  it('takes the head when the case pins nothing', () => {
    expect(chooseBaselineVersion([1, 2, 3], 'sim')).toBe(3);
  });

  it('does not assume the versions arrive ordered', () => {
    expect(chooseBaselineVersion([3, 1, 2], 'sim')).toBe(3);
  });

  it('takes the pinned version when the case names one it holds', () => {
    expect(chooseBaselineVersion([1, 2, 3], 'sim', 2)).toBe(2);
  });

  it('refuses a pinned version the simulation never minted', () => {
    // The tempting fallbacks both grade as though they ran the written case:
    // the head answers an older-world case with a newer world, and an empty
    // copy leaves `unmatched: generate` inventing the rows.
    expect(() => chooseBaselineVersion([1, 2], 'sim', 7)).toThrow(SealedProvisioningError);
    expect(() => chooseBaselineVersion([1, 2], 'sim', 7)).toThrow(/holds only \[1, 2\]/);
  });

  it('refuses a simulation with no baseline at all', () => {
    expect(() => chooseBaselineVersion([], 'sim')).toThrow(/no baseline version/);
  });
});
