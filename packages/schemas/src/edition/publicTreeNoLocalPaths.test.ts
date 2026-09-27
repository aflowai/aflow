/**
 * No file the public repository ships names a real account. A fixture path is a
 * string being parsed rather than a file being opened, so every other check
 * passes on one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ownerOf, survivesCoreCut } from './ownershipLookup.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Binary and generated content, where a byte sequence is not a claim. */
const SKIP = /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|mp[34]|mov|zip|gz|wasm|lock)$/i;

function publicTextFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((file) => {
      const owner = ownerOf(file);
      if (owner === undefined || !survivesCoreCut(owner.owner)) return false;
      if (SKIP.test(file)) return false;
      const full = join(REPO_ROOT, file);
      // A 2MB ceiling keeps a generated blob from dominating the run.
      return existsSync(full) && statSync(full).size < 2 * 1024 * 1024;
    });
}

/**
 * Names a fixture may use. Deliberately short: the point is that a reader can
 * tell at a glance that the path is invented, which a real first name does not
 * achieve however common it is.
 */
const PLACEHOLDER_USERS = new Set([
  'op',
  'someone',
  'probe',
  'you',
  'dev',
  'test',
  'user',
  'example',
  'runner',
]);

describe('the public tree', () => {
  const files = publicTextFiles();

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('names no real macOS home directory, only recognisable stand-ins', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf-8');
      for (const match of source.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
        const name = match[1];
        if (name === undefined || PLACEHOLDER_USERS.has(name)) continue;
        offenders.push(`${file}: ${match[0]} — use a placeholder, not a person`);
        break;
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no Windows user profile', () => {
    const offenders = files.filter((file) =>
      /[Cc]:\\+Users\\+[A-Za-z0-9._-]+/.test(readFileSync(join(REPO_ROOT, file), 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });

  it("names not even this machine's own home directory", () => {
    // Catches the case the pattern above cannot: an author on Linux writing
    // `/home/<their name>/…`, which is indistinguishable from a synthetic path
    // except that it is theirs.
    const home = homedir();
    // A short or root-ish home would match half the tree; there is nothing to
    // assert in that case rather than something to hide.
    if (home.length < 6 || home === '/root') return;
    const offenders = files.filter((file) =>
      readFileSync(join(REPO_ROOT, file), 'utf-8').includes(home),
    );
    expect(offenders).toEqual([]);
  });
});
