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
import {
  HOST_COMMIT_RANGE_PATTERN,
  type HostCommitScanOutputSchema,
  type HostCommitScanUnscannedReasonSchema,
} from '@aflow/schemas';
import type { z } from 'zod';

import { scanLine } from './secretRules.js';
import { countCommits, forEachGitLine, resolveCommit, WorktreeError } from './worktree.js';

type HostCommitScanOutput = z.infer<typeof HostCommitScanOutputSchema>;
type Finding = HostCommitScanOutput['findings'][number];
type Unscanned = HostCommitScanOutput['unscanned'][number];
type UnscannedReason = z.infer<typeof HostCommitScanUnscannedReasonSchema>;

/**
 * The most a file may add in one commit and still be read whole. Past it the
 * file is generated or vendored; the rest of it is not read, and the file is
 * reported as unscanned so the range is not cleared.
 */
export const SCAN_MAX_FILE_BYTES = 1024 * 1024;
/**
 * The longest added line the rules read. A longer one is minified or data; it
 * is not matched, and its file is reported as unscanned. The reader holds no
 * more than this of any line, however long the line is.
 */
export const SCAN_MAX_LINE_BYTES = 64 * 1024;
/** How many findings, allowed lines and unscanned files are each listed; the summary counts the rest. */
export const SCAN_MAX_LISTED = 50;
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

/**
 * The new side's path from a `+++` line, or nothing for a deleted file. git
 * ends the line with a TAB when an unquoted path holds a space.
 */
function newSidePath(header: string): string | undefined {
  const raw = unquotePath(header.slice('+++ '.length).replace(/\t$/, ''));
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

/** One file's part of one commit's diff. */
interface FileSection {
  file: string | undefined;
  addedBytes: number;
  /** Set once nothing more of the file is read. */
  stopped: boolean;
  reasons: Set<UnscannedReason>;
  findings: Finding[];
  allowed: Finding[];
}

/** A list capped at `SCAN_MAX_LISTED`, deduplicated by key, counting what it holds in all. */
class Listing<T> {
  readonly items: T[] = [];
  private readonly seen = new Set<string>();

  add(key: string, item: T): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.items.length < SCAN_MAX_LISTED) this.items.push(item);
  }

  get total(): number {
    return this.seen.size;
  }

  get beyond(): number {
    return this.seen.size - this.items.length;
  }
}

interface ScanTally {
  readonly findings: Listing<Finding>;
  readonly allowed: Listing<Finding>;
  readonly unscanned: Listing<Unscanned>;
}

function lineKey(finding: Finding): string {
  return `${finding.file}\0${String(finding.line)}\0${finding.pattern}`;
}

function closeSection(section: FileSection | undefined, tally: ScanTally): void {
  if (section?.file === undefined) return;
  for (const finding of section.findings) tally.findings.add(lineKey(finding), finding);
  for (const allowed of section.allowed) tally.allowed.add(lineKey(allowed), allowed);
  for (const reason of section.reasons) {
    tally.unscanned.add(`${section.file}\0${reason}`, { file: section.file, reason });
  }
}

/**
 * Read `git log -p -U0` line by line. With no context lines a hunk holds only
 * `+`, `-` and `\` lines, so a `+` inside one is always an added line, never a
 * header that happens to start the same way.
 */
