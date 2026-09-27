/**
 * Version-bump guard: any content change to a store listing must bump the
 * entry's `version`, and the committed snapshot must be regenerated so the
 * new (version, hash) pair is on record.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { computeStoreCatalogHashes, type StoreCatalogHashes } from '../storeCatalog/index.js';

const REGENERATE =
  "NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/regenerate-store-catalog-hashes.ts";

describe('store catalog hash snapshot', () => {
  const committed = JSON.parse(
    readFileSync(new URL('../storeCatalogHashes.json', import.meta.url), 'utf8'),
  ) as StoreCatalogHashes;
  const current = computeStoreCatalogHashes();

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
