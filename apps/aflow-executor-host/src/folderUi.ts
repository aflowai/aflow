/**
 * Which files touch a connected folder's UI, and whether a harness run there
 * could be given a browser (Plan 320 D20). Commission Change and Review Local
 * Changes add the browser and the preview to their harness run by rule; this is
 * what the rule reads, from the folder's declaration on this machine — the
 * same declaration the inventory's `previews` publishes — so nothing in it
 * names any one project.
 */
import {
  defaultFolderUiPaths,
  FOLDER_UI_FILES_MAX,
  type HostFolderBrowserUnavailable,
  type HostFolderUiAnswer,
  type HostFolderUiQuestion,
  resolveFolderPreview,
} from '@aflow/schemas';

import type { HostBinding } from './bindings.js';
import type { HarnessProfile } from './harnessProfiles.js';
import { globMatcher } from './pushChanges.js';
import {
  APPLY_OUTPUT_CAP_BYTES,
  folderPrefix,
  git,
  isGitRepository,
  patchPaths,
  readRemoteDefaultBranch,
  resolveCommit,
} from './worktree.js';

/** What git records as the tree of no files, for the change a root commit makes. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Characters that end a path in prose: whitespace, quotes, brackets, separators. */
const PATH_SEPARATORS = /[\s\x60\x27\x22()<>[\]{},;|]+/;
/** A path a brief can name: letters, digits and the punctuation file names carry. */
const PATH_TOKEN = /^[\w@+.\-/]+$/;

/**
 * The paths a brief names, as a person writes them — `src/app/page.tsx`,
 * `./src/app/page.tsx`, `src/app/page.tsx:12` or `:12-20`. Best-effort by
 * design: a commission whose brief names no UI file is still caught when its
 * run ends, by the files it changed.
 */
