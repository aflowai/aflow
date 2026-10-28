/**
 * How a connected folder is shown working (Plan 320 D18): the preview a
 * person declares for it, beside the branch policy and sandbox posture on the
 * host binding, read by the executor, the server's route and the machine page.
 * Generic on purpose — a folder may be any project, so nothing here names
 * this repository.
 */
import { z } from 'zod';

/** Where a preview command takes the port it serves on. */
export const FOLDER_PREVIEW_PORT_PLACEHOLDER = '{port}';
/** The path a preview is waited on when the folder names none. */
export const FOLDER_PREVIEW_READY_PATH_DEFAULT = '/';
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
      .startsWith('/', { message: 'A ready path starts with `/`, as `/` or `/health` does.' })
      .optional()
      .describe(
        'The path that answers once the preview is up. Absent, `FOLDER_PREVIEW_READY_PATH_DEFAULT`.',
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
