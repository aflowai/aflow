/**
 * A bundle's published version is derived from its revision and the versions
 * of the skills it carries, so a skill that moves moves every bundle carrying
 * it, with nothing else edited.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const raised = vi.hoisted(() => ({ catalogId: undefined as string | undefined }));

vi.mock('../skillCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skillCatalog.js')>();
  return {
    ...actual,
    getSkillCatalogEntry: (catalogId: string) => {
      const skill = actual.getSkillCatalogEntry(catalogId);
      return skill !== null && catalogId === raised.catalogId
        ? { ...skill, version: skill.version + 1 }
        : skill;
    },
  };
});

async function publishedVersions(): Promise<Map<string, number>> {
  vi.resetModules();
  const { SKILL_BUNDLE_CATALOG } = await import('../skillBundleCatalog.js');
  return new Map(SKILL_BUNDLE_CATALOG.map((bundle) => [bundle.bundleId, bundle.version]));
}

beforeEach(() => {
  raised.catalogId = undefined;
});

describe('a bundle’s published version', () => {
  it('moves with a skill it carries, and only in the bundles carrying it', async () => {
    const before = await publishedVersions();
    raised.catalogId = 'publish-local-changes';
    const after = await publishedVersions();

    expect(after.get('local-publish')).toBe((before.get('local-publish') ?? 0) + 1);
    for (const [bundleId, version] of after) {
      if (bundleId !== 'local-publish') expect(version, bundleId).toBe(before.get(bundleId));
    }
  });

  it('moves by one for each skill raised in a bundle carrying several', async () => {
    const before = await publishedVersions();
    raised.catalogId = 'review-pull-request';
    const after = await publishedVersions();

    expect(after.get('coding-pr-loop')).toBe((before.get('coding-pr-loop') ?? 0) + 1);
  });

  it('is the revision plus the version of every skill carried, and has none for a skill the catalog lacks', async () => {
    vi.resetModules();
    const { publishedBundleVersion } = await import('../skillBundleCatalog.js');
    const { getSkillCatalogEntry } = await import('../skillCatalog.js');
    const skills = ['open-pr-from-request', 'review-pull-request'];
    const sum = skills.reduce(
      (total, catalogId) => total + (getSkillCatalogEntry(catalogId)?.version ?? Number.NaN),
      0,
    );

    expect(publishedBundleVersion({ bundleId: 'b', revision: -1, skillCatalogIds: skills })).toBe(
      sum - 1,
    );
    expect(() =>
      publishedBundleVersion({ bundleId: 'b', revision: 0, skillCatalogIds: ['no-such-skill'] }),
    ).toThrow('"no-such-skill", which is no skill in the catalog');
  });
});
