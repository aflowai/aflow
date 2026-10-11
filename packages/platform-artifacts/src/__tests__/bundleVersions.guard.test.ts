/**
 * Contract: a bundle's version moves whenever a skill it carries moves.
 *
 * The Store offers an update when a bundle's version passes the one a space
 * installed, and reads no skill's version for that. A skill raised alone is
 * therefore never offered: the space runs its clone of the old one with
 * nothing saying a newer one exists.
 *
 * The record below is each bundle as last released: its version and the
 * version of every skill it carried then. A skill whose version differs from
 * its record fails here until the bundle's version is raised past its own
 * record, and then until both are recorded — so the record moves in the same
 * change as the versions, and a skill cannot move under a bundle that stays.
 */
import { describe, expect, it } from 'vitest';

import { SKILL_BUNDLE_CATALOG } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';

interface Released {
  readonly version: number;
  readonly skills: Readonly<Record<string, number>>;
}

const RELEASED: Readonly<Record<string, Released>> = {
  'test-two-skill-bundle': { version: 1, skills: { '_test-skill-a': 1, '_test-skill-b': 1 } },
  'test-setup-bundle': { version: 1, skills: { '_test-skill-a': 1 } },
  'alpaca-thesis-trading': { version: 3, skills: { 'daily-trading-cycle': 1 } },
  'kaggle-competition': { version: 6, skills: { 'kaggle-competition-optimizer': 4 } },
  'coding-pr-loop': {
    version: 3,
    skills: { 'open-pr-from-request': 1, 'review-pull-request': 2, 'pr-shepherd': 2 },
  },
  'local-commission': { version: 3, skills: { 'commission-change': 3 } },
  'local-code-review': { version: 7, skills: { 'review-local-changes': 7 } },
  'local-publish': { version: 20, skills: { 'publish-local-changes': 23 } },
  'ticker-digest': { version: 4, skills: { 'ticker-market-digest': 2 } },
  'web-research': { version: 2, skills: { 'web-research-brief': 1 } },
  'literature-scan': { version: 6, skills: { 'literature-review': 4 } },
  'film-production': {
    version: 6,
    skills: { 'film-concept': 1, 'film-world-development': 4, 'film-shot-batch': 5 },
  },
  'eval-authoring': { version: 16, skills: { 'eval-suite-design': 16 } },
};

function skillVersions(skillCatalogIds: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    skillCatalogIds.map((id) => {
      const skill = getSkillCatalogEntry(id);
      if (skill === null) throw new Error(`bundle names "${id}", which is no skill`);
      return [id, skill.version];
    }),
  );
}

/**
 * Why a bundle at `version` carrying `skills` may not stand against its
 * record, or nothing: a skill moved and the bundle did not pass its record.
 */
function stayedUnderMovedSkills(
  bundleId: string,
  version: number,
  skills: Readonly<Record<string, number>>,
  released: Released,
): string | undefined {
  const moved = Object.entries(skills)
    .filter(([id, skillVersion]) => released.skills[id] !== skillVersion)
    .map(
      ([id, skillVersion]) =>
        `${id} ${String(released.skills[id] ?? 'new')} → ${String(skillVersion)}`,
    );
  if (moved.length === 0 || version > released.version) return undefined;
  return (
    `${bundleId} carries skills that moved (${moved.join(', ')}) and stayed at version ` +
    `${String(version)}, so the Store offers no update and every space keeps the skills it ` +
    'has: raise its version past that, then record both here.'
  );
}

const BUNDLES = SKILL_BUNDLE_CATALOG.map((bundle) => [bundle.bundleId, bundle] as const);

describe('a bundle’s version moves with the skills it carries', () => {
  it('records every bundle in the catalog, and no other', () => {
    expect(Object.keys(RELEASED).sort()).toEqual(BUNDLES.map(([bundleId]) => bundleId).sort());
  });

  it.each(BUNDLES)(
    '%s is raised past its record wherever a skill it carries moved',
    (bundleId, bundle) => {
      const released = RELEASED[bundleId];
      if (released === undefined) throw new Error(`${bundleId} has no record`);
      expect(
        stayedUnderMovedSkills(
          bundleId,
          bundle.version,
          skillVersions(bundle.skillCatalogIds),
          released,
        ),
      ).toBeUndefined();
    },
  );

  it.each(BUNDLES)('%s is recorded as it stands', (bundleId, bundle) => {
    expect(RELEASED[bundleId]).toEqual({
      version: bundle.version,
      skills: skillVersions(bundle.skillCatalogIds),
    });
  });

  it('refuses a skill raised under a bundle that stayed, as Local Publish once was, until the bundle is raised', () => {
    const released: Released = { version: 19, skills: { 'publish-local-changes': 21 } };
    const raised = { 'publish-local-changes': 22 };
    expect(stayedUnderMovedSkills('local-publish', 19, raised, released)).toContain(
      'raise its version past that',
    );
    expect(stayedUnderMovedSkills('local-publish', 20, raised, released)).toBeUndefined();
    expect(stayedUnderMovedSkills('local-publish', 19, released.skills, released)).toBeUndefined();
  });
});
