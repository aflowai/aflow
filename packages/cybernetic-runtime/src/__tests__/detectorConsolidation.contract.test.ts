import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ → src → cybernetic-runtime → packages → repo root
const REPO_ROOT = join(__dirname, '../../../..');

/** The two gated engine symbols. */
const GATED_SYMBOLS = ['validateWorkflowGraph', 'deriveOpBoundProducerShapes'];

/**
 * Files allowed to import the engine directly, relative to REPO_ROOT:
 *   - the shared-functions module (the sole legal caller);
 *   - the definition modules themselves (they declare, not import, but list
 *     them for clarity / future-proofing against a self-import).
 */
const ALLOWLIST = new Set([
  'packages/cybernetic-runtime/src/skillValidity/skillValidity.ts',
  'packages/cybernetic-runtime/src/scheduling/graphValidation.ts',
  'packages/cybernetic-runtime/src/scheduling/deriveOpBoundShapes.ts',
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
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * The set of gated symbols this file imports (as named imports). Re-exports
 * (`export ... from`) and prose comments are intentionally NOT matched — only
 * `import { ... } from '...'` statements, including multi-line ones.
 */
function importedGatedSymbols(src: string): string[] {
  const found = new Set<string>();
  const importStmt = /\bimport\b[^;]*?\{([^}]*)\}[^;]*?from\s*['"][^'"]+['"]/gs;
  for (const m of src.matchAll(importStmt)) {
    const named = m[1] ?? '';
    for (const sym of GATED_SYMBOLS) {
      if (new RegExp(`\\b${sym}\\b`).test(named)) found.add(sym);
    }
  }
  return [...found];
}

describe('Plan 190 §8 — detector consolidation guard', () => {
  it('only the shared validity module imports the validity engine', () => {
    const roots = [join(REPO_ROOT, 'packages'), join(REPO_ROOT, 'apps')];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of walkSrcTsFiles(root)) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWLIST.has(rel)) continue;
        const imported = importedGatedSymbols(readFileSync(file, 'utf8'));
        if (imported.length > 0) {
          offenders.push(`${rel} imports [${imported.join(', ')}]`);
        }
      }
    }

    expect(
      offenders,
      'These files import the validity engine directly. Route them through ' +
        'materializeAndValidateSkillConfig / ensureCurrentSkillValidity instead (Plan 190 §8).',
    ).toEqual([]);
  });
});
