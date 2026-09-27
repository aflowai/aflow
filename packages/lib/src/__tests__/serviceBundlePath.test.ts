/**
 * Which composition root an artifact serves, and how the launcher finds the
 * rest.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CORE_SERVER_ROOT, HOSTED_SERVER_ROOT, serviceBundlePath } from '../serviceBundlePath.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const coreOnly = { exists: (path: string) => path === CORE_SERVER_ROOT };
const hosted = { exists: () => true };

describe('serviceBundlePath', () => {
  it('derives every non-server service from its name', () => {
    const none = { exists: () => false };
    expect(serviceBundlePath('orchestrator', none)).toBe('apps/aflow-orchestrator/dist/index.js');
    expect(serviceBundlePath('executor-compute', none)).toBe(
      'apps/aflow-executor-compute/dist/index.js',
    );
    expect(serviceBundlePath('executor-mcp', none)).toBe('apps/aflow-executor-mcp/dist/index.js');
  });

  it('serves the core root when that is the only one the artifact has', () => {
    expect(serviceBundlePath('server', coreOnly)).toBe(CORE_SERVER_ROOT);
  });

  // The half a deploy path could otherwise forget. No deployment names the
  // hosted root; the artifact containing it is what selects it.
  it('serves the hosted root when the artifact contains one', () => {
    expect(serviceBundlePath('server', hosted)).toBe(HOSTED_SERVER_ROOT);
  });

  // Both constants followed a workspace rename without a word, because every
  // assertion here reads them rather than a literal. A stale one costs nothing
  // at build time and serves the core product from the hosted artifact, since
  // the selection above falls back rather than failing.
  //
  // An equivalence rather than two existence checks, because the hosted
  // workspace is absent from a public-core tree on purpose — that absence is
  // what makes the fallback choose the core root. Asserting it exists fails the
  // cut for having worked; skipping the check when it is missing would excuse
  // the stale constant in the one tree that still has a hosted artifact to run.
  const sourceOf = (root: string) => root.replace('/dist/', '/src/').replace(/\.js$/, '.ts');

  it('names a root the core workspace builds', () => {
    const source = sourceOf(CORE_SERVER_ROOT);
    expect(existsSync(join(repoRoot, source)), `${CORE_SERVER_ROOT} -> ${source}`).toBe(true);
  });

  it('names a hosted root exactly when this tree contains the hosted workspace', () => {
    const source = sourceOf(HOSTED_SERVER_ROOT);
    const workspace = join(repoRoot, 'apps/server-hosted/package.json');
    expect(existsSync(join(repoRoot, source)), `${HOSTED_SERVER_ROOT} -> ${source}`).toBe(
      existsSync(workspace),
    );
  });

  it('lets a distribution name a root of its own', () => {
    expect(serviceBundlePath('server', { ...hosted, override: 'dist/elsewhere.js' })).toBe(
      'dist/elsewhere.js',
    );
    // An empty variable is an unset one, not a request to run nothing.
    expect(serviceBundlePath('server', { ...hosted, override: '' })).toBe(HOSTED_SERVER_ROOT);
  });
});
