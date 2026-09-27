import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// packages/redis/src/__tests__/foo.test.ts → repo root four levels up.
const REPO_ROOT = resolve(here, '..', '..', '..', '..');

/**
 * Every known blocking-command call site (production code only — tests +
 * dist + node_modules are excluded by the scanner).
 *
 * Adding a new entry should be a deliberate review decision: confirm the
 * call goes through a `BlockingRedisConnection` (or, for tests, a
 * dedicated mock connection not shared with anything else in the same
 * process).
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  // ── Shared @aflow/redis helpers (callers pass BlockingRedisConnection) ──
  {
    file: 'packages/redis/src/streams/shardReads.ts',
    reason: 'Shared multi-stream XREADGROUP helper — caller passes a BlockingRedisConnection',
  },
  {
    file: 'packages/redis/src/streams/jobs.ts',
    reason: 'Executor job-stream XREADGROUP — executors pass their dedicated redisBlocking',
  },
  {
    file: 'packages/redis/src/memoryEmbed.ts',
    reason: 'Memory embedder XREADGROUP helper — caller passes a BlockingRedisConnection',
  },
  {
    file: 'packages/redis/src/memoryDocEmbed.ts',
    reason: 'Memory v2 doc-embed XREADGROUP helper — caller passes a BlockingRedisConnection',
  },
  // ── Production consumer loops (each owns its own BlockingRedisConnection) ──
  {
    file: 'packages/cybernetic-runtime/src/workflowTaskProgressConsumer.ts',
    reason: 'Workflow-task progress XREAD BLOCK — Plan 168 §Phase 2 uses dedicated blockingRedis',
  },
  {
    file: 'apps/aflow-orchestrator/src/services/cybernetic/workflowHarnessAdvanceConsumer.ts',
    reason: 'Harness-advance XREADGROUP BLOCK — Plan 168 §Phase 1 uses dedicated blockingRedis',
  },
];

const ALLOWED_FILES = new Set(ALLOWLIST.map((e) => e.file));

/**
 * Match property access to ioredis methods that can block the socket.
 *
 * The pattern is `.<method>` followed by either:
 *   - `(`  — direct invocation `redis.xreadgroup(...)`
 *   - whitespace + `as`  — cast-then-call `(redis.xreadgroup as Fn)(...)`
 *
 * Both patterns appear in production code (the cast form is used in
 * `shardReads.ts` to type-erase ioredis's overload-heavy signature).
 *
 * `xreadgroup` / `xread` without `BLOCK` are non-blocking, but the scan
 * treats them all the same: it's cheaper to allowlist a non-blocking
 * helper than to teach the regex to follow multi-line argument lists, and
 * the false-positive cost is zero.
 *
 * `WAIT` is intentionally excluded — ioredis exposes it as `redis.wait(...)`
 * which collides too aggressively with `Promise.race`, `await wait(...)`
 * helpers, and so on. No code in this repo calls Redis WAIT directly.
 */
const BLOCKING_METHOD_RE =
  /\.\s*(?:xreadgroup|xread|blpop|brpop|bzpopmin|bzpopmax)\b\s*(?:\(|as\s)/i;

/**
 * Filter out comment lines. Strict but cheap: any line whose first
 * non-whitespace characters are `//`, `*`, or `/*` is treated as comment.
 * This drops JSDoc, single-line `//` comments, and block-comment bodies.
 * Trailing `// ...` is also stripped before the regex test.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const SCAN_DIRS = ['apps', 'packages'];

interface Hit {
  relPath: string;
  line: number;
  text: string;
}

function shouldSkipDir(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'build' ||
    name === '__tests__' ||
    name === '.next' ||
    name === '.turbo'
  );
}

function shouldSkipFile(name: string): boolean {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return true;
  if (name.endsWith('.d.ts')) return true;
  if (name.endsWith('.test.ts')) return true;
  if (name.endsWith('.test.tsx')) return true;
  if (name.endsWith('.spec.ts')) return true;
  if (name.endsWith('.spec.tsx')) return true;
  return false;
}

function* walk(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(entry.name)) continue;
      yield full;
    }
  }
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const file of walk(abs)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const relPath = relative(REPO_ROOT, file).split(sep).join('/');
      // Skip this test file itself so the allowlist literals don't match.
      if (relPath.endsWith('blockingCommandInventory.test.ts')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i]!;
        if (isCommentLine(raw)) continue;
        // Strip trailing `// ...` so an inline comment can't trigger.
        const code = raw.replace(/\/\/.*$/, '');
        if (BLOCKING_METHOD_RE.test(code)) {
          hits.push({ relPath, line: i + 1, text: raw });
        }
      }
    }
  }
  return hits;
}

describe('Plan 168 — blocking-command inventory', () => {
  // Cache the scan so both assertions share one filesystem walk.
  let cached: Hit[] | null = null;
  const getHits = (): Hit[] => {
    if (cached === null) cached = scan();
    return cached;
  };

  it('every production blocking call site is on the allowlist', () => {
    const hits = getHits();
    const unknown = hits.filter((h) => !ALLOWED_FILES.has(h.relPath));

    if (unknown.length > 0) {
      const summary = unknown
        .map((h) => `  ${h.relPath}:${String(h.line)}   ${h.text.trim().slice(0, 120)}`)
        .join('\n');
      throw new Error(
        `Plan 168: new blocking-command call site(s) found that are not in the allowlist:\n${summary}\n\n` +
          `If the new site is legitimate, confirm it uses a BlockingRedisConnection ` +
          `(or owns a dedicated, single-loop connection) and add it to ALLOWLIST in ` +
          `packages/redis/src/__tests__/blockingCommandInventory.test.ts.`,
      );
    }

    // Sanity: the scan must have found SOMETHING — if the regex breaks,
    // an empty `hits` array would silently pass.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('every allowlist entry still exists in the source tree', () => {
    const hits = getHits();
    const seen = new Set(hits.map((h) => h.relPath));
    const stale = ALLOWLIST.filter((e) => !seen.has(e.file)).map((e) => e.file);
    expect(
      stale,
      `Allowlist contains paths that no longer have blocking calls: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
