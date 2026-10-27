import { describe, expect, it } from 'vitest';
import {
  CODING_LOOP_PART_IDS,
  getSkillBundleEntry,
  listSkillBundles,
} from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';

describe('Coding Loop Store contract', () => {
  it('owns exactly the four local loop parts, with their usage unchanged', () => {
    expect(CODING_LOOP_PART_IDS).toEqual([
      'local-commission',
      'local-code-review',
      'local-publish',
      'local-shepherd',
    ]);
    const bundle = getSkillBundleEntry('coding-loop');
    const parts = CODING_LOOP_PART_IDS.map((id) => getSkillBundleEntry(id));
    expect(bundle?.skillCatalogIds).toEqual(parts.flatMap((part) => part?.skillCatalogIds ?? []));
    expect(bundle?.prerequisiteBundleIds).toEqual([]);
    expect(bundle?.apiDefinitions.map((definition) => definition.apiId)).toEqual(['github']);
    expect(bundle?.agents).toEqual(getSkillBundleEntry('local-shepherd')?.agents);
    expect(bundle?.agents[0]?.scheduleInput).toBe('scheduleId');
    for (const id of bundle?.skillCatalogIds ?? []) {
      expect(getSkillCatalogEntry(id)?.bundle.workflow.usage).toBeDefined();
    }
  });

  it('offers one local coding bundle and one version', () => {
    expect(
      listSkillBundles({ includeHidden: true })
        .filter((bundle) => bundle.tags.includes('local') && bundle.tags.includes('coding'))
        .map((bundle) => bundle.bundleId)
        .sort(),
    ).toEqual([...CODING_LOOP_PART_IDS, 'coding-loop'].sort());
    const local = listSkillBundles().filter(
      (bundle) => bundle.tags.includes('local') && bundle.tags.includes('coding'),
    );
    expect(local.map((bundle) => bundle.bundleId)).toEqual(['coding-loop']);
    expect(getSkillBundleEntry('coding-loop')?.version).toBeGreaterThan(11 + 11 + 49 + 22);
  });
});
