/**
 * An application's own links must name routes that application serves.
 *
 * `navRouteCoverage` holds the shared shell to the manifest, which is what the
 * shell is built from. An application's own files are not: `apps/web` writes
 * links in its auth callback, its marketing chrome and its invite flow, and
 * nothing compared those against its route tree.
 *
 * Deleting the legacy `/chat` redirect left four of them pointing at it. The
 * build passed, every test passed, and signing in to production landed on
 * "page not found" — a link is a string, and a string to a missing route
 * fails only when someone follows it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const APPS = ['apps/web', 'apps/web-local'] as const;

/**
 * Paths an application may name without serving: another origin's concern, or a
 * framework route that exists without a file of its own.
 */
const SERVED_ELSEWHERE = [
  '/auth', // the identity provider's own routes, mounted by its middleware
  '/api', // route handlers, which live under a different tree shape
  '/_next',
  '/robots.txt',
  '/sitemap.xml',
  '/favicon.ico',
];

/**
 * Files whose links may name a route the core cut removes.
 *
 * Each of these is a hosted surface in substance — the marketing landing, and
 * the notice shown to an authenticated user the server refused to admit, which
 * is an invite relationship an appliance does not have. None carries an
 * ownership rule, so each resolves to `core` and survives a cut that deletes
 * what it links to.
 *
 * The rule is the thing that is wrong, not the link. Classifying the cluster
 * `cloud` is the fix and it is not a mechanical one: `app/page.tsx` renders the
 * marketing landing and `(dashboard)/layout.tsx` renders the admission gate, so
 * removing them from the cut means deciding what the public application's root
 * and dashboard do instead. Recorded in 246a §"the marketing and legal cluster
 * is unclassified" as a Train 3 decision.
 *
 * Keyed on the file rather than the path: a link to `/request-access` from
 * anywhere else is a genuine dangling link and still fails here.
 */
const HOSTED_IN_SUBSTANCE_PENDING_CLASSIFICATION = [
  'apps/web/src/components/admission-gate.tsx',
  'apps/web/src/components/marketing/LandingShowcase.tsx',
  'apps/web/src/components/marketing/SuspendedLanding.tsx',
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.name === '.next' || entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Absolute paths this file points a browser at. */
function linkTargets(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/href=(?:"(\/[^"#?]*)"|\{'(\/[^'#?]*)'\})/g)) {
    found.add((m[1] ?? m[2]) as string);
  }
  for (const m of source.matchAll(/router\.(?:push|replace)\('(\/[^'#?]*)'\)/g)) {
    found.add(m[1] as string);
  }
  for (const m of source.matchAll(/new URL\('(\/[^'#?]*)'/g)) found.add(m[1] as string);
  for (const m of source.matchAll(/returnTo=(\/[^'"&\s]*)/g)) found.add(m[1] as string);
  return [...found];
}

/** Whether an application's route tree answers a path. */
function serves(app: string, path: string): boolean {
  if (path === '/') return existsSync(resolve(REPO, app, 'src/app/page.tsx'));
  const segments = path.replace(/^\//, '').split('/').filter(Boolean);
  // A route may sit at the top level or inside any group directory, which is
  // what `(dashboard)` is — a grouping that does not appear in the URL.
  const roots = [resolve(REPO, app, 'src/app')];
  for (const entry of readdirSync(roots[0] as string, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('(')) {
      roots.push(join(roots[0] as string, entry.name));
    }
  }
  return roots.some((root) => {
    const dir = join(root, ...segments);
    return existsSync(join(dir, 'page.tsx')) || existsSync(join(dir, 'route.ts'));
  });
}

describe('an application links only where it can answer', () => {
  for (const app of APPS) {
    it(`${app} names no route it does not serve`, () => {
      const dangling: string[] = [];
      for (const file of sourceFiles(resolve(REPO, app, 'src'))) {
        const where = relative(REPO, file);
        if (HOSTED_IN_SUBSTANCE_PENDING_CLASSIFICATION.includes(where)) continue;
        for (const target of linkTargets(readFileSync(file, 'utf8'))) {
          if (SERVED_ELSEWHERE.some((prefix) => target.startsWith(prefix))) continue;
          if (serves(app, target)) continue;
          dangling.push(`${where} -> ${target}`);
        }
      }
      expect(dangling).toEqual([]);
    });
  }
});
