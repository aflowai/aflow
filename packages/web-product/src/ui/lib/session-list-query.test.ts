/**
 * Two components request a space's recent sessions and resolve to the same
 * query key when the Helmsman is selected. TanStack deduplicates by key and not
 * by URL, so when those requests differed only in `limit`, whichever mounted
 * first decided what both observers saw — a result that followed render order
 * rather than either caller's request.
 */
import { describe, it, expect } from 'vitest';
import { SESSION_LIST_LIMIT, sessionListKey } from './session-list-query.js';

describe('sessionListKey', () => {
  it('gives the two callers the same key for the same data', () => {
    expect(sessionListKey('space-1', 'platform-role', 'cybernetic-helmsman')).toEqual(
      sessionListKey('space-1', 'platform-role', 'cybernetic-helmsman'),
    );
  });

  it('carries the limit, so a changed size cannot reuse the old cache', () => {
    // The property that made mount order matter: a key that omits a
    // result-shaping parameter names data it does not uniquely identify.
    expect(sessionListKey('space-1', 'platform-role', 'x')).toContain(SESSION_LIST_LIMIT);
  });

  it('separates spaces', () => {
    expect(sessionListKey('space-1', 'platform-role', 'x')).not.toEqual(
      sessionListKey('space-2', 'platform-role', 'x'),
    );
  });

  it('separates agent targets', () => {
    expect(sessionListKey('s', 'platform-role', 'cybernetic-helmsman')).not.toEqual(
      sessionListKey('s', 'custom-agent', 'cybernetic-helmsman'),
    );
    expect(sessionListKey('s', 'custom-agent', 'agent-a')).not.toEqual(
      sessionListKey('s', 'custom-agent', 'agent-b'),
    );
  });

  it('keeps the space prefix that space-switch invalidation matches on', () => {
    const k = sessionListKey('space-1', 'platform-role', 'x');
    expect(k.slice(0, 2)).toEqual(['space', 'space-1']);
  });
});
