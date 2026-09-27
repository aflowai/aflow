/**
 * Guard: a Postgres constraint is recognized through `databaseErrorText`.
 *
 * Drizzle's error message holds the SQL and its params; the constraint name is
 * on the cause. A guard written against `error.message` therefore never fires,
 * and the mistake survives review because the logs disagree with the runtime —
 * the log serializer folds the cause back into the message, so the constraint
 * name is right there in the error payload that never matched. This asserts
 * the one property that makes the shape unmissable: a file that matches
 * constraint vocabulary imports the helper that reads the whole chain.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const serverSrc = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `.includes('…')` where the literal names a Postgres constraint failure. */
const CONSTRAINT_MATCH = /includes\(\s*['"`][^'"`]*(unique|duplicate key|violates|constraint)/i;

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      found.push(full);
    }
  }
  return found;
}

describe('database constraint matching', () => {
  it('matches constraint names through databaseErrorText, never a bare message', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(serverSrc)) {
      // The helper's own home, where the vocabulary is the subject.
      if (file.endsWith('/lib/databaseErrors.ts')) continue;
      const src = await readFile(file, 'utf-8');
      if (!CONSTRAINT_MATCH.test(src)) continue;
      if (!src.includes('databaseErrorText')) {
        offenders.push(file.slice(serverSrc.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
