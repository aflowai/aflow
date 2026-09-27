import { describe, expect, it } from 'vitest';
import { resolveMaxOutputTokens } from './outputBudget.js';

describe('resolveMaxOutputTokens', () => {
  it('defaults an unnamed budget to what the model emits', () => {
    expect(resolveMaxOutputTokens(undefined, 16384)).toBe(16384);
  });

  it('clamps a request the model cannot honour instead of forwarding a 400', () => {
    expect(resolveMaxOutputTokens(999_000, 16384)).toBe(16384);
  });

  it('leaves a budget within the ceiling alone', () => {
    expect(resolveMaxOutputTokens(500, 16384)).toBe(500);
  });

  it('trusts the caller for a model the catalog does not know', () => {
    expect(resolveMaxOutputTokens(500, undefined)).toBe(500);
    expect(resolveMaxOutputTokens(undefined, undefined)).toBeUndefined();
  });
});
