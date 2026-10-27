/**
 * Contract: a connected folder's preview (Plan 320 D18) is the person's
 * declaration, held on the machine. The file holds only what they chose — the
 * ready path and UI paths are read in when it is read — a policy written
 * before it loads unchanged, `aflow folder <id> preview` writes, prints and
 * clears it, and a port this stack serves on is refused at declaration. The
 * machine's inventory carries every connected folder's preview, pushing or
 * not, and where none is declared, whether it found a web app.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { stackOwnPorts } from '@aflow/lib';
import {
  defaultFolderUiPaths,
  FOLDER_PREVIEW_READY_PATH_DEFAULT,
  resolveFolderPreview,
} from '@aflow/schemas';

import { HostBindingSchema, HostPolicySchema, loadHostPolicy } from '../bindings.js';
import {
  answerFolderPreview,
  detectWebApps,
  parseFolderPreviewArgs,
  previewFolders,
  withFolderPreview,
} from '../folderPreview.js';
import { serializePolicy } from '../policyFile.js';
import { publishingFolders } from '../pushApproval.js';

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FOLDER_CLI = join(REPO_ROOT, 'apps/aflow-executor-host/src/folder-cli.ts');

const RUNNING = {
  id: 'hb_site',
  root: '/tmp/site',
  mode: 'readwrite',
  allowsExecution: true,
  spaceId: 'space-a',
};

const PUSHING = { ...RUNNING, id: 'hb_app', branchPolicy: { branchPrefix: 'aflow/' } };

const FILES_ONLY = {
  id: 'hb_notes',
  root: '/tmp/notes',
  mode: 'read',
  allowsExecution: false,
  spaceId: 'space-a',
};

const STACK = stackOwnPorts({});

function policyWith(bindings: unknown[]) {
  return HostPolicySchema.parse({ version: 1, bindings });
}

async function policyFile(contents: unknown): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'folder-preview-'));
  const path = join(base, 'host-policy.json');
  await writeFile(path, serializePolicy(contents));
  return path;
}

describe('a folder’s preview in the policy', () => {
  it('loads a policy written before it unchanged, with no preview', async () => {
    const path = await policyFile({ version: 1, bindings: [PUSHING, FILES_ONLY] });
    const policy = await loadHostPolicy(path);
    expect(policy.bindings.get('hb_app')?.preview).toBeUndefined();
    expect(policy.bindings.get('hb_notes')?.preview).toBeUndefined();
    expect(
      serializePolicy(HostPolicySchema.parse(JSON.parse(await readFile(path, 'utf8')))),
    ).not.toContain('preview');
  });

  it('holds only what the person chose, and reads the defaults in when it is read', () => {
    const binding = HostBindingSchema.parse({
      ...RUNNING,
      preview: { command: 'npm run dev -- --port {port}' },
    });
    expect(binding.preview).toEqual({ command: 'npm run dev -- --port {port}' });
    expect(binding.preview && resolveFolderPreview(binding.preview)).toEqual({
      command: 'npm run dev -- --port {port}',
      readyPath: FOLDER_PREVIEW_READY_PATH_DEFAULT,
      uiPaths: defaultFolderUiPaths(),
      webAppDirs: [],
    });
    expect(defaultFolderUiPaths()).toEqual([
      '**/*.tsx',
      '**/*.jsx',
      '**/*.vue',
      '**/*.svelte',
      '**/*.astro',
      '**/*.html',
      '**/*.css',
      '**/*.scss',
      '**/*.less',
    ]);
  });

  it('counts everything under a declared web app directory as UI by default, and declared uiPaths replace the default whole', () => {
    const withDirs = resolveFolderPreview({
      command: 'yarn dev --port {port}',
      webAppDirs: ['apps/web/', '.'],
    });
    expect(withDirs.uiPaths).toEqual([...defaultFolderUiPaths(), 'apps/web/**', '**']);
    expect(
      resolveFolderPreview({
        command: 'yarn dev',
        port: 4321,
        readyPath: '/health',
        uiPaths: ['src/**/*.ts'],
        webAppDirs: ['apps/web'],
      }),
    ).toEqual({
      command: 'yarn dev',
      port: 4321,
      readyPath: '/health',
      uiPaths: ['src/**/*.ts'],
      webAppDirs: ['apps/web'],
    });
  });

  it('refuses what cannot work, saying why', () => {
    const refused = (preview: unknown): string => {
      const parsed = HostBindingSchema.safeParse({ ...RUNNING, preview });
      return parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('; ');
    };
    expect(refused({ command: 'yarn dev' })).toContain('{port}');
    expect(refused({ command: 'yarn dev --port {port}', readyPath: 'health' })).toContain(
      'starts with `/`',
    );
    expect(refused({ command: 'yarn dev', port: 70_000 })).not.toBe('');
    expect(refused({ command: 'yarn dev --port {port}', webAppDirs: ['../elsewhere'] })).toContain(
      'never climbing out',
    );
    expect(refused({ command: '   ' })).not.toBe('');
  });

  it('is declared, replaced and cleared for one folder, leaving the others as they were', () => {
    const policy = policyWith([RUNNING, PUSHING]);
    const declared = withFolderPreview(
      policy,
      'hb_site',
      { command: 'yarn dev --port {port}' },
      STACK,
    );
    expect(declared.bindings.find((b) => b.id === 'hb_site')?.preview).toEqual({
      command: 'yarn dev --port {port}',
    });
    expect(declared.bindings.find((b) => b.id === 'hb_app')).toEqual(
      policy.bindings.find((b) => b.id === 'hb_app'),
    );
    const replaced = withFolderPreview(
      declared,
      'hb_site',
      { command: 'pnpm dev', port: 4321 },
      STACK,
    );
    expect(replaced.bindings.find((b) => b.id === 'hb_site')?.preview).toEqual({
      command: 'pnpm dev',
      port: 4321,
    });
    const cleared = withFolderPreview(replaced, 'hb_site', null, STACK);
    expect(cleared.bindings.find((b) => b.id === 'hb_site')).not.toHaveProperty('preview');
    expect(() => withFolderPreview(cleared, 'hb_site', null, STACK)).toThrow('declares no preview');
  });

  it('refuses a folder it does not offer, one where commands may not run, and a port this stack serves on', () => {
    const policy = policyWith([RUNNING, FILES_ONLY]);
    const preview = { command: 'yarn dev --port {port}' };
    expect(() => withFolderPreview(policy, 'hb_missing', preview, STACK)).toThrow(
      'offers no folder `hb_missing`',
    );
    expect(() => withFolderPreview(policy, 'hb_notes', preview, STACK)).toThrow(
      'a preview is a command',
    );
    for (const port of [3000, 3001, 3100, 6379, 5433]) {
      expect(() =>
        withFolderPreview(policy, 'hb_site', { command: 'yarn dev', port }, STACK),
      ).toThrow(`Port ${String(port)} is this stack's own`);
    }
    const moved = stackOwnPorts({ WEB_DEV_PORT: '4400' });
    expect(() =>
      withFolderPreview(policy, 'hb_site', { command: 'yarn dev', port: 4400 }, moved),
    ).toThrow("so no folder's preview is declared on it");
  });
});

