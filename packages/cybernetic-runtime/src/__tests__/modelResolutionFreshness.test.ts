import { describe, it, expect } from 'vitest';
import { getCachedModelDefaults, getCachedReasoningDefaults } from '../modelResolution.js';

/**
 * The Runner's hot path reads model defaults out of the Helmsman's cached
 * SpaceContext. Checking only the TTL served an operator's superseded model
 * choice for up to an hour after they changed it — including to the very run
 * they changed it for.
 */
describe('cached model defaults — generation freshness', () => {
  const cacheAt = (gen: number | undefined, model: string) => ({
    spaceContextJson: JSON.stringify({
      space: {
        directives: { modelDefaults: { default: model }, reasoningDefaults: { runner: 'high' } },
      },
    }),
    spaceContextBuiltAt: Date.now(),
    ...(gen === undefined ? {} : { spaceContextGen: gen }),
  });

  it('reuses the cache when the cached gen matches the live gen', () => {
    expect(getCachedModelDefaults(cacheAt(7, 'glm-pro'), 7)).toEqual({ default: 'glm-pro' });
  });

  it('refuses a cache built before a directive change', () => {
    expect(getCachedModelDefaults(cacheAt(7, 'glm-pro'), 8)).toBeUndefined();
  });

  it('treats a gen-less cache as gen 0', () => {
    expect(getCachedModelDefaults(cacheAt(undefined, 'glm-pro'), 0)).toEqual({
      default: 'glm-pro',
    });
    expect(getCachedModelDefaults(cacheAt(undefined, 'glm-pro'), 1)).toBeUndefined();
  });

  it('falls back to TTL-only reuse when the caller passes no gen', () => {
    expect(getCachedModelDefaults(cacheAt(7, 'glm-pro'))).toEqual({ default: 'glm-pro' });
  });

  it('refuses a cache older than the TTL whatever the gen says', () => {
    const stale = { ...cacheAt(7, 'glm-pro'), spaceContextBuiltAt: Date.now() - 7_200_000 };
    expect(getCachedModelDefaults(stale, 7)).toBeUndefined();
  });

  it('applies the same freshness rules to reasoning defaults', () => {
    expect(getCachedReasoningDefaults(cacheAt(7, 'glm-pro'), 7)).toEqual({ runner: 'high' });
    expect(getCachedReasoningDefaults(cacheAt(7, 'glm-pro'), 8)).toBeUndefined();
  });
});
