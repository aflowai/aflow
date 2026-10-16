import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  distClosure,
  distStaleness,
  isNextApplication,
  readWorkspaces,
  selectDistRebuilds,
} from './webDists.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = readWorkspaces(REPO_ROOT);
const NEXT_APPLICATIONS = [...WORKSPACES.values()]
  .filter(isNextApplication)
  .map(({ name }) => name);

const BUILT_AT = 1_000_000;
const TOUCHED_AT = BUILT_AT + 60_000;
const UNTOUCHED_AT = BUILT_AT - 60_000;

/**
 * The repository as it stands, every package built at one instant and one file
 * edited after it — a merge, as far as modification times can tell.
 */
function afterTouching(file) {
  const touched = join(REPO_ROOT, file);
  return {
    builtMtime: () => BUILT_AT,
    sourceMtime: (dir) => (touched.startsWith(`${dir}/`) ? TOUCHED_AT : UNTOUCHED_AT),
  };
}

const selected = (selection) => selection.rebuild.map(({ name }) => name);

describe('what a start rebuilds for the web application', () => {
  it('derives the packages it reads from its manifests, and none it does not', () => {
    expect(NEXT_APPLICATIONS).toContain('@aflow/web-local');
    const closure = distClosure(WORKSPACES, NEXT_APPLICATIONS);
    expect(closure).toEqual(
      expect.arrayContaining([
        '@aflow/web-product',
        '@aflow/design-system',
        '@aflow/schemas',
        '@aflow/run-view',
      ]),
    );
    expect(closure).not.toContain('@aflow/database');
    expect(closure).not.toContain('@aflow/aflow-orchestrator');
    expect(closure.indexOf('@aflow/schemas')).toBeLessThan(closure.indexOf('@aflow/run-view'));
    expect(closure.indexOf('@aflow/run-view')).toBeLessThan(closure.indexOf('@aflow/web-product'));
  });

  it('selects schemas when a file in its source is newer than its build', () => {
    const selection = selectDistRebuilds({
      workspaces: WORKSPACES,
      consumers: NEXT_APPLICATIONS,
      measure: afterTouching('packages/schemas/src/index.ts'),
    });
    expect(selected(selection)).toEqual(['@aflow/schemas']);
    expect(selection.rebuild[0]?.reason).toBe('src/ is 60s newer than dist/');
  });

  it('selects nothing for the web when an orchestrator file changed', () => {
    const selection = selectDistRebuilds({
      workspaces: WORKSPACES,
      consumers: NEXT_APPLICATIONS,
      measure: afterTouching('apps/aflow-orchestrator/src/index.ts'),
    });
    expect(selection).toEqual({ rebuild: [], watchedStale: [] });
  });

  it('selects nothing when every package is current', () => {
    const selection = selectDistRebuilds({
      workspaces: WORKSPACES,
      consumers: NEXT_APPLICATIONS,
      measure: { builtMtime: () => BUILT_AT, sourceMtime: () => UNTOUCHED_AT },
    });
    expect(selection).toEqual({ rebuild: [], watchedStale: [] });
  });

  it('leaves a package the start runs a watcher for to that watcher', () => {
    const selection = selectDistRebuilds({
      workspaces: WORKSPACES,
      consumers: NEXT_APPLICATIONS,
      watched: ['@aflow/web-product'],
      measure: afterTouching('packages/web-product/src/index.ts'),
    });
    expect(selection.rebuild).toEqual([]);
    expect(selection.watchedStale.map(({ name }) => name)).toEqual(['@aflow/web-product']);
  });

  it('selects every package in it on a fresh clone, dependencies first', () => {
    const selection = selectDistRebuilds({
      workspaces: WORKSPACES,
      consumers: NEXT_APPLICATIONS,
      measure: { builtMtime: () => undefined, sourceMtime: () => UNTOUCHED_AT },
    });
    expect(selected(selection)).toEqual(distClosure(WORKSPACES, NEXT_APPLICATIONS));
    expect(selection.rebuild[0]?.reason).toBe('dist/ is missing');
  });
});

describe('a build measured on disk', () => {
  let scratch;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  function packageAt({ source, test = source, script, declaration }) {
    scratch = mkdtempSync(join(tmpdir(), 'web-dists-'));
    const files = {
      'src/index.ts': source,
      'src/index.test.ts': test,
      'dist/index.js': script,
      'dist/index.d.ts': declaration,
    };
    for (const [file, seconds] of Object.entries(files)) {
      const path = join(scratch, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
      utimesSync(path, seconds, seconds);
    }
    return {
      name: '@aflow/example',
      dir: scratch,
      manifest: {
        name: '@aflow/example',
        scripts: { build: 'tsup' },
        exports: { '.': { 'ts-source': './src/index.ts', import: './dist/index.js' } },
      },
    };
  }

  it('is stale when only a type-check has written dist/ since the source changed', () => {
    const workspace = packageAt({ source: 2_000, script: 1_000, declaration: 3_000 });
    expect(distStaleness(workspace)).toBe('src/ is 1000s newer than dist/');
  });

  it('is current when the JavaScript it serves is newer than its source, tests aside', () => {
    const workspace = packageAt({ source: 1_000, test: 3_000, script: 2_000, declaration: 2_000 });
    expect(distStaleness(workspace)).toBeNull();
  });
});