describe('the command’s arguments', () => {
  it('prints with none, clears alone, and declares with a command, repeating --ui and --web-app', () => {
    expect(parseFolderPreviewArgs([])).toEqual({ kind: 'print' });
    expect(parseFolderPreviewArgs(['--clear'])).toEqual({ kind: 'clear' });
    expect(
      parseFolderPreviewArgs([
        '--command',
        'yarn dev --port {port}',
        '--ready',
        '/health',
        '--ui',
        'src/**/*.{ts,tsx}',
        '--ui',
        'public/**',
        '--web-app',
        'apps/web',
      ]),
    ).toEqual({
      kind: 'declare',
      requested: {
        command: 'yarn dev --port {port}',
        readyPath: '/health',
        uiPaths: ['src/**/*.{ts,tsx}', 'public/**'],
        webAppDirs: ['apps/web'],
      },
    });
    expect(parseFolderPreviewArgs(['--command', 'yarn dev', '--port', '4321'])).toEqual({
      kind: 'declare',
      requested: { command: 'yarn dev', port: 4321 },
    });
  });

  it('refuses what it cannot read', () => {
    expect(() => parseFolderPreviewArgs(['--port', '4321'])).toThrow('needs the command');
    expect(() => parseFolderPreviewArgs(['--command', 'x', '--port', 'abc'])).toThrow(
      'is not a port',
    );
    expect(() => parseFolderPreviewArgs(['--command'])).toThrow('needs a value');
    expect(() => parseFolderPreviewArgs(['--clear', '--command', 'x'])).toThrow('stands alone');
    expect(() => parseFolderPreviewArgs(['--commnd', 'x'])).toThrow('is not an option');
  });
});

