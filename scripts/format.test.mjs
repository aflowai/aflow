/**
 * `yarn format` (`scripts/format.sh`): the paths Prettier rewrote on stdout,
 * their count on stderr, and nothing written outside the checkout — a coding
 * agent's sandbox may refuse the temporary directory, so the script needs none.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'format.sh');

let scratch;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/**
 * Runs a copy of the script in a checkout of its own, where `yarn` is a stub
 * printing `rewritten` and exiting `exitCode`, and `TMPDIR` names a directory
 * that does not exist, so a script reaching for a temporary file fails.
 *
 * @param {{ rewritten: string[], exitCode: number }} stub
 */
function format({ rewritten, exitCode }) {
  scratch = mkdtempSync(join(tmpdir(), 'format-sh-'));
  const checkout = join(scratch, 'checkout');
  const bin = join(scratch, 'bin');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(SCRIPT, join(checkout, 'scripts', 'format.sh'));
  const lines = rewritten.map((path) => `echo '${path}'`).join('\n');
  writeFileSync(join(bin, 'yarn'), `#!/bin/sh\n${lines}\nexit ${String(exitCode)}\n`);
  chmodSync(join(bin, 'yarn'), 0o755);
  return spawnSync('bash', [join(checkout, 'scripts', 'format.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      TMPDIR: join(scratch, 'no-such-directory'),
    },
  });
}

describe('yarn format', () => {
  it('prints each path Prettier rewrote, then their count, with no temporary directory', () => {
    const run = format({ rewritten: ['apps/a.ts', 'packages/b.ts'], exitCode: 0 });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('apps/a.ts\npackages/b.ts\n');
    expect(run.stderr).toContain('Prettier: 2 file(s) reformatted.');
  });

  it('counts none when Prettier rewrote nothing', () => {
    const run = format({ rewritten: [], exitCode: 0 });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Prettier: 0 file(s) reformatted.');
  });

  it('fails as Prettier did, and claims no count', () => {
    const run = format({ rewritten: ['apps/a.ts'], exitCode: 2 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).not.toContain('file(s) reformatted');
  });

  // The stub run above cannot show the second: only a sandbox refuses `/dev/fd/N`.
  it('opens neither a temporary file nor a descriptor by path', () => {
    const commands = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    expect(commands.filter((line) => /\bmktemp\b|\/dev\/(fd|stdout|stderr)/.test(line))).toEqual(
      [],
    );
  });
});
