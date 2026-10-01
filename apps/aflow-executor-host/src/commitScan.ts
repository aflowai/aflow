/**
 * Reading the commits a publication is about to push, for secrets.
 *
 * Every commit in the range is read, not the range's net diff: a push carries
 * each commit, so a secret added in one and removed in the next still leaves
 * the machine. Only added lines are read, and only from the repository's
 * objects — the working tree, the index and every ref are left alone.
 *
 * A line that matches says so by file, line and rule name. What matched is
 * never held past the test that found it.
 */
import { HOST_COMMIT_RANGE_PATTERN, type HostCommitScanOutputSchema } from '@aflow/schemas';
import type { z } from 'zod';

import { matchingRule } from './secretRules.js';
import { countCommits, forEachGitLine, resolveCommit, WorktreeError } from './worktree.js';

type HostCommitScanOutput = z.infer<typeof HostCommitScanOutputSchema>;
type Finding = HostCommitScanOutput['findings'][number];

/**
 * The most a file may add in one commit and still be read. Past it the file is
 * generated or vendored, and reading it costs more than a match in it is
 * likely to be worth; the summary names it as not read.
 */
export const SCAN_MAX_FILE_BYTES = 1024 * 1024;
/** How many findings are returned; the summary counts the rest. */
export const SCAN_MAX_FINDINGS = 50;
/**
 * The most diff a scan reads in all. A range past it is refused rather than
 * scanned in part, because a partial scan cannot clear what it did not read.
 */
export const SCAN_MAX_DIFF_BYTES = 64 * 1024 * 1024;
export const SCAN_TIMEOUT_MS = 120_000;

/** The commit a sha names, refused unless the commit's own sha begins with it. */
async function resolveRangeEnd(root: string, sha: string): Promise<string> {
  const commit = await resolveCommit(root, sha).catch(() => undefined);
  // git reads a short hex string as a ref name before a sha, and peels a tag
  // to the commit it tags; only a prefix of the commit's own sha names it.
  if (!commit?.startsWith(sha.toLowerCase())) {
    throw new WorktreeError(
      `\`${sha}\` names no commit in ${root}. A range is the two shas of commits the folder has.`,
      'unknown_ref',
    );
  }
  return commit;
}

