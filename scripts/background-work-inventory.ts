/**
 * Print the static background-work inventory as `file -> rule -> count`, in the
 * shape the registry's `sites[].discovery` declares.
 *
 * Run: yarn background-work:inventory
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countByFileAndRule,
  scanBackgroundWork,
} from '../packages/schemas/src/__tests__/backgroundWorkScanner.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const counts = countByFileAndRule(scanBackgroundWork(repoRoot));

const inventory: Record<string, Record<string, number>> = {};
for (const [file, rules] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
  inventory[file] = Object.fromEntries([...rules].sort(([a], [b]) => a.localeCompare(b)));
}

console.info(JSON.stringify(inventory, null, 2));
