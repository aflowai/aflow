/**
 * `aflow folder <bindingId> <command>` — what the machine says about one
 * connected folder that is not about pushing. Today that is its preview (Plan
 * 320 D18): how the folder is shown working. This writes the declaration and
 * nothing else; no server is started here.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { HostPolicySchema } from './bindings.js';
import {
  changeFolderPreview,
  describeFolderPreview,
  folderPreviewLines,
  parseFolderPreviewArgs,
} from './folderPreview.js';
import { resolveHostPolicyPath } from './hostDir.js';

const POLICY_PATH = resolveHostPolicyPath();

const USAGE =
  'Usage:\n' +
  '  folder <id> preview                 How the folder is shown working, as declared.\n' +
  '  folder <id> preview --command "<command>" [--port <port>] [--ready <path>]\n' +
  '                      [--ui <glob>]... [--web-app <dir>]...\n' +
  '                                      Declare it: the command that serves the folder,\n' +
  '                                      run from the checkout, with {port} where its port\n' +
  '                                      goes; a fixed port, else each run takes a free one;\n' +
  '                                      the path that answers once it is up (default /);\n' +
  '                                      the files that are its UI (default: tsx jsx vue\n' +
  '                                      svelte astro html css scss less, and everything\n' +
  '                                      under each --web-app directory). Replaces what was\n' +
  '                                      declared before.\n' +
  '  folder <id> preview --clear         Declare none.\n\n' +
  'A port this stack serves on is refused. Nothing is started by this command.';

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

async function printPreview(bindingId: string): Promise<void> {
  const raw = await readFile(POLICY_PATH, 'utf8').catch(() => undefined);
  const policy = raw === undefined ? undefined : HostPolicySchema.parse(JSON.parse(raw));
  const binding = policy?.bindings.find((b) => b.id === bindingId);
  if (binding === undefined) {
    console.error(`This machine offers no folder \`${bindingId}\`.`);
    process.exit(1);
  }
  if (binding.preview === undefined) {
    console.log(
      `\`${bindingId}\` ${describeFolderPreview(undefined)}. Declare one with:\n` +
        `  aflow folder ${bindingId} preview --command "<command> --port {port}"`,
    );
    return;
  }
  for (const line of folderPreviewLines(bindingId, binding.preview)) console.log(line);
}

async function preview(bindingId: string, args: readonly string[]): Promise<void> {
  const verb = parseFolderPreviewArgs(args);
  if (verb.kind === 'print') {
    await printPreview(bindingId);
    return;
  }
  await mkdir(dirname(POLICY_PATH), { recursive: true, mode: 0o700 });
  const declared = await changeFolderPreview(
    POLICY_PATH,
    bindingId,
    verb.kind === 'clear' ? null : verb.requested,
  );
  if (declared === undefined) {
    console.log(`\`${bindingId}\` ${describeFolderPreview(undefined)} now.`);
    return;
  }
  for (const line of folderPreviewLines(bindingId, declared)) console.log(line);
}

async function main(): Promise<void> {
  const [, , bindingId, command, ...rest] = process.argv;
  if (bindingId === undefined || bindingId.startsWith('-')) usage();
  if (command === 'preview') {
    await preview(bindingId, rest);
    return;
  }
  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
