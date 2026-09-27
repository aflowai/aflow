/**
 * Guard: every tracked file carries an ownership classification.
 *
 * This is what makes the manifest a classification rather than a description
 * of one. A new workspace, page, script or deployment file arrives with its
 * edition undecided by default, and undecided is the state this train exists
 * to fix: a local build that still contains cloud-only code because nothing
 * ever had to say otherwise.
 *
 * It reads `git ls-files` rather than walking the filesystem, so build output,
 * node_modules and a sibling worktree's scratch can neither make it pass nor
 * fail.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OWNERSHIP_MANIFEST } from './ownership.js';
import { cutWasPerformed, ownerOf, survivesCoreCut } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.trim() !== '');
}

describe('ownership manifest', () => {
  it('classifies every tracked file', () => {
    const unclassified = trackedFiles().filter((file) => ownerOf(file) === undefined);
    expect(unclassified).toEqual([]);
  });

  it('is reading a repository that has files in it', () => {
    // Without this, a `git ls-files` returning nothing would report a fully
    // classified repository.
    expect(trackedFiles().length).toBeGreaterThan(1000);
  });

  // Two rules for one path make the classification depend on array order:
  // `ownerOf` breaks a length tie on whichever it met first, so the second is
  // both unreachable and free to disagree. That is how `delete-user-account.ts`
  // came to be `cloud` and `core` at once — the duplicate answered no question
  // and failed the dead-rule check from the far side of the cut.
  it('classifies each path once', () => {
    const seen = new Map<string, number>();
    for (const rule of OWNERSHIP_MANIFEST) {
      seen.set(rule.path, (seen.get(rule.path) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([path]) => path);
    expect(duplicated).toEqual([]);
  });

  it('carries no rule for a path that no longer exists', () => {
    const tracked = trackedFiles();
    const resolves = (rule: { path: string }) =>
      rule.path.endsWith('/')
        ? tracked.some((file) => file.startsWith(rule.path))
        : tracked.includes(rule.path);

    // A cut tree cannot resolve the rules the cut removed, so only a tree that
    // has not been cut is held to all of them. In this repository that is
    // every rule.
    const cut = cutWasPerformed(tracked);
    const dead = OWNERSHIP_MANIFEST.filter(
      (rule) => (!cut || survivesCoreCut(rule.owner)) && !resolves(rule),
    ).map((rule) => rule.path);
    expect(dead).toEqual([]);
  });
});