/** A path as git prints it: bare, or C-quoted when it holds a quote, a backslash or a control character. */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i] ?? '';
    if (character !== '\\') {
      bytes.push(...Buffer.from(character, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The new side's path from a `+++` line, or nothing for a deleted file. */
function newSidePath(header: string): string | undefined {
  const raw = unquotePath(header.slice('+++ '.length));
  if (raw === '/dev/null') return undefined;
  return raw.startsWith('b/') ? raw.slice(2) : raw;
}

/** The new side's path from `Binary files a/x and b/y differ`, or nothing for a deleted file. */
function binaryPath(line: string): string | undefined {
  const match = /^Binary files .* and (.*) differ$/.exec(line);
  const raw = match?.[1] === undefined ? undefined : unquotePath(match[1]);
  if (raw === undefined || raw === '/dev/null') return undefined;
  return raw.startsWith('b/') ? raw.slice(2) : raw;
}

interface FileSection {
  file: string | undefined;
  addedBytes: number;
  unread: boolean;
  findings: Finding[];
}

interface ScanTally {
  readonly findings: Finding[];
  readonly seen: Set<string>;
  readonly unread: Set<string>;
  total: number;
}

function closeSection(section: FileSection | undefined, tally: ScanTally): void {
  if (section?.file === undefined) return;
  if (section.unread) {
    tally.unread.add(section.file);
    return;
  }
  for (const finding of section.findings) {
    const key = `${finding.file}\0${String(finding.line)}\0${finding.pattern}`;
    if (tally.seen.has(key)) continue;
    tally.seen.add(key);
    tally.total += 1;
    if (tally.findings.length < SCAN_MAX_FINDINGS) tally.findings.push(finding);
  }
}

/**
 * Read `git log -p -U0` line by line. With no context lines a hunk holds only
 * `+`, `-` and `\` lines, so a `+` inside one is always an added line, never a
 * header that happens to start the same way.
 */
async function readAddedLines(root: string, base: string, head: string): Promise<ScanTally> {
  const tally: ScanTally = { findings: [], seen: new Set(), unread: new Set(), total: 0 };
  let section: FileSection | undefined;
  let inHunk = false;
  let nextLine = 0;

  const read = (line: string): void => {
    if (line.startsWith('diff --git ')) {
      closeSection(section, tally);
      section = { file: undefined, addedBytes: 0, unread: false, findings: [] };
      inHunk = false;
      return;
    }
    if (section === undefined) return;
    if (line.startsWith('@@ ')) {
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)?.[1];
      inHunk = start !== undefined;
      nextLine = Number(start ?? 0);
      return;
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) section.file = newSidePath(line);
      else if (line.startsWith('Binary files ')) {
        section.file = binaryPath(line);
        section.unread = true;
      }
      return;
    }
    if (!line.startsWith('+')) return;
    const lineNumber = nextLine;
    nextLine += 1;
    if (section.unread || section.file === undefined) return;
    const added = line.slice(1);
    section.addedBytes += Buffer.byteLength(added, 'utf8') + 1;
    if (section.addedBytes > SCAN_MAX_FILE_BYTES || added.includes('\0')) {
      section.unread = true;
      return;
    }
    const rule = matchingRule(added);
    if (rule !== undefined) {
      section.findings.push({ file: section.file, line: lineNumber, pattern: rule });
    }
  };

  try {
    await forEachGitLine(
      root,
      [
        '-c',
        'core.quotePath=false',
        'log',
        '--format=',
        '--patch',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        // The repository's own config may set either prefix away; the parser reads `b/`.
        '--src-prefix=a/',
        '--dst-prefix=b/',
        `${base}..${head}`,
      ],
      { maxBytes: SCAN_MAX_DIFF_BYTES, timeoutMs: SCAN_TIMEOUT_MS },
      read,
    );
  } catch (error) {
    if (!(error instanceof WorktreeError)) throw error;
    throw new WorktreeError(
      `The commits of \`${base}..${head}\` could not be read whole, and a range read in part ` +
        `is not cleared: ${error.message}`,
      'git_failed',
    );
  }
  closeSection(section, tally);
  return tally;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function summarize(tally: ScanTally, commits: number, range: string): string {
  const scope = `the ${plural(commits, 'commit', 'commits')} of \`${range}\``;
  const unread = [...tally.unread].sort();
  const unreadNote =
    unread.length === 0
      ? ''
      : ` Not read, as binary or adding more than ${String(SCAN_MAX_FILE_BYTES / 1024)} KB in one ` +
        `commit: ${unread.join(', ')}.`;
  if (tally.total === 0) return `No secret found in the lines ${scope} add.${unreadNote}`;
  const places = tally.findings.map((f) => `${f.file} line ${String(f.line)} (${f.pattern})`);
  const beyond = tally.total - tally.findings.length;
  return (
    `What looks like a secret is in ${plural(tally.total, 'place', 'places')} in ${scope}: ` +
    `${places.join(', ')}${beyond > 0 ? `, and ${String(beyond)} more` : ''}.${unreadNote}`
  );
}

/**
 * Scan the lines `<baseSha>..<sha>` adds. Refused, not cleared, when either end
 * names no commit or the range is too large to read whole.
 */
export async function scanCommitRange(root: string, range: string): Promise<HostCommitScanOutput> {
  const ends = HOST_COMMIT_RANGE_PATTERN.exec(range);
  if (ends?.[1] === undefined || ends[2] === undefined) {
    throw new WorktreeError(`\`${range}\` is not a range of two shas.`, 'unknown_ref');
  }
  const base = await resolveRangeEnd(root, ends[1]);
  const head = await resolveRangeEnd(root, ends[2]);
  const resolved = `${base}..${head}`;

  const tally = await readAddedLines(root, base, head);
  const commits = await countCommits(root, base, head);
  const clean = tally.total === 0;
  return {
    clean,
    findings: tally.findings,
    summary: summarize(tally, commits, resolved),
    ...(clean ? { clearedRange: resolved } : {}),
  };
}
