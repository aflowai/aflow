/**
 * Guard: one rule for reading a model ref, in `catalog.ts`.
 *
 * The prefix rules that route an off-catalog ref existed in three places — the
 * AI executor, the readiness endpoint (commented "keep in sync"), and the BYOK
 * client factory, which exported its own function under the same name as the
 * shared one. They had already drifted: two of the three sent any slash-bearing
 * ref to OpenRouter, so a Fireworks id spent the OpenRouter key and came back
 * with that vendor's rejection of a model it was never asked to serve.
 *
 * Consolidating them is not self-enforcing — the third copy was missed by the
 * same grep that found the first two — so this fails on a fourth.
 */
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

/** Located by marker, not by counting `..` — the count silently resolves
 *  elsewhere when the module path differs, which reads as a guard failure. */
async function findRepoRoot(from: string): Promise<string> {
  let dir = from;
  const { root } = parse(dir);
  while (dir !== root) {
    try {
      await access(join(dir, 'yarn.lock'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`repo root not found above ${from}`);
}

const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const SEARCH_ROOTS = [join(repoRoot, 'apps'), join(repoRoot, 'packages')];

/** The owner of the rule, and the only file allowed to spell it out. */
const OWNER = 'packages/ai-client/src/catalog.ts';

/**
 * Routing an off-catalog ref by its shape. Matched on the decision — a literal
 * provider id produced from a bare spelling test — so a copy that renames its
 * function or reorders its branches is still caught.
 */
const ROUTES_BY_SHAPE =
  /(startsWith\(['"]claude-|startsWith\(['"]gemini-|includes\(['"]\/['"]\))[\s\S]{0,80}?return ['"](anthropic|google|openai|openrouter|fireworks)['"]/;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next')
        continue;
      out.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('provider inference consolidation', () => {
  it('only the catalog routes a model ref by its spelling', async () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      const sources = await collectSourceFiles(root);
      // An empty sweep would pass vacuously — the guard must fail loudly if it
      // is ever pointed at the wrong tree.
      expect(sources.length).toBeGreaterThan(0);
      for (const file of sources) {
        const rel = file.slice(repoRoot.length + 1);
        if (rel === OWNER) continue;
        if (ROUTES_BY_SHAPE.test(await readFile(file, 'utf-8'))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the owner still carries the rule the guard is pointed at', async () => {
    // Without this the guard passes for the wrong reason the day the rule moves.
    expect(ROUTES_BY_SHAPE.test(await readFile(join(repoRoot, OWNER), 'utf-8'))).toBe(true);
  });
});
