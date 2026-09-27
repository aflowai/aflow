/**
 * The front door may only send an operator somewhere this build can serve.
 *
 * The hosted application reads the same `entry: 'product'` statement, and both
 * now enter the space the visitor last used. Copying a fixed `/chat` here while
 * the product routes were still moving into the shared package made the first
 * screen of the local edition a 404 — a failure nothing reports, because a
 * redirect to a missing route is a perfectly successful redirect.
 *
 * The destination is a space-relative path now rather than a literal one, so
 * what this asserts is that the path it hands over resolves under `/s/[space]`
 * in this application's own tree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_SRC = readFileSync(resolve(__dirname, './page.tsx'), 'utf8');

/** Every space-relative path this page enters a space with. */
function spaceRelativeTargets(src: string): string[] {
  return [...src.matchAll(/enterPreferredSpace\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/** Every literal path it hands to `redirect()`, if it ever does again. */
function redirectTargets(src: string): string[] {
  return [...src.matchAll(/redirect\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

function servesRoute(...segments: string[]): boolean {
  const dir = resolve(__dirname, ...segments);
  return existsSync(resolve(dir, 'page.tsx')) || existsSync(resolve(dir, 'route.ts'));
}

describe('the local front door', () => {
  it('enters the space it can reach, and nothing else', () => {
    const targets = spaceRelativeTargets(PAGE_SRC);
    // Silence would pass every assertion below, and a door that enters no space
    // is the state this file exists to have left behind.
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const segments = target.replace(/^\//, '').split('/').filter(Boolean);
      expect(
        servesRoute('(dashboard)', 's', '[space]', ...segments),
        `the front door enters a space at ${target}, which this build does not serve`,
      ).toBe(true);
    }
  });

  it('redirects only to routes this application carries', () => {
    for (const target of redirectTargets(PAGE_SRC)) {
      const segments = target.replace(/^\//, '').split('/').filter(Boolean);
      expect(
        servesRoute(...segments),
        `the front door redirects to ${target}, which this build does not serve`,
      ).toBe(true);
    }
  });

  it('links only to routes this application carries', () => {
    const hrefs = [...PAGE_SRC.matchAll(/href=["'](\/[^"']+)["']/g)].map((m) => m[1] as string);
    for (const href of hrefs) {
      const segments = href.replace(/^\//, '').split('/').filter(Boolean);
      expect(
        servesRoute(...segments),
        `the front door links to ${href}, which this build does not serve`,
      ).toBe(true);
    }
  });
});
