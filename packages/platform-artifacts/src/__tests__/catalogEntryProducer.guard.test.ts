/**
 * Plan 264 P10 — curated-in, authored-locally, NOTHING-out: the platform
 * registry is the only producer of store catalog entries. This guard fails
 * when any other source file imports `CatalogEntrySchema` (the sole way to
 * mint a `CatalogEntry`), so a runtime write path into the catalog cannot
 * appear silently. Same mechanism as `detectorConsolidation.contract.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ → src → platform-artifacts → packages → repo root
const REPO_ROOT = join(__dirname, '../../../..');

const GATED_SYMBOL = 'CatalogEntrySchema';

/**
 * Files allowed to import the entry schema, relative to REPO_ROOT:
 *   - the schema's own module tree (declaration + re-export barrels);
 *   - the store registry — the sole producer (parses every listing at load);
 *   - the read-surface op contracts that embed the schema to VALIDATE
 *     listings they return, never to mint them.
 */
const ALLOWLIST = new Set([
  'packages/schemas/src/store/catalogEntry.ts',
  'packages/schemas/src/store/canonicalContent.ts',
  'packages/platform-artifacts/src/storeCatalog/index.ts',
  'packages/schemas/src/operations/store.ts',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '__tests__', 'coverage']);

function walkSrcTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkSrcTsFiles(join(dir, entry.name)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Named imports only — re-exports and prose comments intentionally unmatched. */
function importsGatedSymbol(src: string): boolean {
  const importStmt = /\bimport\b[^;]*?\{([^}]*)\}[^;]*?from\s*['"][^'"]+['"]/gs;
  for (const m of src.matchAll(importStmt)) {
    if (new RegExp(`\\b${GATED_SYMBOL}\\b`).test(m[1] ?? '')) return true;
  }
  return false;
}

describe('Plan 264 P10 — catalog entry producer guard', () => {
  it('only the registry (and the schema tree) touches CatalogEntrySchema', () => {
    const roots = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'apps')];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of walkSrcTsFiles(root)) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWLIST.has(rel)) continue;
        if (importsGatedSymbol(readFileSync(file, 'utf8'))) {
          offenders.push(rel);
        }
      }
    }

    expect(
      offenders,
      'These files import CatalogEntrySchema. Catalog entries are curated: they are produced ' +
        'only by the platform registry (packages/platform-artifacts/src/storeCatalog) — there is ' +
        'no runtime write path from a space into the catalog (Plan 264 P10).',
    ).toEqual([]);
  });
});
