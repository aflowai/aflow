/**
 * The floor under a bundle's published version: the version the committed
 * snapshot records for it. The Store offers a space an update only when a
 * bundle's version passes the one it installed, so a bundle whose derived
 * version falls — a skill it carries lowered, or one it stops carrying — is
 * offered to nobody who has it until it climbs past that version again.
 */
import { readFileSync } from 'node:fs';

import type { StoreCatalogHashes } from '../storeCatalog/index.js';

export function committedStoreCatalogHashes(): StoreCatalogHashes {
  return JSON.parse(
    readFileSync(new URL('../storeCatalogHashes.json', import.meta.url), 'utf8'),
  ) as StoreCatalogHashes;
}

/** Each bundle published below the version `committed` records for it, with both versions. */
export function bundlesBelowSnapshot(
  published: ReadonlyMap<string, number>,
  committed: StoreCatalogHashes,
): Array<{ bundleId: string; version: number; recorded: number }> {
  return [...published].flatMap(([bundleId, version]) => {
    const recorded = committed[bundleId]?.version;
    return recorded !== undefined && version < recorded ? [{ bundleId, version, recorded }] : [];
  });
}
