/**
 * Redis clients are built in exactly one place.
 *
 * The server used to construct its own from `process.env.REDIS_URL`, which
 * meant it silently had none of what the shared helper applies: the AUTH
 * password, `rediss://` certificate verification, the retry policy. Enabling
 * AUTH took production down because that client authenticated with nothing —
 * and the TLS hardening added earlier had never reached it either.
 *
 * A second construction path does not announce itself, so this test walks the
 * source for one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

/** The module that is allowed to construct clients. */
const CONNECTION_MODULE = 'packages/redis/src/connection.ts';

const SEARCH_ROOTS = ['apps', 'packages'];
// Fixtures are reached only through the tests beside them, so a client built
// there is test scaffolding like one built in a test file, not a second path
// a service could start on.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.next-dev',
  'coverage',
  '.claude',
  '__fixtures__',
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

describe('redis connection construction', () => {
  it('happens only in the shared connection module', () => {
    const offenders: string[] = [];

    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === CONNECTION_MODULE) continue;

        const text = readFileSync(file, 'utf8');
        // Any `new …Redis(` — a bare identifier, a local alias, or a
        // property access such as `new IORedisModule.Redis(`. The last form
        // is what an earlier, narrower version of this test missed, which is
        // the failure mode a guard like this exists to prevent.
        if (/\bnew\s+[\w$.]*Redis\w*\s*\(/i.test(text)) {
          offenders.push(rel);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is the only place that reads REDIS_URL to decide how to connect', () => {
    const offenders: string[] = [];

    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === CONNECTION_MODULE) continue;

        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          // Reading it to decide *whether* Redis is configured is fine; what
          // must not happen is a connection being built from the value.
          if (!/REDIS_URL/.test(line)) continue;
          if (/\bnew\s+[\w$.]*Redis\w*\s*\(|createClient\s*\(/i.test(line))
            offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
