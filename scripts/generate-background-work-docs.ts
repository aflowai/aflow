/**
 * Regenerate docs/architecture/background-work.md from the checked registry.
 *
 * Run: NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/generate-background-work-docs.ts
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBackgroundWorkCatalog } from '../packages/schemas/src/background/renderCatalog.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, 'docs/architecture/background-work.md');

/**
 * A task implemented by a workspace an edition cut removed is not documented.
 * The registry survives the cut and the catalog is byte-compared, so documenting
 * one would commit a claim about work the artifact cannot do and then assert it.
 */
const carriedByThisCheckout = (path: string): boolean => existsSync(join(repoRoot, path));

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderBackgroundWorkCatalog(carriedByThisCheckout), 'utf8');

console.info(`Wrote ${target}`);
