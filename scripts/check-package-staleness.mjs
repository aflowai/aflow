#!/usr/bin/env node

/**
 * Lists the packages whose build is older than their source.
 * Exit code: 0 (always — advisory only).
 */

import { join } from 'node:path';

import { distStaleness, readWorkspaces } from './webDists.mjs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const stale = [...readWorkspaces(REPO_ROOT).values()]
  .filter((workspace) => workspace.dir.startsWith(PACKAGES_DIR))
  .map((workspace) => ({ name: workspace.name, reason: distStaleness(workspace) }))
  .filter(({ reason }) => reason !== null);

if (stale.length > 0) {
  console.warn(`\n${DIM}ℹ  Stale dist/ in ${String(stale.length)} package(s):${RESET}`);
  for (const { name, reason } of stale) console.warn(`${DIM}  ${name} — ${reason}${RESET}`);
  console.warn(
    `${DIM}  Node services read src/ (ts-source); a Next application reads dist/, and ${BOLD}yarn start${RESET}${DIM} rebuilds the packages it reads before it serves them.${RESET}`,
  );
  console.warn(
    `${DIM}  Run ${BOLD}yarn build${RESET}${DIM} before production use or if IDE types look stale.${RESET}\n`,
  );
}
