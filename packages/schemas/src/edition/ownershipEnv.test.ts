/**
 * Guard: every documented environment variable is classified, and no surviving
 * code reads a key the manifest says a cut deletes.
 *
 * `ENTERPRISE_ONLY_ENV_KEYS` and `ENV_OWNERSHIP` answer different questions and
 * are checked against each other only where they overlap. The former is the
 * narrower one on purpose — it names keys whose readers would stand an
 * enterprise plane *up*, so a local boot refuses them — while ownership is
 * about what a public cut deletes. They come apart in both directions:
 * `SES_*` is `core` and `aflow-executor-user` still reads it after the cut,
 * because the appliance sends its own mail, while `AUTH0_CLIENT_ID` is on the
 * refusal list and `cloud` — a local boot rejects it and no surviving reader
 * wants it.
 *
 * The check that actually holds ownership honest is the last one: a key the
 * manifest calls `cloud` must have no reader that survives the cut. If one
 * does, the classification is wrong, whatever the boot does about it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENTERPRISE_ONLY_ENV_KEYS } from './descriptor.js';
import { ENV_CLOUD_KEYS_READ_BEFORE_EXTRACTION, ENV_OWNERSHIP } from './ownership.js';
import { cutWasPerformed, ownerOf, survivesCoreCut } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * `git grep`, where finding nothing is an answer rather than a failure.
 *
 * It exits 1 on no match, which `execFileSync` raises. Both checks below are
 * about absence: one passes when nothing matches and the other reports a key
 * with no readers left, so the raise turned the very outcome being looked for
 * into a crash.
 */
function gitGrep(args: readonly string[]): string[] {
  try {
    return execFileSync('git', ['grep', ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter((line) => line.trim() !== '');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** What the tree contains, for deciding whether the cut has been performed. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/**
 * Keys the example file documents, commented or not.
 *
 * A commented key is the normal way an example file offers optional
 * configuration, and reading only uncommented lines would let the whole cloud
 * half of the file opt out of being classified.
 */
function documentedKeys(): string[] {
  const example = readFileSync(join(repoRoot, '.env.example'), 'utf-8');
  const keys = new Set<string>();
  for (const line of example.split('\n')) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1] !== undefined) keys.add(match[1]);
  }
  return [...keys].sort();
}

describe('environment ownership', () => {
  it('classifies every key in .env.example, commented or not', () => {
    const unclassified = documentedKeys().filter((key) => ENV_OWNERSHIP[key] === undefined);
    expect(unclassified).toEqual([]);
  });

  it('is reading an .env.example that has keys in it', () => {
    expect(documentedKeys().length).toBeGreaterThan(20);
  });

  it('is comparing against a refusal list that has keys in it', () => {
    // Without this the agreement check below passes hardest when the list it
    // agrees with is empty.
    expect(ENTERPRISE_ONLY_ENV_KEYS.length).toBeGreaterThan(2);
  });

  it('agrees, where the two overlap, with the keys a local boot refuses', () => {
    const disagreements = ENTERPRISE_ONLY_ENV_KEYS.filter(
      (key) => ENV_OWNERSHIP[key] !== 'cloud',
    ).map((key) => `${key}: manifest says ${String(ENV_OWNERSHIP[key])}, boot refuses it locally`);
    expect(disagreements).toEqual([]);
  });

  it('names no key that neither the example file nor the descriptor knows', () => {
    const known = new Set([...documentedKeys(), ...ENTERPRISE_ONLY_ENV_KEYS]);
    // The cut removes cloud keys from the example file along with their readers.
    const cut = cutWasPerformed(trackedFiles());
    const orphans = Object.keys(ENV_OWNERSHIP).filter(
      (key) => !known.has(key) && !(cut && ENV_OWNERSHIP[key] === 'cloud'),
    );
    expect(orphans).toEqual([]);
  });

  it('excuses only keys that are still read, so the list shrinks as P2 lands', () => {
    // Asserting the key is classified `cloud` would have excused it forever —
    // the entry outliving its own fix. This looks for a surviving reader, so an
    // entry whose plane has been extracted becomes a failure telling somebody
    // to delete it.
    const stale: string[] = [];
    for (const key of ENV_CLOUD_KEYS_READ_BEFORE_EXTRACTION) {
      if (ENV_OWNERSHIP[key] !== 'cloud') {
        stale.push(`${key} is no longer classified cloud`);
        continue;
      }
      const hits = gitGrep([
        '-l',
        key,
        '--',
        'apps',
        'packages',
        ':!*.test.ts',
        ':!*/dist/*',
        ':!packages/schemas/src/edition/*',
      ]);
      const stillRead = hits.some((file) => {
        const owner = ownerOf(file);
        return owner !== undefined && survivesCoreCut(owner.owner);
      });
      if (!stillRead) stale.push(`${key} has no surviving reader`);
    }
    expect(stale).toEqual([]);
  });

  it('has no surviving source reading a key the cut deletes', () => {
    const excused = new Set(ENV_CLOUD_KEYS_READ_BEFORE_EXTRACTION);
    const cloudKeys = Object.entries(ENV_OWNERSHIP)
      .filter(([key, owner]) => owner === 'cloud' && !excused.has(key))
      .map(([key]) => key);
    expect(cloudKeys.length).toBeGreaterThan(5);

    const readers = gitGrep([
      '-nE',
      cloudKeys.join('|'),
      '--',
      'apps',
      'packages',
      'scripts',
      ':!*.test.ts',
      ':!*.test.tsx',
      ':!*/dist/*',
      // The files that classify keys name them for a living; a mention there
      // is the classification, not a reader of the configuration.
      ':!packages/schemas/src/edition/*',
    ]);

    // The grep matching nothing would report every cloud key unread, which is
    // also what a mistyped pathspec looks like. Demanded only of a tree that
    // still has the readers: after the cut, nothing reading a cloud key is
    // precisely the outcome, and asserting otherwise fails the cut for having
    // worked.
    if (!cutWasPerformed(trackedFiles())) expect(readers.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const line of readers) {
      const file = line.slice(0, line.indexOf(':'));
      if (file === '') continue;
      const match = ownerOf(file);
      // A file the manifest calls cloud is allowed to read a cloud key; that
      // is what makes it cloud. Anything surviving the cut is not.
      if (match !== undefined && survivesCoreCut(match.owner)) violations.push(line.slice(0, 140));
    }
    expect(violations).toEqual([]);
  });
});
