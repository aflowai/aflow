/**
 * How a connected folder is shown working (Plan 320 D18): the preview a
 * person declares for it, beside the branch policy and sandbox posture on the
 * host binding, read by the executor, the server's route and the machine page.
 * Generic on purpose — a folder may be any project, so nothing here names
 * this repository.
 */
import { z } from 'zod';

import { PayloadRefSchema } from '../runtime/payloadRef.js';
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
    "`true` starts the connected folder's declared preview before the harness starts — the " +
      'executor runs it, waits for it to answer and stops it when the run ends — and opens its ' +
      "port to this run's `ephemeral` browser alone; the harness is handed its address as " +
      '`previewUrl` in the inputs. It serves the commit the run started from, copied before ' +
      'the harness starts: for a commission its base, the app before the change; for a review ' +
      'the committed range. No agent sees its own uncommitted edits through it. It runs ' +
      "unconfined, with the operator's reach, by the operator's ruling — a deliberate step " +
      "beyond the checks' sandbox, because that sandbox cannot listen on loopback on macOS and " +
      "the loop's agents already act with the operator's own posture, so a stricter one would " +
      'only add friction to the review. Needs `browser` with the `ephemeral` ' +
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

/** The longest text a UI question reads: a brief, as `host.harness.run` takes one whole. */
export const FOLDER_UI_TEXT_MAX_LENGTH = 32_000;
/** The most UI files an answer names; `touched` holds whatever the count. */
export const FOLDER_UI_FILES_MAX = 200;

/** A commit as a person names one, safe to hand git as a single argument. */
const FolderUiRefSchema = z
  .string()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex -- the control range is what is refused
  .regex(/^(?!-)[^\s\u0000-\u001f\u007f]+$/, {
    message:
      'A branch, tag or commit — `main`, `HEAD~3`, a sha — with no whitespace, never starting ' +
      'with `-`.',
  });

/**
 * What `host.binding.inspect` is asked about a folder's UI (Plan 320 D20): the
 * files a brief, a branch, a range or a run's diff names, matched against the
 * folder's `uiPaths`, and whether a harness run there could be given a browser.
 * Asked by the skills that add the browser and the preview by rule, never by
 * an agent choosing one.
 */
export const HostFolderUiQuestionSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(FOLDER_UI_TEXT_MAX_LENGTH)
      .optional()
      .describe(
        'A brief: every path it names — `src/app/page.tsx`, `src/app/page.tsx:12` — is matched.',
      ),
    branch: FolderUiRefSchema.optional().describe(
      'A branch a run continues: what it changes from where it meets the default branch of ' +
        "the folder's `origin` is matched. That default branch itself changes nothing.",
    ),
    from: FolderUiRefSchema.optional().describe('Where a range starts; only with `at`.'),
    at: FolderUiRefSchema.optional().describe(
      'Where a range ends: what `<from>..<at>` changes, read from where its two ends meet, is ' +
        'matched; without `from`, what that one commit changes.',
    ),
    patchRef: PayloadRefSchema.optional().describe(
      'A diff a `host.harness.run` result reports as `patchRef`: every file it changes is matched.',
    ),
    harness: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The harness a run would name; absent, the one the machine would choose for it. Whether ' +
          'that harness can be handed a browser is answered.',
      ),
  })
  .refine((question) => question.from === undefined || question.at !== undefined, {
    message: '`from` names where a range starts and needs `at`, where it ends.',
    path: ['from'],
  })
  .describe(
    "Ask which files touch the folder's UI — those a brief names, a branch or a range " +
      "changes, or a run's diff holds, matched against its `uiPaths` — and whether a harness " +
      'run there could be given a browser.',
  );
export type HostFolderUiQuestion = z.infer<typeof HostFolderUiQuestionSchema>;

/** Why a harness run on a folder could not be given a browser. */
export const HostFolderBrowserUnavailableSchema = z.enum(['executor', 'harness', 'grant']);
export type HostFolderBrowserUnavailable = z.infer<typeof HostFolderBrowserUnavailableSchema>;

export const HostFolderUiAnswerSchema = z
  .object({
    preview: z
      .enum(['declared', 'not_declared'])
      .describe("Whether a person declared the folder's preview."),
    uiPaths: z
      .array(z.string())
      .describe('The globs matched against: the declared ones, else the default.'),
    files: z
      .array(z.string())
      .max(FOLDER_UI_FILES_MAX)
      .describe(
        `The files asked about that match, relative to the folder's root as \`uiPaths\` are — a change outside the folder is none of them — sorted; at most ${String(FOLDER_UI_FILES_MAX)}.`,
      ),
    touched: z.boolean().describe('True when any file asked about matches.'),
    browser: z
      .object({
        harness: z
          .string()
          .optional()
          .describe('The harness the answer is for; absent where none could be chosen.'),
        unavailable: HostFolderBrowserUnavailableSchema.optional().describe(
          'Why a run could not be given a browser: `executor`, this machine serves none; ' +
            "`harness`, the harness has no browser arguments; `grant`, the run's grant does " +
            'not cover `browser.page:write`. Absent where it could.',
        ),
      })
      .describe('Whether a harness run on the folder could be given a browser.'),
  })
  .describe("The folder's preview, the UI files among those asked about, and the browser.");
export type HostFolderUiAnswer = z.infer<typeof HostFolderUiAnswerSchema>;
