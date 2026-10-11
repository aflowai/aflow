/**
 * Version-bump guard: any content change to a store listing must bump the
 * entry's `version`, and the committed snapshot must be regenerated so the
 * new (version, hash) pair is on record. A bundle's version is derived, and
 * may never fall below the one on record.
 */
import { describe, it, expect } from 'vitest';
import { SKILL_BUNDLE_CATALOG } from '../skillBundleCatalog.js';
import { computeStoreCatalogHashes } from '../storeCatalog/index.js';
import { bundlesBelowSnapshot, committedStoreCatalogHashes } from './bundleVersionFloor.js';

const REGENERATE =
  "NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/regenerate-store-catalog-hashes.ts";

describe('store catalog hash snapshot', () => {
  const committed = committedStoreCatalogHashes();
  const current = computeStoreCatalogHashes();

  it('no bundle publishes a version below the one on record', () => {
    const fallen = bundlesBelowSnapshot(
      new Map(SKILL_BUNDLE_CATALOG.map((bundle) => [bundle.bundleId, bundle.version])),
      committed,
    );
    expect(
      fallen.map(
        ({ bundleId, version, recorded }) => `${bundleId} ${String(version)} < ${String(recorded)}`,
      ),
      `A bundle's derived version fell below the one on record, so no space that installed it ` +
        `would be offered the change: ${fallen.map((f) => f.bundleId).join(', ')}. A skill it ` +
        'carries was lowered or dropped. Raise the bundle’s `revision` in skillBundleCatalog.ts ' +
        `until its version passes the one on record, then run: ${REGENERATE}. Regenerating ` +
        'alone records the lower version and offers the change to nobody.',
    ).toEqual([]);
  });

  it('listing content never changes without a version bump', () => {
    const unbumped = Object.entries(current)
      .filter(([catalogId, entry]) => {
        const prior = committed[catalogId];
        return (
          prior !== undefined &&
          prior.version === entry.version &&
          prior.contentHash !== entry.contentHash
        );
      })
      .map(([catalogId]) => catalogId);
    expect(
      unbumped,
      `Listing content changed without a version bump: ${unbumped.join(', ')}. ` +
        `Bump each entry's \`version\`, then run: ${REGENERATE}`,
    ).toEqual([]);
  });

  it('the snapshot matches the registries', () => {
    expect(
      current,
      `Snapshot out of date (new/removed/re-versioned listings). Run: ${REGENERATE}`,
    ).toEqual(committed);
  });
});
