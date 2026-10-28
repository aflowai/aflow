/**
 * How a connected folder is shown working (Plan 320 D18): the preview a
 * person declares for it, beside the branch policy and sandbox posture on the
 * host binding, read by the executor, the server's route and the machine page.
 * Generic on purpose — a folder may be any project, so nothing here names
 * this repository.
 */
import { z } from 'zod';

import { EPHEMERAL_BROWSER_PROFILE } from './browserProfile.js';

/** Where a preview command takes the port it serves on. */
export const FOLDER_PREVIEW_PORT_PLACEHOLDER = '{port}';
/** The path a preview is waited on when the folder names none. */
export const FOLDER_PREVIEW_READY_PATH_DEFAULT = '/';
/**
 * A path on the preview's own origin: one leading `/` not followed by another
 * (a protocol-relative `//host` resolves to another host), and no backslash
 * (which a URL parser reads as `/`), whitespace or control character.
 */
// eslint-disable-next-line no-control-regex -- the control range is what is refused
export const FOLDER_PREVIEW_READY_PATH_PATTERN = /^\/(?![/\\])[^\\\s\u0000-\u001f\u007f]*$/;
/** The file extensions a folder's UI is made of when it names no `uiPaths` of its own. */
export const FOLDER_PREVIEW_UI_EXTENSIONS = [
  'tsx',
  'jsx',
  'vue',
  'svelte',
  'astro',
  'html',
  'css',
  'scss',
  'less',
] as const;
export const FOLDER_PREVIEW_COMMAND_MAX_LENGTH = 4096;
export const FOLDER_PREVIEW_PATH_MAX_LENGTH = 1024;
export const FOLDER_PREVIEW_MAX_GLOBS = 256;
export const FOLDER_PREVIEW_MAX_WEB_APP_DIRS = 64;

/**
 * The dependencies that make a `package.json` a web app's when the machine
 * looks for one in a folder with no preview declared. Detection decides only
 * whether the machine page says "preview not declared"; nothing runs, and no
 * default is taken from it.
 */
export const FOLDER_WEB_APP_DEPENDENCIES = [
  'next',
  'vite',
  'svelte',
  '@sveltejs/kit',
  'astro',
  'vue',
  'nuxt',
  'react',
  'react-dom',
  '@angular/core',
] as const;

function isInsideFolder(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment !== '..' && segment !== '.git')
  );
}

const FolderRelativeDirSchema = z
  .string()
  .min(1)
  .max(FOLDER_PREVIEW_PATH_MAX_LENGTH)
  .refine(isInsideFolder, {
    message:
      'A web app directory is a path inside the folder, relative to its root — `apps/web` or `.` for the root itself — never absolute, never climbing out with `..`, never inside `.git`.',
  });

const FolderRelativeGlobSchema = z
  .string()
  .min(1)
  .max(FOLDER_PREVIEW_PATH_MAX_LENGTH)
  .refine(isInsideFolder, {
    message:
      'A UI glob names files inside the folder, relative to its root — `src/**/*.tsx` — never absolute, never climbing out with `..`, never inside `.git`.',
  });

/**
 * How a connected folder is shown working (Plan 320 D18). Generic on purpose:
 * a folder may be any project, so nothing here names this repository. The
 * policy file holds only what the person chose; `resolveFolderPreview` reads
 * the defaults in each time.
 */