describe('the machine’s inventory of previews', () => {
  async function folderWith(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'folder-webapp-'));
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    return root;
  }

  it('finds a web app at the root or one level under apps/ and packages/, and nothing in a project without one', async () => {
    const monorepo = await folderWith({
      'package.json': JSON.stringify({ devDependencies: { typescript: '5' } }),
      'apps/web/package.json': JSON.stringify({ dependencies: { next: '16' } }),
      'apps/server/package.json': JSON.stringify({ dependencies: { fastify: '5' } }),
      'packages/ui/package.json': JSON.stringify({ devDependencies: { vite: '7' } }),
      'packages/deep/nested/package.json': JSON.stringify({ dependencies: { react: '19' } }),
    });
    expect(await detectWebApps(monorepo)).toEqual(['apps/web', 'packages/ui']);
    expect(await detectWebApps(await folderWith({ 'index.html': '<!doctype html>' }))).toEqual([
      '.',
    ]);
    expect(
      await detectWebApps(
        await folderWith({ 'package.json': JSON.stringify({ dependencies: { svelte: '5' } }) }),
      ),
    ).toEqual(['.']);
    expect(
      await detectWebApps(
        await folderWith({ 'Cargo.toml': '[package]', 'package.json': '{ not json' }),
      ),
    ).toEqual([]);
  });

  it('lists every folder connected for a workspace, pushing or not, with its declaration or what was found', async () => {
    const site = await folderWith({ 'index.html': '<!doctype html>' });
    const policy = await loadHostPolicy(
      await policyFile({
        version: 1,
        bindings: [
          { ...RUNNING, root: site },
          { ...PUSHING, preview: { command: 'yarn dev --port {port}' } },
          { ...FILES_ONLY, id: 'hb_unrecorded', spaceId: undefined },
        ],
      }),
    );
    expect(await previewFolders(policy.bindings)).toEqual([
      {
        id: 'hb_app',
        spaceId: 'space-a',
        preview: { command: 'yarn dev --port {port}' },
        detectedWebApps: [],
      },
      { id: 'hb_site', spaceId: 'space-a', detectedWebApps: ['.'] },
    ]);
    // The folders that push are listed as before; the one that does not is in previews alone.
    expect(publishingFolders(policy.bindings).map((f) => f.id)).toEqual(['hb_app']);
  });
});

