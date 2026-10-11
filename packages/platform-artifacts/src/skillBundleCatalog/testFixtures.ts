import type { SkillBundleId } from '@aflow/schemas';

import type { AuthoredSkillBundle } from '../skillBundleCatalog.js';

export const TEST_TWO_SKILL_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'test-two-skill-bundle' as SkillBundleId,
  revision: -1,
  name: 'Test Two-Skill Bundle',
  tagline: 'Hidden test fixture for install-op unit tests.',
  description:
    'Hidden test fixture. References `_test-skill-a` and `_test-skill-b` to validate that bundle install loops over `skillCatalogIds` and produces both skills in the target space.',
  tags: ['test'],
  hidden: true,
  skillCatalogIds: ['_test-skill-a', '_test-skill-b'],
  prerequisiteBundleIds: [],
};

/**
 * Single-skill bundle with the setup-skill slot populated.
 * Exercises the `setupSkillCatalogId` schema-refinement path
 * (must appear in skillCatalogIds).
 */
export const TEST_SETUP_BUNDLE: AuthoredSkillBundle = {
  bundleId: 'test-setup-bundle' as SkillBundleId,
  revision: 0,
  name: 'Test Setup Bundle',
  tagline: 'Hidden test fixture validating the setup-skill slot.',
  description:
    'Hidden test fixture. References `_test-skill-a` as both the only skill and the setup skill.',
  tags: ['test'],
  hidden: true,
  skillCatalogIds: ['_test-skill-a'],
  setupSkillCatalogId: '_test-skill-a',
  prerequisiteBundleIds: [],
};
