#!/usr/bin/env node

/**
 * Check if compiled packages are stale (source newer than dist).
 * Prints warnings for any package whose src/ has files newer than dist/.
 * Exit code: 0 (always — advisory only).
 */

import { statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function getNewestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath ?? entry.path ?? dir, entry.name);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return newest;
}

const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const stale = [];

for (const pkg of packages) {
  const srcDir = join(PACKAGES_DIR, pkg, 'src');
  const distDir = join(PACKAGES_DIR, pkg, 'dist');

  if (!existsSync(srcDir)) continue;
  if (!existsSync(distDir)) {
    stale.push({ pkg, reason: 'dist/ missing' });
    continue;
  }

  const srcNewest = getNewestMtime(srcDir);
  const distNewest = getNewestMtime(distDir);

  if (srcNewest > distNewest) {
    const ageSec = Math.round((srcNewest - distNewest) / 1000);
    stale.push({ pkg, reason: `src is ${String(ageSec)}s newer than dist` });
  }
}

if (stale.length > 0) {
  console.warn(
    `\n${DIM}ℹ  Stale dist/ in ${stale.length} package(s) — safe to ignore in dev (ts-source resolves to src/ directly).${RESET}`,
  );
  console.warn(
    `${DIM}  Run ${BOLD}yarn build${RESET}${DIM} before production use or if IDE types look stale.${RESET}\n`,
  );
}
