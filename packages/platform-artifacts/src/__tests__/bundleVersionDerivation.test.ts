/**
 * A bundle's published version is derived from its revision and the versions
 * of the skills it carries, so a skill that moves moves every bundle carrying
 * it, with nothing else edited — down as well as up, which the snapshot guard
 * refuses until the bundle's revision is raised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bundlesBelowSnapshot, committedStoreCatalogHashes } from './bundleVersionFloor.js';

const moved = vi.hoisted(() => ({ catalogId: undefined as string | undefined, by: 0 }));

vi.mock('../skillCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skillCatalog.js')>();
  return {
    ...actual,
    getSkillCatalogEntry: (catalogId: string) => {
      const skill = actual.getSkillCatalogEntry(catalogId);
      return skill !== null && catalogId === moved.catalogId
        ? { ...skill, version: skill.version + moved.by }
        : skill;
    },
  };
});

function raise(catalogId: string): void {
  moved.catalogId = catalogId;
  moved.by = 1;
}

async function publishedVersions(): Promise<Map<string, number>> {
  vi.resetModules();
  const { SKILL_BUNDLE_CATALOG } = await import('../skillBundleCatalog.js');
  return new Map(SKILL_BUNDLE_CATALOG.map((bundle) => [bundle.bundleId, bundle.version]));
}

beforeEach(() => {
  moved.catalogId = undefined;
  moved.by = 0;
});

describe('a bundle’s published version', () => {
  it('moves with a skill it carries, and only in the bundles carrying it', async () => {
    const before = await publishedVersions();
    raise('publish-local-changes');
    const after = await publishedVersions();

    expect(after.get('local-publish')).toBe((before.get('local-publish') ?? 0) + 1);
    expect(after.get('coding-loop')).toBe((before.get('coding-loop') ?? 0) + 1);
    for (const [bundleId, version] of after) {
      if (bundleId !== 'local-publish' && bundleId !== 'coding-loop') {
        expect(version, bundleId).toBe(before.get(bundleId));
      }
    }
  });

  it('moves by one for each skill raised in a bundle carrying several', async () => {
    const before = await publishedVersions();
    raise('review-pull-request');
    const after = await publishedVersions();

    expect(after.get('coding-pr-loop')).toBe((before.get('coding-pr-loop') ?? 0) + 1);
  });

  it('falls with a skill it carries lowered, below the version on record, which the guard names', async () => {
    const committed = committedStoreCatalogHashes();
    expect(bundlesBelowSnapshot(await publishedVersions(), committed)).toEqual([]);
    moved.catalogId = 'publish-local-changes';
    moved.by = -1;
    const after = await publishedVersions();

    const recorded = committed['local-publish']?.version ?? Number.NaN;
    const codingLoopRecorded = committed['coding-loop']?.version ?? Number.NaN;
    expect(bundlesBelowSnapshot(after, committed)).toEqual([
      { bundleId: 'local-publish', version: recorded - 1, recorded },
      { bundleId: 'coding-loop', version: codingLoopRecorded - 1, recorded: codingLoopRecorded },
    ]);
  });

  it('falls when it stops carrying a skill, and clears the guard only once its revision passes the fall', async () => {
    vi.resetModules();
    const { SKILL_BUNDLE_CATALOG, publishedBundleVersion } =
      await import('../skillBundleCatalog.js');
    const { getSkillCatalogEntry } = await import('../skillCatalog.js');
    const committed = committedStoreCatalogHashes();
    const bundle = SKILL_BUNDLE_CATALOG.find(({ bundleId }) => bundleId === 'coding-pr-loop');
    const [dropped, ...kept] = bundle?.skillCatalogIds ?? [];
    if (bundle === undefined || dropped === undefined) throw new Error('no bundle carrying skills');
    const revision =
      bundle.version -
      publishedBundleVersion({ ...bundle, revision: 0, skillCatalogIds: bundle.skillCatalogIds });
    const droppedVersion = getSkillCatalogEntry(dropped)?.version ?? Number.NaN;
    const versionWithout = (raisedBy: number): Map<string, number> =>
      new Map([
        [
          bundle.bundleId,
          publishedBundleVersion({
            bundleId: bundle.bundleId,
            revision: revision + raisedBy,
            skillCatalogIds: kept,
          }),
        ],
      ]);

    expect(bundlesBelowSnapshot(versionWithout(0), committed)).toEqual([
      {
        bundleId: 'coding-pr-loop',
        version: bundle.version - droppedVersion,
        recorded: bundle.version,
      },
    ]);
    expect(bundlesBelowSnapshot(versionWithout(droppedVersion + 1), committed)).toEqual([]);
    expect(versionWithout(droppedVersion + 1).get('coding-pr-loop')).toBe(bundle.version + 1);
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
