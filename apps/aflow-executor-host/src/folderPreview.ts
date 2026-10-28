/**
 * How a connected folder is shown working (Plan 320 D18): its preview
 * declaration, written by a person on the machine (`aflow folder <id> preview`)
 * or from the machine page, whose route relays it here. No operation sets it.
 *
 * The file holds the declaration as the person wrote it; the defaults —
 * readyPath, uiPaths — are read in by `resolveFolderPreview` each time, so a
 * change of default reaches every folder that never chose. This only writes
 * the declaration: nothing here starts the preview, which is the executor's
 * job per run, and its confinement is not settled yet (Plan 320 F49).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { z } from 'zod';

import { describeStackPortOwner, type StackPortOwner, stackOwnPorts } from '@aflow/lib';
import {
  FOLDER_WEB_APP_DEPENDENCIES,
  folderPreviewStackPortRefusal,
  type HostFolderPreview,
  HostFolderPreviewSchema,
  resolveFolderPreview,
} from '@aflow/schemas';
import type { HostFolderAnswer, HostFolderRequest, HostInventoryPreviews } from '@aflow/redis';

import { type HostBinding, HostPolicySchema, requireSpace } from './bindings.js';
import { editPolicy } from './policyFile.js';
import { describePolicyIssues } from './policyIssues.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;
export type FolderPreviewRequested = z.input<typeof HostFolderPreviewSchema>;
type StackOwn = ReadonlyMap<number, StackPortOwner>;

const EMPTY_POLICY = { version: 1, bindings: [], harnesses: [] };

/** Why a port is refused for a preview, or nothing when this stack does not serve on it. */
export function previewStackPortRefusal(port: number, stackOwn: StackOwn): string | undefined {
  const owner = stackOwn.get(port);
  return owner === undefined
    ? undefined
    : folderPreviewStackPortRefusal(port, describeStackPortOwner(owner));
}

function parsePreview(bindingId: string, requested: FolderPreviewRequested): HostFolderPreview {
  const parsed = HostFolderPreviewSchema.safeParse(requested);
  if (!parsed.success) {
    throw new Error(
      `That is not a preview \`${bindingId}\` can declare: ${describePolicyIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * The policy with one folder's preview declared, or cleared with `null`.
 * Refused for a folder this machine does not offer, for a single file, for a
 * folder where commands may not run — a preview is a command — and for a port
 * this stack serves on.
 */
export function withFolderPreview(
  policy: HostPolicy,
  bindingId: string,
  requested: FolderPreviewRequested | null,
  stackOwn: StackOwn = stackOwnPorts(process.env),
): HostPolicy {
  const binding = policy.bindings.find((b) => b.id === bindingId);
  if (binding === undefined) {
    throw new Error(`This machine offers no folder \`${bindingId}\`.`);
  }
  if (requested === null) {
    if (binding.preview === undefined) {
      throw new Error(`\`${bindingId}\` declares no preview, so there is none to clear.`);
    }
    return {
      ...policy,
      bindings: policy.bindings.map((b) => {
        if (b.id !== bindingId) return b;
        const { preview: _cleared, ...rest } = b;
        return rest;
      }),
    };
  }
  if (binding.singleFile) {
    throw new Error(`\`${bindingId}\` is a single file, so there is no project in it to serve.`);
  }
  if (!binding.allowsExecution) {
    throw new Error(
      `\`${bindingId}\` does not allow commands, and a preview is a command. Reconnect it with ` +
        '`--run` to let commands run there.',
    );
  }
  const preview = parsePreview(bindingId, requested);
  if (preview.port !== undefined) {
    const refusal = previewStackPortRefusal(preview.port, stackOwn);
    if (refusal !== undefined) throw new Error(refusal);
  }
  return {
    ...policy,
    bindings: policy.bindings.map((b) => (b.id === bindingId ? { ...b, preview } : b)),
  };
}

/** One line saying how the folder is shown, in the words the command prints. */
export function describeFolderPreview(preview: HostFolderPreview | undefined): string {
  if (preview === undefined) return 'declares no preview';
  const resolved = resolveFolderPreview(preview);
  const port = resolved.port === undefined ? 'a free port' : `port ${String(resolved.port)}`;
  const ui = preview.uiPaths === undefined ? 'the default UI files' : 'the UI files it names';
  return `is shown with \`${resolved.command}\` on ${port}, ready at ${resolved.readyPath}, its UI ${ui}`;
}

