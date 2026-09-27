/**
 * An asset the shared product asks for exists in every application serving it.
 *
 * A package carries no `public/`, so the path a component names is resolved from
 * the serving application's own assets. `/jester.svg` and `/icecream.svg` existed
 * only under `apps/web`, so every loading state in the appliance and in
 * `dev:local` drew a broken image.
 *
 * Nothing fails when one is missing: the build succeeds, the page renders, and a
 * browser draws the broken-image glyph.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Packages whose components are rendered by an application's own routes. */
const SHARED = ['packages/web-product/src', 'packages/design-system/src'];

/**
 * Applications that serve the shared product, as this checkout has them.
 *
 * Derived rather than listed: the edition cut removes the hosted application, so
 * a hardcoded `apps/web` turns this guard into a failure in the very tree it
 * exists to protect — and the application it protects there, `apps/web-local`, is
 * the one that ships. A third application would be covered without an edit.
 */
const APPS = ['apps/web', 'apps/web-local'].filter((app) => existsSync(join(REPO, app)));

// Both quote styles: JSX writes `src="/frog.svg"` where a module writes `'/jester.svg'`.
const ASSET = /['"](\/[a-zA-Z0-9._-]+\.(?:svg|png|jpe?g|webp|gif|ico))['"]/g;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Absolute asset paths the shared product names, with where each is named. */
function requestedAssets(): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of SHARED) {
    for (const file of sourceFiles(resolve(REPO, root))) {
      for (const match of readFileSync(file, 'utf8').matchAll(ASSET)) {
        const asset = match[1] as string;
        if (!found.has(asset)) found.set(asset, relative(REPO, file));
      }
    }
  }
  return found;
}

// A guard that enumerated no application would pass by checking nothing, which is
// the one way this can be wrong and look right.
if (APPS.length === 0) throw new Error('no application found to check');

describe('assets the shared product asks for', () => {
  for (const app of APPS) {
    it(`${app} carries every one of them`, () => {
      // Without this, an application removed by an edition cut reports all 16 as
      // missing rather than saying it is gone.
      expect(existsSync(resolve(REPO, app, 'public'))).toBe(true);
      const missing = [...requestedAssets()]
        .filter(([asset]) => !existsSync(resolve(REPO, app, 'public', asset.replace(/^\//, ''))))
        .map(([asset, namedIn]) => `${asset} (named in ${namedIn})`);
      expect(missing).toEqual([]);
    });
  }

  it('finds the paths it is meant to check', () => {
    // A regex that matches nothing passes every assertion above in silence.
    const asked = requestedAssets();
    expect(asked.size).toBeGreaterThan(8);
    // One of each quote style, so narrowing the pattern to either one fails here.
    expect([...asked.keys()]).toEqual(expect.arrayContaining(['/jester.svg', '/frog.svg']));
  });
});