export const HostFolderPreviewSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1)
      .max(FOLDER_PREVIEW_COMMAND_MAX_LENGTH)
      .describe(
        "The command that serves the folder's project, run from the root of a run's checkout — " +
          '`yarn dev --port {port}`, `npm run dev -- --port {port}`, whatever the project runs. ' +
          '`{port}` is replaced by the port it is to listen on.',
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .optional()
      .describe(
        'A fixed loopback port, for a project that cannot be told one. A fixed port serves one ' +
          'run at a time. Absent, each run takes a free port and passes it as `{port}`. Never ' +
          "one of this stack's own ports.",
      ),
    readyPath: z
      .string()
      .min(1)
      .max(FOLDER_PREVIEW_PATH_MAX_LENGTH)
      .regex(FOLDER_PREVIEW_READY_PATH_PATTERN, {
        message:
          'A ready path is a path on the preview itself — `/` or `/health` — starting with one ' +
          '`/`, with no second `/` straight after it, no backslash, no whitespace and no ' +
          'control character: `//host/…` or `/\\host` would name another host.',
      })
      .optional()
      .describe(
        `The path that answers once the preview is up. Absent, \`${FOLDER_PREVIEW_READY_PATH_DEFAULT}\`.`,
      ),
    uiPaths: z
      .array(FolderRelativeGlobSchema)
      .min(1)
      .max(FOLDER_PREVIEW_MAX_GLOBS)
      .optional()
      .describe(
        "Globs, relative to the folder's root, naming the files that make up its UI: a change " +
          'touching one is a UI change. Absent, every file whose extension is one of ' +
          `${FOLDER_PREVIEW_UI_EXTENSIONS.join(' ')}, and everything under each of \`webAppDirs\`. ` +
          'Given, these replace the default whole.',
      ),
    webAppDirs: z
      .array(FolderRelativeDirSchema)
      .min(1)
      .max(FOLDER_PREVIEW_MAX_WEB_APP_DIRS)
      .optional()
      .describe(
        "The folder's web app directories, declared by the person: everything under one counts " +
          'as UI in the default `uiPaths`. Absent, only the extensions do. The machine never ' +
          'infers them; in a folder with no preview it only looks for a web app — a ' +
          '`package.json` at the root or one level under `apps/` or `packages/` depending on ' +
          `one of ${FOLDER_WEB_APP_DEPENDENCIES.join(', ')}, or an \`index.html\` at the root — ` +
          'to say on the machine page that the preview is not declared.',
      ),
  })
  .superRefine((preview, context) => {
    if (preview.port === undefined && !preview.command.includes(FOLDER_PREVIEW_PORT_PLACEHOLDER)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message:
          `Without a fixed port the command must say where the port goes, as \`${FOLDER_PREVIEW_PORT_PLACEHOLDER}\`: ` +
          'each run takes a free port, and a command that is never told it serves somewhere ' +
          'the run cannot find. Add `--port {port}` (or however the project takes one), or ' +
          'fix the port.',
      });
    }
  })
  .describe(
    'How the folder is shown working: the command that serves it, the port, the path that ' +
      'answers once it is up, and the files that count as its UI. Set by a person, on the ' +
      'machine with `aflow folder <bindingId> preview` or on the machine page; no operation ' +
      'sets it.',
  );
export type HostFolderPreview = z.infer<typeof HostFolderPreviewSchema>;

/** The preview as a run reads it: what the person chose, with every default read in now. */
export interface HostResolvedFolderPreview {
  readonly command: string;
  /** Absent: each run takes a free port. */
  readonly port?: number;
  readonly readyPath: string;
  readonly uiPaths: readonly string[];
  readonly webAppDirs: readonly string[];
}

/** The `uiPaths` a folder declaring none takes: the UI extensions, and everything under its web app directories. */
export function defaultFolderUiPaths(webAppDirs: readonly string[] = []): string[] {
  return [
    ...FOLDER_PREVIEW_UI_EXTENSIONS.map((extension) => `**/*.${extension}`),
    ...webAppDirs.map((dir) => {
      const trimmed = dir.replace(/\/+$/, '');
      return trimmed === '.' || trimmed === '' ? '**' : `${trimmed}/**`;
    }),
  ];
}

/** How long the executor waits for a run's preview to answer on its ready path (Plan 320 D19). */
export const FOLDER_PREVIEW_READY_TIMEOUT_MS = 120_000;

/** `host.harness.run`'s `preview`: the boolean that asks for the folder's declared preview, never a declaration. */
export const HostHarnessPreviewFlagSchema = z
  .boolean()
  .optional()
  .describe(
    "`true` starts the connected folder's declared preview from this run's own checkout before " +
      'the harness starts — the executor runs it, waits for it to answer and stops it when the ' +
      "run ends — and opens its port to this run's `ephemeral` browser alone; the harness is " +
      'handed its address as `previewUrl` in the inputs. Needs `browser` with the `ephemeral` ' +
      'profile. Refused before any checkout where the folder declares no preview, and where its ' +
      'fixed port is held by another run or anything else. The harness never starts a server.',
  );

/** What a run asking for a preview is refused for at once, or nothing when it may ask. */
export function harnessPreviewRequestIssue(input: {
  readonly preview?: boolean | undefined;
  readonly browser?: { readonly profile: string } | undefined;
}): string | undefined {
  if (input.preview !== true) return undefined;
  if (input.browser === undefined) {
    return (
      '`preview: true` is given without `browser`. The preview is opened only in the run’s ' +
      'own browser: add `browser: { profile: "ephemeral" }`, or drop `preview`.'
    );
  }
  if (input.browser.profile !== EPHEMERAL_BROWSER_PROFILE) {
    return (
      `\`preview: true\` is given with the \`${input.browser.profile}\` profile. The preview's ` +
      'port is opened to the run’s `ephemeral` browser alone, never to a profile the machine ' +
      'declares: use `browser: { profile: "ephemeral" }`.'
    );
  }
  return undefined;
}

export function resolveFolderPreview(preview: HostFolderPreview): HostResolvedFolderPreview {
  const webAppDirs = preview.webAppDirs ?? [];
  return {
    command: preview.command,
    ...(preview.port !== undefined ? { port: preview.port } : {}),
    readyPath: preview.readyPath ?? FOLDER_PREVIEW_READY_PATH_DEFAULT,
    uiPaths: preview.uiPaths ?? defaultFolderUiPaths(webAppDirs),
    webAppDirs,
  };
}
