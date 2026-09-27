import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import {
  assertLiteralAbsentInTree,
  assertPatternAbsentInTree,
  extMatches,
} from './grepGateHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function ledgerExclude(rel: string): boolean {
  if (rel.startsWith('docs/')) return true;
  if (rel.endsWith('/ledgerGate.test.ts') || rel.endsWith('/namingGate.test.ts')) return true;
  if (rel.startsWith('packages/schemas/')) return true;
  if (rel.startsWith('scripts/104c-')) return true;
  return false;
}

describe('104c Phase 2 legacy ledger gates', () => {
  const tsInPackagesOrApps = (rel: string) =>
    extMatches(rel, ['.ts']) && (rel.startsWith('packages/') || rel.startsWith('apps/'));

  it('forbids loadLedger( in production code', () => {
    assertPatternAbsentInTree(/loadLedger\s*\(/, {
      repoRoot: REPO_ROOT,
      roots: ['packages', 'apps'],
      includeFile: tsInPackagesOrApps,
      excludeFile: ledgerExclude,
    });
  });

  it('forbids ledgerDocPath in production code', () => {
    assertPatternAbsentInTree(/\bledgerDocPath\b/, {
      repoRoot: REPO_ROOT,
      roots: ['packages', 'apps'],
      includeFile: tsInPackagesOrApps,
      excludeFile: ledgerExclude,
    });
  });

  it('forbids readJsonDoc<WorkflowLedger> in production code', () => {
    assertLiteralAbsentInTree('readJsonDoc<WorkflowLedger>', {
      repoRoot: REPO_ROOT,
      roots: ['packages', 'apps'],
      includeFile: tsInPackagesOrApps,
      excludeFile: ledgerExclude,
    });
  });

  it('no file under packages/cybernetic-runtime/ imports from apps/*', () => {
    assertPatternAbsentInTree(/from\s+['"]apps\//, {
      repoRoot: REPO_ROOT,
      roots: ['packages/cybernetic-runtime'],
      includeFile: (rel) =>
        extMatches(rel, ['.ts']) && !rel.includes('/node_modules/') && !rel.includes('/dist/'),
    });
  });
});
