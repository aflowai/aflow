/**
 * The vocabulary's ninth act (Plan 340 D1): a folder's provider is named from
 * the host its repo coordinate keeps.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPO_HOST,
  FORGE_ACTS,
  forgeProviderForHost,
  parseRepoCoordinate,
  requireForgeProvider,
} from '../../index.js';

describe('the forge provider named from a host', () => {
  it('names GitHub for a coordinate on github.com, in any case', () => {
    expect(forgeProviderForHost(parseRepoCoordinate('aflowai/aflow')!.host)).toBe('github');
    expect(forgeProviderForHost('GitHub.com')).toBe('github');
    expect(forgeProviderForHost()).toBe(forgeProviderForHost(DEFAULT_REPO_HOST));
  });

  it('names none for a host no provider answers for, and the strict form says so', () => {
    expect(forgeProviderForHost('gitlab.com')).toBeNull();
    expect(() => requireForgeProvider('gitlab.com')).toThrow(/gitlab\.com/);
  });

  it('holds the nine acts of D1', () => {
    expect(Object.keys(FORGE_ACTS)).toHaveLength(9);
  });
});
