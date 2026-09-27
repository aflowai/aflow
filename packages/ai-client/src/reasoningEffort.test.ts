import { describe, it, expect } from 'vitest';
import { clampReasoningEffort, resolveReasoningForModel } from './reasoningEffort.js';
import type { ReasoningEffort } from './types.js';

// Shapes, not models: the catalog's real sets are measured and change with the
// providers, so naming a model here would freeze a claim this file cannot check.
const NO_OFF_RUNG: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
const SPARSE: readonly ReasoningEffort[] = ['low', 'high'];
const FULL: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

describe('clampReasoningEffort', () => {
  it('passes a supported rung through untouched', () => {
    for (const effort of FULL) {
      expect(clampReasoningEffort(effort, FULL)).toEqual({ effort });
    }
  });

  it('snaps "off" up to the lowest rung a model that always reasons offers', () => {
    // The Gemini Pro 400 this whole path exists to prevent: MINIMAL is refused,
    // so `off` has to become the model's floor rather than reach the wire.
    expect(clampReasoningEffort('off', NO_OFF_RUNG)).toEqual({
      effort: 'low',
      clampedFrom: 'off',
    });
  });

  it('resolves a rung the model skips over', () => {
    expect(clampReasoningEffort('medium', SPARSE)).toEqual({
      effort: 'low',
      clampedFrom: 'medium',
    });
  });

  it('breaks equidistant ties downward regardless of how the profile is ordered', () => {
    expect(clampReasoningEffort('medium', ['low', 'high'])).toEqual({
      effort: 'low',
      clampedFrom: 'medium',
    });
    expect(clampReasoningEffort('medium', ['high', 'low'])).toEqual({
      effort: 'low',
      clampedFrom: 'medium',
    });
  });

  it('snaps down to the ceiling when the model tops out below the request', () => {
    expect(clampReasoningEffort('high', ['off', 'low'])).toEqual({
      effort: 'low',
      clampedFrom: 'high',
    });
  });
});

describe('resolveReasoningForModel', () => {
  it('sends nothing to a model with no reasoning profile', () => {
    expect(resolveReasoningForModel({ effort: 'high' }, undefined)).toEqual({
      reasoning: undefined,
    });
  });

  it('applies the catalog default when the caller names no effort', () => {
    expect(resolveReasoningForModel(undefined, { supported: FULL, default: 'off' })).toEqual({
      reasoning: { effort: 'off' },
    });
  });

  it('leaves the provider default alone when the profile declares none', () => {
    expect(resolveReasoningForModel(undefined, { supported: NO_OFF_RUNG })).toEqual({
      reasoning: undefined,
    });
  });

  it('lets the caller override the catalog default', () => {
    expect(
      resolveReasoningForModel({ effort: 'high' }, { supported: FULL, default: 'off' }),
    ).toEqual({ reasoning: { effort: 'high' } });
  });

  it('reports the requested rung when it had to clamp', () => {
    expect(resolveReasoningForModel({ effort: 'off' }, { supported: NO_OFF_RUNG })).toEqual({
      reasoning: { effort: 'low' },
      clampedFrom: 'off',
    });
  });
});
