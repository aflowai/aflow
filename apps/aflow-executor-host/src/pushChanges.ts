/**
 * What a push changes, counted: the files and lines of the diff from where
 * `pushRange`'s two ends meet — the diff a review of the range reads — in all
 * and within each named set of path globs the caller asks about. The caller
 * names the areas, so what counts as which kind of change is its policy, and
 * this counts only.
 */
import { HOST_BINARY_FILE_LINES } from '@aflow/schemas';

import { APPLY_OUTPUT_CAP_BYTES, git } from './worktree.js';

export interface ChangeCount {
  readonly files: number;
  readonly lines: number;
}

export interface PushChanges extends ChangeCount {
  readonly areas: Readonly<Record<string, ChangeCount>>;
}

/** A glob over a repository-relative path: `*` and `?` within one directory, `**` across any number. */
export function globMatcher(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * One `--numstat -z` record per file; renames are off, so each names one path.
 * Git writes `-` for both counts of a binary file, which is counted at
 * `HOST_BINARY_FILE_LINES` rather than as no change at all.
 */
export function parseNumstat(output: string): Array<{ path: string; lines: number }> {
  const files: Array<{ path: string; lines: number }> = [];
  for (const record of output.split('\0')) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
    if (!match) continue;
    const [, added, removed, path] = match;
    const lines =
      added === '-' || removed === '-' ? HOST_BINARY_FILE_LINES : Number(added) + Number(removed);
    files.push({ path: path!, lines });
  }
  return files;
}

export function countChanges(
  files: ReadonlyArray<{ path: string; lines: number }>,
  areas: Readonly<Record<string, readonly string[]>>,
): PushChanges {
  const sum = (within: ReadonlyArray<{ lines: number }>): ChangeCount => ({
    files: within.length,
    lines: within.reduce((total, file) => total + file.lines, 0),
  });
  const counted: Record<string, ChangeCount> = {};
  for (const [area, globs] of Object.entries(areas)) {
    const matchers = globs.map(globMatcher);
    counted[area] = sum(files.filter((file) => matchers.some((m) => m.test(file.path))));
  }
  return { ...sum(files), areas: counted };
}

/**
 * Undefined where git cannot read the diff — two ends with no commit in
 * common — which a reader takes as a shape it was not told, never as none.
 */
export async function measurePushChanges(
  root: string,
  pushBaseSha: string,
  sha: string,
  areas: Readonly<Record<string, readonly string[]>>,
): Promise<PushChanges | undefined> {
  let numstat: string;
  try {
    numstat = await git(
      root,
      [
        'diff',
        '--numstat',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '-z',
        `${pushBaseSha}...${sha}`,
      ],
      APPLY_OUTPUT_CAP_BYTES,
    );
  } catch {
    return undefined;
  }
  return countChanges(parseNumstat(numstat), areas);
}
