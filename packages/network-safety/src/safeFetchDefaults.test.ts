/**
 * An injected transport defaults to a checked fetcher.
 *
 * These call sites take `fetchImpl` so tests can supply one, and fall back to a
 * default in production. When that default is the global `fetch`, the URL is
 * validated once and then dialled by name — which is a different resolution,
 * and for a dual-stack host a different address. Two of these existed side by
 * side and only one was converted; nothing failed, because the surviving one
 * looked exactly like the code around it.
 *
 * So the rule is checked by shape rather than per site.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SEARCH_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.next-dev', 'coverage', '.claude']);

/**
 * Sites that keep the global `fetch` on purpose. Both POST credentials to an
 * OAuth token endpoint: they are gated by `validateCredentialedUrl` (https
 * only, where certificate validation is what defeats a rebind) and already
 * pass `redirect: 'error'`. Routing them through `safeFetch` would add a second
 * resolution per call and change nothing about what they reach.
 */
const ALLOWED_RAW_FETCH_DEFAULTS = new Set([
  'packages/oauth/src/tokenManager.ts',
  'apps/aflow-executor-mcp/src/auth/clientCredentialsToken.ts',
]);

function* sourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      yield full;
    }
  }
}

describe('injected fetch defaults', () => {
  it('never fall back to the unchecked global fetch', () => {
    const offenders: string[] = [];

    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWED_RAW_FETCH_DEFAULTS.has(rel)) continue;

        for (const line of readFileSync(file, 'utf8').split('\n')) {
          // `x = something ?? fetch` — the fallback, not a call.
          if (/\?\?\s*fetch\s*[;,)]/.test(line)) {
            offenders.push(`${rel}: ${line.trim()}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the exception list honest — each entry still refuses redirects', () => {
    for (const rel of ALLOWED_RAW_FETCH_DEFAULTS) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text, `${rel} must refuse redirects`).toMatch(/redirect:\s*'error'/);
      expect(text, `${rel} must require https`).toMatch(/validateCredentialedUrl/);
    }
  });
});