/** The declaration in full, one fact per line, defaults marked. */
export function folderPreviewLines(bindingId: string, preview: HostFolderPreview): string[] {
  const resolved = resolveFolderPreview(preview);
  const chosen = (given: unknown): string => (given === undefined ? ' (default)' : '');
  return [
    `\`${bindingId}\` ${describeFolderPreview(preview)}.`,
    `  command    ${resolved.command}`,
    `  port       ${resolved.port === undefined ? 'a free port, passed as {port}' : String(resolved.port)}`,
    `  readyPath  ${resolved.readyPath}${chosen(preview.readyPath)}`,
    `  uiPaths${chosen(preview.uiPaths)}`,
    ...resolved.uiPaths.map((glob) => `    ${glob}`),
    ...(resolved.webAppDirs.length > 0
      ? ['  webAppDirs', ...resolved.webAppDirs.map((dir) => `    ${dir}`)]
      : []),
  ];
}

/**
 * Reads, changes and writes the policy under its lock: the one writer the
 * command and the executor share. Given a workspace, the folder must have been
 * connected for it — an admin of one workspace does not reach another's folder
 * by naming its id. Asked from a workspace, a folder the machine does not
 * offer is refused in the same words as another workspace's, so the answer
 * does not say which ids exist here.
 */
export async function changeFolderPreview(
  policyPath: string,
  bindingId: string,
  requested: FolderPreviewRequested | null,
  options: { readonly stackOwn?: StackOwn; readonly spaceId?: string } = {},
): Promise<HostFolderPreview | undefined> {
  const updated = await editPolicy(policyPath, (current) => {
    const policy = HostPolicySchema.parse(current ?? EMPTY_POLICY);
    if (options.spaceId !== undefined) {
      const notConnected = `Binding \`${bindingId}\` was not connected for this workspace.`;
      const binding = policy.bindings.find((b) => b.id === bindingId);
      if (binding === undefined) throw new Error(notConnected);
      try {
        requireSpace(binding, options.spaceId);
      } catch {
        throw new Error(notConnected);
      }
    }
    return withFolderPreview(policy, bindingId, requested, options.stackOwn);
  });
  return updated.bindings.find((b) => b.id === bindingId)?.preview;
}

export type FolderPreviewVerb =
  | { readonly kind: 'print' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'declare'; readonly requested: FolderPreviewRequested };

const VALUE_FLAGS = new Set(['--command', '--port', '--ready', '--ui', '--web-app']);

/**
 * `aflow folder <id> preview` and its flags: nothing prints the declaration,
 * `--clear` removes it, and `--command` with the rest declares one, replacing
 * whatever was declared before. `--ui` and `--web-app` repeat, one glob or
 * directory each, since a glob can hold a comma.
 */
export function parseFolderPreviewArgs(args: readonly string[]): FolderPreviewVerb {
  if (args.length === 0) return { kind: 'print' };
  if (args.includes('--clear')) {
    if (args.length > 1) throw new Error('`--clear` stands alone: it removes the whole preview.');
    return { kind: 'clear' };
  }
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(
        `\`${flag}\` is not an option of \`preview\`. It takes --command, --port, --ready, ` +
          '--ui, --web-app, or --clear alone.',
      );
    }
    const value = args[index + 1];
    if (value === undefined || VALUE_FLAGS.has(value) || value === '--clear') {
      throw new Error(`\`${flag}\` needs a value after it.`);
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
    index += 1;
  }
  const single = (flag: string): string | undefined => {
    const given = values.get(flag);
    if (given !== undefined && given.length > 1) throw new Error(`\`${flag}\` is given once.`);
    return given?.[0];
  };
  const command = single('--command');
  if (command === undefined) {
    throw new Error(
      'A preview needs the command that serves the folder: --command "<command>", with ' +
        '{port} where its port goes. Each declaration replaces the one before.',
    );
  }
  const port = single('--port');
  if (port !== undefined && !/^\d{1,5}$/.test(port.trim())) {
    throw new Error(`'${port}' is not a port: give a whole number from 1 to 65535.`);
  }
  const ready = single('--ready');
  const ui = values.get('--ui');
  const webApps = values.get('--web-app');
  return {
    kind: 'declare',
    requested: {
      command,
      ...(port !== undefined ? { port: Number(port.trim()) } : {}),
      ...(ready !== undefined ? { readyPath: ready } : {}),
      ...(ui !== undefined ? { uiPaths: ui } : {}),
      ...(webApps !== undefined ? { webAppDirs: webApps } : {}),
    },
  };
}

