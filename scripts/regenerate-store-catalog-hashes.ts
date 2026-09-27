/**
 * Rewrites the committed store-catalog hash snapshot
 * (packages/platform-artifacts/src/storeCatalogHashes.json) from the current
 * registry contents. The storeCatalogHashes guard test fails whenever the
 * snapshot drifts: on a content change, bump the changed entry's `version`
 * first, then run this to re-stamp. Re-stamping an entry whose content
 * changed while its version did not is refused — bump the version instead.
 *
 * Run: NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/regenerate-store-catalog-hashes.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeStoreCatalogHashes, type StoreCatalogHashes } from '@aflow/platform-artifacts';

// Without the ts-source condition the hashes would come from a possibly-stale
// prebuilt dist and the snapshot would lie to the guard test.
const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
if (
  !nodeOptions.includes('ts-source') &&
  !process.execArgv.some((arg) => arg.includes('ts-source'))
) {
  console.error(
    'Refusing to write the snapshot from prebuilt dist output. Re-run as:\n' +
      "  NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/regenerate-store-catalog-hashes.ts",
  );
  process.exit(1);
}

const snapshotPath = fileURLToPath(
  new URL('../packages/platform-artifacts/src/storeCatalogHashes.json', import.meta.url),
);
const hashes = computeStoreCatalogHashes();

// Same predicate as the guard test: content moved while the version did not.
const committed: StoreCatalogHashes = existsSync(snapshotPath)
  ? (JSON.parse(readFileSync(snapshotPath, 'utf8')) as StoreCatalogHashes)
  : {};
const unbumped = Object.entries(hashes)
  .filter(([catalogId, entry]) => {
    const prior = committed[catalogId];
    return prior?.version === entry.version && prior.contentHash !== entry.contentHash;
  })
  .map(([catalogId]) => catalogId);
if (unbumped.length > 0) {
  console.error(
    'Refusing to re-stamp listings whose content changed without a version bump:\n' +
      unbumped.map((catalogId) => `  - ${catalogId}`).join('\n') +
      "\nBump each entry's `version`, then re-run.",
  );
  process.exit(1);
}

writeFileSync(snapshotPath, `${JSON.stringify(hashes, null, 2)}\n`);
console.log(`Wrote ${Object.keys(hashes).length} listing hashes to ${snapshotPath}`);
