/**
 * Contract (Plan 320 D20): asked about a folder's UI, the machine names the
 * files a brief names, a branch or a range changes, or a run's diff holds that
 * fall under the folder's `uiPaths` — the declared ones, else the default —
 * says whether the folder declares a preview, and says why a harness run there
 * could not be given a browser: the executor serves none, the harness takes no
 * browser arguments, or the run's grant withholds it.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultFolderUiPaths, HostFolderUiAnswerSchema } from '@aflow/schemas';

import type { HostBinding } from '../bindings.js';
import {
  answerFolderUi,
  type FolderUiContext,
  inFolderFrame,
  pathsNamedIn,
  uiFilesAmong,
} from '../folderUi.js';
import type { HarnessProfile } from '../harnessProfiles.js';

const run = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repo, ...args]);
  return stdout.trim();
}

const CLAUDE = { id: 'claude', mcpArgs: ['--mcp-config', '{mcpConfig}'] } as HarnessProfile;
const CODEX = { id: 'codex', mcpArgs: [] as string[] } as HarnessProfile;

function context(over: Partial<FolderUiContext> = {}): FolderUiContext {
  return {
    servesBrowser: true,
    browserGranted: undefined,
    harness: async () => await Promise.resolve(CLAUDE),
    readDiff: async () => await Promise.resolve(undefined),
    ...over,
  };
}

const PREVIEW = { command: 'npm run dev -- --port {port}', webAppDirs: ['web'] };

describe('the paths a brief names', () => {
  it('reads paths as a person writes them, and leaves out what is no path in the folder', () => {
    expect(
      pathsNamedIn(
        'Fix `src/app/page.tsx:12`, then ./web/index.html (and web/styles.css:3-9). ' +
          'See https://example.com/a.tsx, /etc/hosts.css and ../outside.vue. Run the tests.',
      ).sort(),
    ).toEqual(['src/app/page.tsx', 'web/index.html', 'web/styles.css']);
  });

  it('matches the folder’s uiPaths, the default its extensions and web app directories', () => {
    const paths = ['src/App.vue', 'web/server.ts', 'lib/util.ts', 'README.md'];
    expect(uiFilesAmong(paths, defaultFolderUiPaths(['web']))).toEqual([
      'src/App.vue',
      'web/server.ts',
    ]);
    expect(uiFilesAmong(paths, ['lib/**'])).toEqual(['lib/util.ts']);
  });
});

describe('host.binding.inspect — the folder’s UI', () => {
  let base: string;
  let root: string;
  let start: string;
  let tip: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'folder-ui-'));
    root = join(base, 'repo');
    await mkdir(join(root, 'web'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main', root]);
    await git(root, 'config', 'user.email', 'ui@example.com');
    await git(root, 'config', 'user.name', 'UI');
    await writeFile(join(root, 'README.md'), 'a\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'start');
    start = await git(root, 'rev-parse', 'HEAD');
    // `origin`'s default branch, as a clone records it, without a remote to ask.
    await git(root, 'update-ref', 'refs/remotes/origin/main', start);
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await git(root, 'checkout', '-qb', 'feature');
    await writeFile(join(root, 'web', 'page.ts'), 'export {};\n');
    await writeFile(join(root, 'notes.txt'), 'b\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'page');
    tip = await git(root, 'rev-parse', 'HEAD');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function folder(preview?: typeof PREVIEW): HostBinding {
    return {
      id: 'hb_app',
      root,
      singleFile: false,
      ...(preview ? { preview } : {}),
    } as HostBinding;
  }

  it('names the UI files a range changes, read from where its ends meet, and one commit alone', async () => {
    const range = await answerFolderUi(folder(PREVIEW), { from: 'main', at: 'feature' }, context());
    expect(HostFolderUiAnswerSchema.parse(range)).toEqual({
      preview: 'declared',
      uiPaths: defaultFolderUiPaths(['web']),
      files: ['web/page.ts'],
      touched: true,
      browser: { harness: 'claude' },
    });
    const single = await answerFolderUi(folder(PREVIEW), { at: tip }, context());
    expect(single.files).toEqual(['web/page.ts']);
    const first = await answerFolderUi(folder(PREVIEW), { at: start }, context());
    expect(first).toMatchObject({ files: [], touched: false });
  });

  it('names what a branch changes from origin’s default branch, and nothing for that branch itself', async () => {
    const branch = await answerFolderUi(folder(PREVIEW), { branch: 'feature' }, context());
    expect(branch.files).toEqual(['web/page.ts']);
    const own = await answerFolderUi(folder(PREVIEW), { branch: 'origin/main' }, context());
    expect(own.touched).toBe(false);
  });

  it('names the UI files a brief names and a run’s diff holds', async () => {
    const brief = await answerFolderUi(
      folder(PREVIEW),
      { text: 'Change `web/page.ts` and notes.txt.' },
      context(),
    );
    expect(brief.files).toEqual(['web/page.ts']);
    const diff = await git(root, 'diff', `${start}..${tip}`);
    const patched = await answerFolderUi(
      folder(PREVIEW),
      { patchRef: 'gs://payloads/t/patch/run' },
      context({ readDiff: async () => await Promise.resolve(`${diff}\n`) }),
    );
    expect(patched.files).toEqual(['web/page.ts']);
  });

  it('reads the default uiPaths where no preview is declared, and says it is not', async () => {
    const answer = await answerFolderUi(folder(), { from: 'main', at: 'feature' }, context());
    expect(answer).toMatchObject({ preview: 'not_declared', files: [], touched: false });
    expect(answer.uiPaths).toEqual(defaultFolderUiPaths());
  });

  it('adds nothing for a source it cannot read, rather than failing', async () => {
    const answer = await answerFolderUi(
      folder(PREVIEW),
      { from: 'no-such-branch', at: 'feature', branch: 'gone', patchRef: 'gs://p/t/patch/x' },
      context(),
    );
    expect(answer).toMatchObject({ files: [], touched: false });
  });

  it('reads the paths git reports as they are for a folder at the repository’s top level', () => {
    expect(inFolderFrame('', ['web/page.ts', 'README.md'])).toEqual(['web/page.ts', 'README.md']);
    expect(
      inFolderFrame('app', ['app/src/a.tsx', 'application/b.tsx', 'lib/c.tsx', 'app']),
    ).toEqual(['src/a.tsx']);
  });

  it('says why a run could not be given a browser: the executor, the harness, then the grant', async () => {
    const ask = { from: 'main', at: 'feature' };
    const unavailable = async (over: Partial<FolderUiContext>) =>
      (await answerFolderUi(folder(PREVIEW), ask, context(over))).browser;
    expect(await unavailable({ servesBrowser: false, browserGranted: false })).toEqual({
      harness: 'claude',
      unavailable: 'executor',
    });
    expect(
      await unavailable({
        harness: async () => await Promise.resolve(CODEX),
        browserGranted: false,
      }),
    ).toEqual({ harness: 'codex', unavailable: 'harness' });
    expect(await unavailable({ harness: async () => await Promise.resolve(undefined) })).toEqual({
      unavailable: 'harness',
    });
    expect(await unavailable({ browserGranted: false })).toEqual({
      harness: 'claude',
      unavailable: 'grant',
    });
    expect(await unavailable({ browserGranted: true })).toEqual({ harness: 'claude' });
  });
});

describe('host.binding.inspect — a folder connected inside a repository', () => {
  let base: string;
  let top: string;
  let root: string;
  let start: string;
  let tip: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'folder-ui-nested-'));
    top = join(base, 'repo');
    root = join(top, 'apps', 'site');
    await mkdir(join(root, 'pages'), { recursive: true });
    await mkdir(join(top, 'lib'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main', top]);
    await git(top, 'config', 'user.email', 'ui@example.com');
    await git(top, 'config', 'user.name', 'UI');
    await writeFile(join(top, 'README.md'), 'a\n');
    await git(top, 'add', '.');
    await git(top, 'commit', '-qm', 'start');
    start = await git(top, 'rev-parse', 'HEAD');
    await git(top, 'update-ref', 'refs/remotes/origin/main', start);
    await git(top, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await git(top, 'checkout', '-qb', 'feature');
    await writeFile(join(root, 'pages', 'home.ts'), 'export {};\n');
    await writeFile(join(root, 'Card.tsx'), 'export {};\n');
    await writeFile(join(top, 'lib', 'Outside.tsx'), 'export {};\n');
    await git(top, 'add', '.');
    await git(top, 'commit', '-qm', 'pages');
    tip = await git(top, 'rev-parse', 'HEAD');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function folder(preview?: { command: string; uiPaths?: string[] }): HostBinding {
    return {
      id: 'hb_site',
      root,
      singleFile: false,
      ...(preview ? { preview } : {}),
    } as HostBinding;
  }

  const DECLARED = { command: 'npm run dev -- --port {port}', uiPaths: ['pages/**'] };

  it('matches a declared uiPath against what changed under the folder, in the folder’s frame', async () => {
    const range = await answerFolderUi(
      folder(DECLARED),
      { from: 'main', at: 'feature' },
      context(),
    );
    expect(range).toMatchObject({ files: ['pages/home.ts'], touched: true });
    const single = await answerFolderUi(folder(DECLARED), { at: tip }, context());
    expect(single.files).toEqual(['pages/home.ts']);
    const branch = await answerFolderUi(folder(DECLARED), { branch: 'feature' }, context());
    expect(branch.files).toEqual(['pages/home.ts']);
    const diff = await git(top, 'diff', `${start}..${tip}`);
    const patched = await answerFolderUi(
      folder(DECLARED),
      { patchRef: 'gs://payloads/t/patch/run' },
      context({ readDiff: async () => await Promise.resolve(`${diff}\n`) }),
    );
    expect(patched.files).toEqual(['pages/home.ts']);
  });

  it('counts no change outside the folder, though the default extensions match it', async () => {
    const range = await answerFolderUi(folder(), { from: 'main', at: 'feature' }, context());
    expect(range.files).toEqual(['Card.tsx']);
    const diff = await git(top, 'diff', `${start}..${tip}`, '--', 'lib');
    const outside = await answerFolderUi(
      folder(),
      { patchRef: 'gs://payloads/t/patch/run' },
      context({ readDiff: async () => await Promise.resolve(`${diff}\n`) }),
    );
    expect(outside).toMatchObject({ files: [], touched: false });
  });
});