// ----------------------------------------------------------------------------
// Whether a folder with no preview has a web app, for the machine page alone.
// ----------------------------------------------------------------------------

/** Where a web app's `package.json` is looked for below the root: one level, under these. */
const WORKSPACE_PARENTS = ['apps', 'packages'] as const;
/** Bounds the reads one folder costs each time the inventory is published. */
const MAX_WORKSPACES_READ = 100;
const MAX_MANIFEST_BYTES = 512 * 1024;

async function dependsOnWebFramework(manifestPath: string): Promise<boolean> {
  const text = await readFile(manifestPath, 'utf8').catch(() => undefined);
  if (text === undefined || text.length > MAX_MANIFEST_BYTES) return false;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof manifest !== 'object' || manifest === null) return false;
  const record = manifest as Record<string, unknown>;
  return ['dependencies', 'devDependencies'].some((field) => {
    const deps = record[field];
    return (
      typeof deps === 'object' &&
      deps !== null &&
      FOLDER_WEB_APP_DEPENDENCIES.some((name) => Object.hasOwn(deps, name))
    );
  });
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path)
    .then((found) => found.isFile())
    .catch(() => false);
}

/**
 * The directories of a folder that hold a web app, relative to its root (`.`
 * for the root): a `package.json` depending on a known web framework, at the
 * root or one level under `apps/` or `packages/`, or an `index.html` at the
 * root. Conservative on purpose: it decides only whether the machine page says
 * the preview is not declared, and nothing is run or defaulted from it.
 */
export async function detectWebApps(root: string): Promise<string[]> {
  const found: string[] = [];
  if (
    (await dependsOnWebFramework(join(root, 'package.json'))) ||
    (await isFile(join(root, 'index.html')))
  ) {
    found.push('.');
  }
  let read = 0;
  for (const parent of WORKSPACE_PARENTS) {
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || read >= MAX_WORKSPACES_READ) continue;
      read += 1;
      if (await dependsOnWebFramework(join(root, parent, entry.name, 'package.json'))) {
        found.push(`${parent}/${entry.name}`);
      }
    }
  }
  return found;
}

/**
 * What the machine's inventory says about every folder connected for a
 * workspace, pushing or not: its preview as declared, or where it found a web
 * app when none is. Looked for only where no preview is declared, the one case
 * the page reads it for.
 */
export async function previewFolders(
  bindings: ReadonlyMap<string, HostBinding>,
  detect: (root: string) => Promise<string[]> = detectWebApps,
): Promise<HostInventoryPreviews> {
  const listed = await Promise.all(
    [...bindings.values()].map(async (binding): Promise<HostInventoryPreviews> => {
      if (binding.spaceId === undefined) return [];
      if (binding.preview !== undefined) {
        return [
          {
            id: binding.id,
            spaceId: binding.spaceId,
            preview: binding.preview,
            detectedWebApps: [],
          },
        ];
      }
      const detectedWebApps = binding.singleFile ? [] : await detect(binding.root).catch(() => []);
      return [{ id: binding.id, spaceId: binding.spaceId, detectedWebApps }];
    }),
  );
  return listed.flat().sort((a, b) => a.id.localeCompare(b.id));
}

// ----------------------------------------------------------------------------
// The machine page's change, applied here by the command's own writer.
// ----------------------------------------------------------------------------

export async function answerFolderPreview(
  request: HostFolderRequest,
  policyPath: string,
  stackOwn: StackOwn,
): Promise<HostFolderAnswer> {
  try {
    const preview = await changeFolderPreview(policyPath, request.bindingId, request.preview, {
      stackOwn,
      spaceId: request.spaceId,
    });
    return { kind: 'changed', preview: preview ?? null };
  } catch (error) {
    return { kind: 'refused', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Each change waits for the one before it, since each reads and rewrites the whole file. */
export function folderPreviewsInTurn(
  policyPath: string,
  stackOwn: StackOwn,
): (request: HostFolderRequest) => Promise<HostFolderAnswer> {
  let last: Promise<unknown> = Promise.resolve();
  return (request) => {
    const answer = last.then(async () => await answerFolderPreview(request, policyPath, stackOwn));
    last = answer.catch(() => undefined);
    return answer;
  };
}
