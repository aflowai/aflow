/**
 * The skills' forge and the vocabulary name the same acts (Plan 340 D1).
 *
 * `SkillForge` requires a call for every act of `FORGE_ACTS` but naming the
 * provider, so an act with no call fails to compile. The case this test
 * holds is the other way: a call a provider makes that `FORGE_ACTS` does not
 * list. A call is a member that is a function, or a group of functions such
 * as the two ways to list change requests.
 */
import { describe, expect, it } from 'vitest';
import { FORGE_ACTS, FORGE_PROVIDERS } from '@aflow/schemas';
import { GITHUB_SKILL_FORGE } from './github/skillForge.js';
import type { SkillForge } from './vocabulary.js';

const PROVIDERS: Readonly<Record<(typeof FORGE_PROVIDERS)[number], SkillForge>> = {
  github: GITHUB_SKILL_FORGE,
};

function callsOf(forge: SkillForge): string[] {
  return Object.entries(forge)
    .filter(
      ([, member]) =>
        typeof member === 'function' ||
        (typeof member === 'object' &&
          member !== null &&
          Object.values(member).length > 0 &&
          Object.values(member).every((part) => typeof part === 'function')),
    )
    .map(([name]) => name)
    .sort();
}

describe('the acts of the skills’ forge', () => {
  it.each(FORGE_PROVIDERS)('are the vocabulary’s acts but naming the provider, for %s', (id) => {
    const acts = Object.keys(FORGE_ACTS)
      .filter((act) => act !== 'nameProvider')
      .sort();
    expect(callsOf(PROVIDERS[id])).toEqual(acts);
  });

  it('counts a call the vocabulary does not list', () => {
    const extra = { ...GITHUB_SKILL_FORGE, deleteBranch: () => ({}) } as SkillForge;
    expect(callsOf(extra)).toContain('deleteBranch');
  });
});