export function pathsNamedIn(text: string): string[] {
  const paths = new Set<string>();
  for (const raw of text.split(PATH_SEPARATORS)) {
    const token = raw
      .replace(/[.:!?]+$/, '')
      .replace(/:\d+(?:[-:]\d+)?$/, '')
      .replace(/^\.\//, '');
    if (token === '' || !PATH_TOKEN.test(token)) continue;
    if (!token.includes('/') && !token.includes('.')) continue;
    if (token.startsWith('/') || token.split('/').includes('..')) continue;
    paths.add(token);
  }
  return [...paths];
}

/** The files the diff from where `base` and `tip` meet to `tip` changes. */
async function changedBetween(root: string, base: string, tip: string): Promise<string[]> {
  const listed = await git(
    root,
    ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', base + '...' + tip],
    APPLY_OUTPUT_CAP_BYTES,
  );
  return listed.split('\0').filter((path) => path !== '');
}

/** The files one commit changes against its first parent, or against nothing for a root. */
async function changedBy(root: string, sha: string): Promise<string[]> {
  const parent = await resolveCommit(root, sha + '^1').catch(() => undefined);
  const listed = await git(
    root,
    ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', parent ?? EMPTY_TREE, sha],
    APPLY_OUTPUT_CAP_BYTES,
  );
  return listed.split('\0').filter((path) => path !== '');
}

/**
 * What a branch changes from where it meets the default branch of `origin`.
 * Nothing where the folder cannot say which that is, or the branch is it.
 */
async function changedOnBranch(root: string, branch: string): Promise<string[]> {
  const head = await readRemoteDefaultBranch(root, 'origin');
  if (!('branch' in head)) return [];
  const base = await resolveCommit(root, 'origin/' + head.branch).catch(() => undefined);
  const tip = await resolveCommit(root, branch).catch(() => undefined);
  if (base === undefined || tip === undefined || base === tip) return [];
  return await changedBetween(root, base, tip);
}

/**
 * Of paths relative to the repository's top level, as git reports a change,
 * those under the folder at `prefix`, relative to the folder's root — the
 * frame its `uiPaths` and `webAppDirs` are declared in. A path outside the
 * folder is none of its UI, whatever its extension.
 */
export function inFolderFrame(prefix: string, repositoryPaths: readonly string[]): string[] {
  if (prefix === '') return [...repositoryPaths];
  const lead = prefix + '/';
  return repositoryPaths
    .filter((path) => path.startsWith(lead) && path.length > lead.length)
    .map((path) => path.slice(lead.length));
}

/**
 * Every path the question names, relative to the folder's root, from each
 * source it gives. A brief names paths as the coding agent working in the
 * folder reads them; what git reports is translated from the repository's top
 * level. A source that cannot be read adds none.
 */
async function pathsAskedAbout(
  binding: HostBinding,
  question: HostFolderUiQuestion,
  readDiff: (ref: string) => Promise<string | undefined>,
): Promise<string[]> {
  const paths = new Set<string>(question.text !== undefined ? pathsNamedIn(question.text) : []);
  const repository = !binding.singleFile && (await isGitRepository(binding.root));
  if (!repository) return [...paths];
  const prefix = await folderPrefix(binding.root);
  const add = (listed: readonly string[]): void => {
    for (const path of inFolderFrame(prefix, listed)) paths.add(path);
  };
  if (question.branch !== undefined) {
    add(await changedOnBranch(binding.root, question.branch).catch(() => []));
  }
  if (question.at !== undefined) {
    const at = await resolveCommit(binding.root, question.at).catch(() => undefined);
    const from =
      question.from === undefined
        ? undefined
        : await resolveCommit(binding.root, question.from).catch(() => undefined);
    if (at !== undefined && (question.from === undefined || from !== undefined)) {
      add(
        await (
          from === undefined ? changedBy(binding.root, at) : changedBetween(binding.root, from, at)
        ).catch(() => []),
      );
    }
  }
  if (question.patchRef !== undefined) {
    const diff = await readDiff(question.patchRef);
    if (diff !== undefined) add(await patchPaths(binding.root, diff).catch(() => []));
  }
  return [...paths];
}

/** The paths among `paths` that one of `uiPaths` matches, sorted. */
export function uiFilesAmong(paths: readonly string[], uiPaths: readonly string[]): string[] {
  const matchers = uiPaths.map(globMatcher);
  return [...new Set(paths)]
    .filter((path) => matchers.some((matcher) => matcher.test(path)))
    .sort((a, b) => a.localeCompare(b));
}

export interface FolderUiContext {
  /** Whether this executor serves a browser at all. */
  readonly servesBrowser: boolean;
  /**
   * The orchestrator's judgement of the run's grant: `true` where it covers
   * a harness browser, or where no grant governs the run; undefined where no
   * grant was judged at all — a read outside a workflow run's task — so the
   * answer says the browser is not known to be available rather than that it is.
   */
  readonly browserGranted: boolean | undefined;
  /** The harness a run would get, or undefined where none can be chosen. */
  readonly harness: () => Promise<HarnessProfile | undefined>;
  /** A stored diff's text, or undefined where it cannot be read as one. */
  readonly readDiff: (ref: string) => Promise<string | undefined>;
}

/**
 * The run's grant as the folder's answer reads it. The orchestrator judges it
 * only when it dispatches a workflow run's task, and stamps nothing where no
 * grant governs that run — which no gate then holds a browser to. Outside a
 * workflow run's task nothing was judged, and the answer must not say the
 * browser is available on a judgement no one made: undefined, for `grant_not_judged`.
 */
export function judgedBrowserGrant(ctx: {
  readonly job: { readonly workflowExecution?: unknown };
  readonly browserGranted?: boolean;
}): boolean | undefined {
  if (ctx.browserGranted !== undefined) return ctx.browserGranted;
  return ctx.job.workflowExecution !== undefined ? true : undefined;
}

export async function answerFolderUi(
  binding: HostBinding,
  question: HostFolderUiQuestion,
  context: FolderUiContext,
): Promise<HostFolderUiAnswer> {
  const uiPaths =
    binding.preview !== undefined
      ? [...resolveFolderPreview(binding.preview).uiPaths]
      : defaultFolderUiPaths();
  const matched = uiFilesAmong(await pathsAskedAbout(binding, question, context.readDiff), uiPaths);
  const profile = await context.harness();
  const unavailable: HostFolderBrowserUnavailable | undefined = !context.servesBrowser
    ? 'executor'
    : profile === undefined || profile.mcpArgs.length === 0
      ? 'harness'
      : context.browserGranted === false
        ? 'grant'
        : context.browserGranted === undefined
          ? 'grant_not_judged'
          : undefined;
  return {
    preview: binding.preview !== undefined ? 'declared' : 'not_declared',
    uiPaths,
    files: matched.slice(0, FOLDER_UI_FILES_MAX),
    touched: matched.length > 0,
    browser: {
      ...(profile !== undefined ? { harness: profile.id } : {}),
      ...(unavailable !== undefined ? { unavailable } : {}),
    },
  };
}
