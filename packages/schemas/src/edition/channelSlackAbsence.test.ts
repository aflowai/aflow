/**
 * Plan 327 D7: absent is proven, not claimed.
 *
 * The Slack channel app is an optional pack, and the platform must build and
 * pass its tests with it deleted. The manifest's own guards cannot say so:
 * `survivesCoreCut` keeps `optional-pack`, so nothing there fails when a core
 * file reaches into this app. These guards do.
 *
 * - No file outside the app imports it, by package name or by a relative path.
 * - Nothing a build reads names it, apart from what the cut's own transforms
 *   remove with it: no other workspace declares it, no project reference points
 *   at it, and the Dockerfile and root scripts lose every line that names it.
 *
 * Every check reads the working tree as git sees it, so it holds the same with
 * the app present or deleted.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pruneDockerfile, pruneScripts } from './cutTransforms.js';
import { buildImporterIndex } from './importScan.js';
import { ownerOf } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const APP_DIR = 'apps/aflow-channel-slack';
const APP_PACKAGE = '@aflow/aflow-channel-slack';

/** Tracked and new files alike, so a file not yet committed is guarded too. */
function files(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.trim() !== '' && existsSync(join(repoRoot, line)));
}

const outsideApp = files().filter((file) => !file.startsWith(`${APP_DIR}/`));
const sources = outsideApp.filter(
  (file) => /\.(?:m|c)?[jt]sx?$/.test(file) && !file.includes('/dist/'),
);
const read = (file: string): string => readFileSync(join(repoRoot, file), 'utf-8');

const RELATIVE_SPECIFIER =
  /(?:from\s*['"]|import\s*\(\s*['"]|require\s*\(\s*['"]|import\s+['"])(\.{1,2}\/[^'"]*)['"]/g;

describe('the Slack channel app is optional (Plan 327 D7)', () => {
  it('is classed optional-pack by the ownership manifest', () => {
    expect(ownerOf(`${APP_DIR}/src/index.ts`)?.owner).toBe('optional-pack');
  });

  it('is imported by no file outside it, by its package name', () => {
    const importers = buildImporterIndex(sources, read).get(APP_PACKAGE) ?? [];
    expect(importers).toEqual([]);
  });

  it('is imported by no file outside it, by a relative path', () => {
    const offending: string[] = [];
    for (const file of sources) {
      for (const match of read(file).matchAll(RELATIVE_SPECIFIER)) {
        const specifier = match[1] ?? '';
        const target = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (target === APP_DIR || target.startsWith(`${APP_DIR}/`)) {
          offending.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('is declared as a dependency by no other workspace', () => {
    const declaring = outsideApp
      .filter(
        (file) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file) || file === 'package.json',
      )
      .filter((file) => {
        const manifest = JSON.parse(read(file)) as Record<
          string,
          Record<string, string> | undefined
        >;
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
          (field) => manifest[field]?.[APP_PACKAGE] !== undefined,
        );
      });
    expect(declaring).toEqual([]);
  });

  it('is referenced by no project outside it, so `tsc -b` builds without it', () => {
    const referencing = outsideApp
      .filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/.test(file))
      .filter((file) => read(file).includes('aflow-channel-slack'));
    expect(referencing).toEqual([]);
  });

  it('leaves no Dockerfile line naming it once the cut prunes the workspace', () => {
    const { kept, mixed } = pruneDockerfile(read('Dockerfile'), [APP_DIR]);
    expect(mixed).toEqual([]);
    expect(kept).not.toContain(APP_DIR);
  });

  it('leaves no root script naming it once the cut prunes the workspace', () => {
    const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const { kept, dropped } = pruneScripts(manifest.scripts, [APP_DIR], [APP_PACKAGE]);
    expect(dropped.every((name) => name.startsWith('channel:'))).toBe(true);
    expect(JSON.stringify(kept)).not.toContain('aflow-channel-slack');
  });
});
