/**
 * The route tree on disk is the manifest's, and nothing else's.
 *
 * Next resolves routes from the filesystem, so the manifest only means anything
 * if the files match it. A hand-edited entry, a screen renamed without the table,
 * or a route dropped from an edition and left on disk all make the boundary a
 * claim rather than a property — and each is silent, because a stale entry file
 * still compiles and still renders.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ROUTE_MANIFEST } from './routeManifest.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('the generated route tree', () => {
  it('lists routes to generate', () => {
    // An empty manifest would satisfy a comparison against an empty tree.
    expect(ROUTE_MANIFEST.length).toBeGreaterThan(0);
  });

  it('names an edition for every route', () => {
    for (const entry of ROUTE_MANIFEST) {
      expect(entry.editions.length, `${entry.route} belongs to no edition`).toBeGreaterThan(0);
    }
  });

  it('claims each route once per edition', () => {
    const seen = new Set<string>();
    for (const entry of ROUTE_MANIFEST) {
      for (const edition of entry.editions) {
        const key = `${edition}:${entry.route}:${entry.kind ?? 'page'}`;
        expect(
          seen.has(key),
          `${entry.route} (${entry.kind ?? 'page'}) is claimed twice in ${edition}`,
        ).toBe(false);
        seen.add(key);
      }
    }
  });

  it('matches what is on disk', () => {
    // Throws with the offending paths when the tree and the table disagree.
    execFileSync('node', ['scripts/generate-web-routes.mjs', '--check'], {
      cwd: REPO,
      stdio: 'pipe',
    });
  });
});
