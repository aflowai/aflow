#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOTS = ['apps', 'packages'];

// File patterns to skip (test files, generated dist, node_modules, etc.).
const SKIP_PATTERNS = [
  /\bnode_modules\b/,
  /\bdist\b/,
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /__tests__/,
];

// File where the type itself is defined — naturally non-exhaustive.
const ALLOWLIST = [
  'packages/schemas/src/cybernetic/activeSurface.ts',
  'packages/cybernetic-runtime/src/lifecycle.ts',
];

function findCandidateFiles() {
  const out = execSync(
    `git ls-files ${ROOTS.map((r) => `'${r}/**/*.ts' '${r}/**/*.tsx'`).join(' ')}`,
    { encoding: 'utf8', cwd: process.cwd() },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fileImportsLifecycle(content) {
  return /ActiveSurfaceRunLifecycle\b/.test(content);
}

function fileBranchesOnLifecycle(content) {
  // The guard only matters for files that actually MAP a lifecycle to
  // something else (a tone, label, badge variant) via a switch. Files
  // that just pass the value around as data don't need exhaustiveness.
  // Heuristic: look for `switch (` whose discriminant or cases reference
  // lifecycle-like terms.
  if (!/switch\s*\(/m.test(content)) return false;
  // Cheap check: is `lifecycle` mentioned near a switch keyword?
  return /switch\s*\([^)]*lifecycle\b[^)]*\)/m.test(content);
}

function fileIsExhaustive(content) {
  // Pattern 1: `Record<ActiveSurfaceRunLifecycle, …>` — TS enforces.
  if (/Record<\s*ActiveSurfaceRunLifecycle\s*,/m.test(content)) return true;
  // Pattern 2: `satisfies Record<…>` for a constant — same enforcement.
  if (/satisfies\s+Record<\s*ActiveSurfaceRunLifecycle\s*,/m.test(content)) return true;
  // Pattern 3: `assertExhaustiveLifecycle` used somewhere.
  if (/assertExhaustiveLifecycle\s*\(/m.test(content)) return true;
  return false;
}

function main() {
  const files = findCandidateFiles();
  const offenders = [];

  for (const file of files) {
    if (SKIP_PATTERNS.some((re) => re.test(file))) continue;
    if (ALLOWLIST.some((p) => file.endsWith(p))) continue;

    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (!fileImportsLifecycle(content)) continue;
    // Only flag files that actually branch on the lifecycle value.
    // Files that just pass it around as data are safe.
    if (!fileBranchesOnLifecycle(content)) continue;
    if (fileIsExhaustive(content)) continue;

    offenders.push(file);
  }

  if (offenders.length === 0) {
    console.log('✓ check-lifecycle-exhaustive: every consumer is exhaustive.');
    process.exit(0);
  }

  console.error('✗ check-lifecycle-exhaustive: the following files import');
  console.error('  ActiveSurfaceRunLifecycle but do not use a typed exhaustive');
  console.error('  pattern (Record<…> table OR assertExhaustiveLifecycle).');
  console.error('');
  for (const file of offenders) {
    console.error(`    ${file}`);
  }
  console.error('');
  console.error('  Add a `Record<ActiveSurfaceRunLifecycle, …>` table or end your');
  console.error('  switch statement with `assertExhaustiveLifecycle(value)`. See');
  console.error('  Plan 102m §6.1 for the pattern.');
  process.exit(1);
}

main();
