/**
 * Two applications over one product resolve a shared fetch the same way.
 *
 * Whichever application is serving decides what answers an absolute path: its own
 * route file if one matches, otherwise the BFF catch-all, which forwards the call
 * upstream. So one line of shared code can reach the compiler in one application
 * and an API with no such endpoint in the other.
 *
 * `/api/ui/compile` existed only under `apps/web`, so the local application
 * proxied it upstream and every rendered artifact failed, with both builds green.
 *
 * `/api/realtime/token` is the shape this must not flag: neither application has
 * a route file for it, both proxy it, and that is correct.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

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

const FETCH = /fetch\(\s*['"](\/[^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Absolute paths the shared product fetches, with where each is fetched. */
function fetchedPaths(): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of SHARED) {
    for (const file of sourceFiles(resolve(REPO, root))) {
      for (const match of readFileSync(file, 'utf8').matchAll(FETCH)) {
        const path = match[1] as string;
        if (!found.has(path)) found.set(path, relative(REPO, file));
      }
    }
  }
  return found;
}

/** Whether this application answers that path itself rather than proxying it. */
function hasOwnRoute(app: string, path: string): boolean {
  const dir = resolve(REPO, app, 'src/app', path.replace(/^\//, ''));
  return existsSync(join(dir, 'route.ts')) || existsSync(join(dir, 'route.tsx'));
}

// A guard that enumerated no application would pass by checking nothing, which is
// the one way this can be wrong and look right.
if (APPS.length === 0) throw new Error('no application found to check');

describe('paths the shared product fetches', () => {
  it('every application resolves each one the same way', () => {
    const split = [...fetchedPaths()]
      .map(([path, fetchedIn]) => ({
        path,
        fetchedIn,
        serving: APPS.filter((app) => hasOwnRoute(app, path)),
      }))
      .filter(({ serving }) => serving.length > 0 && serving.length < APPS.length)
      .map(
        ({ path, fetchedIn, serving }) =>
          `${path} (fetched in ${fetchedIn}) has a route only in ${serving.join(', ')};` +
          ` the other application proxies it upstream`,
      );
    expect(split).toEqual([]);
  });

  it('finds the paths it is meant to check', () => {
    // A regex that matches nothing passes the assertion above in silence.
    expect([...fetchedPaths().keys()]).toContain('/api/ui/compile');
  });

  it('sees which application serves a path', () => {
    // And a route lookup that answers "no" everywhere would too.
    expect(APPS.filter((app) => hasOwnRoute(app, '/api/ui/compile'))).toEqual(APPS);
  });
});