describe('a preview asked for from the machine page', () => {
  it('is written by the command’s writer only for the workspace the folder was connected for', async () => {
    const path = await policyFile({ version: 1, bindings: [RUNNING] });
    const request = {
      kind: 'preview' as const,
      hostname: 'laptop',
      answerId: 'a'.repeat(16),
      bindingId: 'hb_site',
      preview: { command: 'yarn dev --port {port}' },
    };
    expect(await answerFolderPreview({ ...request, spaceId: 'space-b' }, path, STACK)).toEqual({
      kind: 'refused',
      message: 'Binding `hb_site` was not connected for this workspace.',
    });
    expect(await answerFolderPreview({ ...request, spaceId: 'space-a' }, path, STACK)).toEqual({
      kind: 'changed',
      preview: { command: 'yarn dev --port {port}' },
    });
    expect(
      await answerFolderPreview(
        { ...request, spaceId: 'space-a', preview: { command: 'yarn dev', port: 3001 } },
        path,
        STACK,
      ),
    ).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining("Port 3001 is this stack's own"),
    });
    expect(
      await answerFolderPreview({ ...request, spaceId: 'space-a', preview: null }, path, STACK),
    ).toEqual({ kind: 'changed', preview: null });
  });
});

describe('aflow folder <bindingId> preview', () => {
  async function folder(
    path: string,
    ...args: string[]
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        ['--conditions=ts-source', '--import', 'tsx', FOLDER_CLI, ...args],
        { cwd: REPO_ROOT, env: { ...process.env, PHOENIX_HOST_POLICY_PATH: path } },
      );
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failed = error as { stdout: string; stderr: string; code: number };
      return { stdout: failed.stdout, stderr: failed.stderr, code: failed.code };
    }
  }

  async function written(path: string): Promise<Array<Record<string, unknown>>> {
    return (
      JSON.parse(await readFile(path, 'utf8')) as { bindings: Array<Record<string, unknown>> }
    ).bindings;
  }

  it('declares, prints and clears a folder’s preview, writing only what was chosen', async () => {
    const path = await policyFile({ version: 1, bindings: [RUNNING, PUSHING] });

    const none = await folder(path, 'hb_site', 'preview');
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('`hb_site` declares no preview');

    const declared = await folder(
      path,
      'hb_site',
      'preview',
      '--command',
      'yarn dev --port {port}',
      '--ui',
      'src/**/*.tsx',
    );
    expect(declared.code, declared.stderr).toBe(0);
    expect(declared.stdout).toContain(
      '`hb_site` is shown with `yarn dev --port {port}` on a free port',
    );
    expect((await written(path)).find((b) => b['id'] === 'hb_site')?.['preview']).toEqual({
      command: 'yarn dev --port {port}',
      uiPaths: ['src/**/*.tsx'],
    });
    expect((await written(path)).find((b) => b['id'] === 'hb_app')).not.toHaveProperty('preview');

    const printed = await folder(path, 'hb_site', 'preview');
    expect(printed.stdout).toContain('readyPath  / (default)');
    expect(printed.stdout).toContain('src/**/*.tsx');

    const cleared = await folder(path, 'hb_site', 'preview', '--clear');
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain('`hb_site` declares no preview now');
    expect((await written(path)).find((b) => b['id'] === 'hb_site')).not.toHaveProperty('preview');
  }, 60_000);

  it('refuses a port this stack serves on, and writes nothing', async () => {
    const path = await policyFile({ version: 1, bindings: [RUNNING] });
    const before = await readFile(path, 'utf8');
    const refused = await folder(
      path,
      'hb_site',
      'preview',
      '--command',
      'yarn dev',
      '--port',
      '3001',
    );
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("Port 3001 is this stack's own");
    expect(refused.stderr).toContain("so no folder's preview is declared on it");
    expect(await readFile(path, 'utf8')).toBe(before);
  }, 60_000);

  it('says how it is used when the folder or the verb is missing', async () => {
    const path = await policyFile({ version: 1, bindings: [RUNNING] });
    const bare = await folder(path);
    expect(bare.code).not.toBe(0);
    expect(bare.stderr).toContain('folder <id> preview');
    const unknown = await folder(
      path,
      'hb_missing',
      'preview',
      '--command',
      'yarn dev --port {port}',
    );
    expect(unknown.stderr).toContain('offers no folder `hb_missing`');
  }, 60_000);
});