async function readAddedLines(root: string, base: string, head: string): Promise<ScanTally> {
  const tally: ScanTally = {
    findings: new Listing(),
    allowed: new Listing(),
    unscanned: new Listing(),
  };
  let section: FileSection | undefined;
  let inHunk = false;
  let nextLine = 0;

  const read = (line: string, bytes: number): void => {
    if (line.startsWith('diff --git ')) {
      closeSection(section, tally);
      section = {
        file: undefined,
        addedBytes: 0,
        stopped: false,
        reasons: new Set(),
        findings: [],
        allowed: [],
      };
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
        section.stopped = true;
        section.reasons.add('binary');
      }
      return;
    }
    if (!line.startsWith('+')) return;
    const lineNumber = nextLine;
    nextLine += 1;
    if (section.stopped || section.file === undefined) return;
    const added = line.slice(1);
    // The line's own bytes less its `+`, and the newline that ends it.
    section.addedBytes += bytes;
    if (section.addedBytes > SCAN_MAX_FILE_BYTES) {
      section.stopped = true;
      section.reasons.add('too-large');
      return;
    }
    if (added.includes('\0')) {
      section.stopped = true;
      section.reasons.add('nul-byte');
      return;
    }
    if (bytes - 1 > SCAN_MAX_LINE_BYTES) {
      section.reasons.add('line-too-long');
      return;
    }
    const verdict = scanLine(section.file, added);
    if (verdict === undefined) return;
    const place = { file: section.file, line: lineNumber, pattern: verdict.rule };
    if (verdict.allowed) section.allowed.push(place);
    else section.findings.push(place);
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
        // A merge shows no diff by default, so lines it adds resolving a
        // conflict would never be read; against its first parent it shows
        // everything it brings into the branch.
        '--diff-merges=first-parent',
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
      {
        maxBytes: SCAN_MAX_DIFF_BYTES,
        // The `+` that marks an added line, then the line.
        maxLineBytes: SCAN_MAX_LINE_BYTES + 1,
        timeoutMs: SCAN_TIMEOUT_MS,
      },
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

function kilobytes(bytes: number): string {
  return `${String(bytes / 1024)} KB`;
}

const UNSCANNED_WHY: Record<UnscannedReason, string> = {
  binary: 'binary',
  'nul-byte': 'a NUL byte in a line it adds',
  'too-large': `more than ${kilobytes(SCAN_MAX_FILE_BYTES)} added in one commit`,
  'line-too-long': `a line longer than ${kilobytes(SCAN_MAX_LINE_BYTES)}`,
};

function beyondNote(listing: Listing<unknown>): string {
  return listing.beyond > 0 ? `, and ${String(listing.beyond)} more` : '';
}

function summarize(tally: ScanTally, commits: number, range: string): string {
  const scope = `the ${plural(commits, 'commit', 'commits')} of \`${range}\``;
  const { findings, allowed, unscanned } = tally;
  const sentences: string[] = [];
  if (findings.total > 0) {
    const places = findings.items.map((f) => `${f.file} line ${String(f.line)} (${f.pattern})`);
    sentences.push(
      `What looks like a secret is in ${plural(findings.total, 'place', 'places')} in ${scope}: ` +
        `${places.join(', ')}${beyondNote(findings)}.`,
    );
  } else if (unscanned.total > 0) {
    sentences.push(`No secret found in the lines read of ${scope}, but not every file was read.`);
  } else {
    sentences.push(`No secret found in the lines ${scope} add.`);
  }
  if (unscanned.total > 0) {
    const files = unscanned.items.map((u) => `${u.file} (${UNSCANNED_WHY[u.reason]})`);
    sentences.push(`Not read whole: ${files.join(', ')}${beyondNote(unscanned)}.`);
  }
  if (allowed.total > 0) {
    const lines = allowed.items.map((a) => `${a.file} line ${String(a.line)} (${a.pattern})`);
    sentences.push(
      `Let through by an \`aflow-scan: allow\` comment on the line: ${lines.join(', ')}` +
        `${beyondNote(allowed)}.`,
    );
  }
  return sentences.join(' ');
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
  const unflagged = tally.findings.total === 0;
  const clean = unflagged && tally.unscanned.total === 0;
  return {
    clean,
    findings: tally.findings.items,
    unscanned: tally.unscanned.items,
    allowed: tally.allowed.items,
    summary: summarize(tally, commits, resolved),
    ...(unflagged ? { unflaggedRange: resolved } : {}),
    ...(clean ? { clearedRange: resolved } : {}),
  };
}
