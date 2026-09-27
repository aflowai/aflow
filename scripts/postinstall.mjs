#!/usr/bin/env node

/**
 * postinstall script — builds the shared packages after `yarn install`.
 *
 * Skips in production because:
 *  1. Packages are already built by the image or CI build step.
 *  2. devDependencies (tsc, tsup) may have been pruned.
 *
 * Vercel installs with SKIP_POSTINSTALL (apps/web/vercel.json) and builds
 * only the web app's transitive workspace closure in its build command.
 */

import { execSync } from 'node:child_process';

if (process.env.NODE_ENV === 'production' || process.env.SKIP_POSTINSTALL) {
  console.log('[postinstall] Skipping builds');
  process.exit(0);
}

// Activate git hooks (simple-git-hooks). Silently skipped if .git is absent (Docker / CI).
try {
  execSync('npx simple-git-hooks', { stdio: 'inherit' });
} catch {
  // Not fatal — .git may be absent in some build contexts
}

// Build every packages/* workspace in dependency order derived from the
// workspace manifests — vitest resolves cross-package imports to dist/, so a
// fresh clone needs them all. Apps build in their own deploy pipelines.
execSync(
  "yarn workspaces foreach --recursive --parallel --topological-dev --from 'packages/*' run build",
  { stdio: 'inherit' },
);
