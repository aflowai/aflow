/**
 * Reading the commits a publication is about to push, for secrets.
 *
 * Every commit in the range is read, not the range's net diff: a push carries
 * each commit, so a secret added in one and removed in the next still leaves
 * the machine. Only added lines and the commits' messages are read, and only
 * from the repository's objects — the working tree, the index and every ref
 * are left alone. Text that leaves with the push but is not in a commit, such
 * as a pull request's title and body, is handed in and read the same way.
 *
 * A line that matches says so by where it is, line and rule name. What matched
 * is never held past the test that found it.
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

const BINARY_PREFIX = 'Binary files ';
const BINARY_SUFFIX = ' differ';
const BINARY_JOIN = ' and ';
const DEV_NULL = '/dev/null';

/**
 * The new side's path from `Binary files a/x and b/y differ`, or nothing for a
 * deleted file. A path may itself hold ` and `, so the line is not split at
 * the first or the last one: with renames off both sides name one path, which
 * puts the join at the middle; a file added or deleted has `/dev/null` on one
 * side.
 */
function binaryPath(line: string): string | undefined {
  if (!line.startsWith(BINARY_PREFIX) || !line.endsWith(BINARY_SUFFIX)) return undefined;
  const body = line.slice(BINARY_PREFIX.length, -BINARY_SUFFIX.length);
  const half = (body.length - BINARY_JOIN.length) / 2;
  if (Number.isInteger(half) && body.slice(half, half + BINARY_JOIN.length) === BINARY_JOIN) {
    const oldSide = unquotePath(body.slice(0, half));
    const newSide = unquotePath(body.slice(half + BINARY_JOIN.length));
    if (
      oldSide.startsWith('a/') &&
      newSide.startsWith('b/') &&
      oldSide.slice(2) === newSide.slice(2)
    ) {
      return newSide.slice(2);
    }
  }
  if (body.startsWith(`${DEV_NULL}${BINARY_JOIN}`)) {
    const newSide = unquotePath(body.slice(DEV_NULL.length + BINARY_JOIN.length));
    return newSide.startsWith('b/') ? newSide.slice(2) : newSide;
  }
  return undefined;
}

/**
 * What a Git LFS pointer adds: its first line, or — where a commit changes the
 * tracked content and the version line stays — the line naming the new object.
 */
const LFS_POINTER_VERSION = 'version https://git-lfs.github.com/spec/';
const LFS_POINTER_OID = /^oid sha256:[0-9a-f]{64}$/;

/** A line `git log --format=%x00%H%n%B` starts each message with. */
const MESSAGE_START = /^\0([0-9a-f]{40,64})$/;

/** One file's part of one commit's diff, one commit's message, or one text. */
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

function openSection(file: string | undefined): FileSection {
  return { file, addedBytes: 0, stopped: false, reasons: new Set(), findings: [], allowed: [] };
}

/**
 * Weigh one line of a section against the rules. `bytes` is the line's own
 * length in bytes and the newline that ends it, which may be more than the
 * line as handed over: the reader holds no more than the cap of any line.
 */
function readLine(section: FileSection, line: string, bytes: number, lineNumber: number): void {
  if (section.stopped || section.file === undefined) return;
  section.addedBytes += bytes;
  if (section.addedBytes > SCAN_MAX_FILE_BYTES) {
    section.stopped = true;
    section.reasons.add('too-large');
    return;
  }
  if (line.includes('\0')) {
    section.stopped = true;
    section.reasons.add('nul-byte');
    return;
  }
  if (bytes - 1 > SCAN_MAX_LINE_BYTES) {
    section.reasons.add('line-too-long');
    return;
  }
  const verdict = scanLine(section.file, line);
  if (verdict === undefined) return;
  const place = { file: section.file, line: lineNumber, pattern: verdict.rule };
  if (verdict.allowed) section.allowed.push(place);
  else section.findings.push(place);
}

/** Run a `git log` over the range a line at a time, refusing the range if it cannot be read whole. */
async function readRange(
  root: string,
  base: string,
  head: string,
  args: readonly string[],
  read: (line: string, bytes: number) => void,
): Promise<void> {
  try {
    await forEachGitLine(
      root,
      [...args, `${base}..${head}`],
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
}

/**
 * Read `git log -p -U0` line by line. With no context lines a hunk holds only
 * `+`, `-` and `\` lines, so a `+` inside one is always an added line, never a
 * header that happens to start the same way.
 */
async function readAddedLines(
  root: string,
  base: string,
  head: string,
  tally: ScanTally,
): Promise<void> {
  let section: FileSection | undefined;
  let inHunk = false;
  let nextLine = 0;

  const read = (line: string, bytes: number): void => {
    if (line.startsWith('diff --git ')) {
      closeSection(section, tally);
      section = openSection(undefined);
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
    if (section.file === undefined) return;
    const added = line.slice(1);
    // The pointer is what the commit holds; the bytes it names are what
    // the operator's git uploads on push, and they are not here to read.
    if (
      (lineNumber === 1 && added.startsWith(LFS_POINTER_VERSION)) ||
      LFS_POINTER_OID.test(added)
    ) {
      section.reasons.add('lfs');
    }
    // `bytes` counts the `+`, which stands in for the newline that ends the line.
    readLine(section, added, bytes, lineNumber);
  };

  await readRange(
    root,
    base,
    head,
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
    ],
    read,
  );
  closeSection(section, tally);
}

/**
 * Read every commit's message in the range, each as its own text: a push
 * carries the messages with the commits.
 */
async function readMessages(
  root: string,
  base: string,
  head: string,
  tally: ScanTally,
): Promise<void> {
  let section: FileSection | undefined;
  let lineNumber = 0;
  await readRange(
    root,
    base,
    head,
    // The repository's config may show signatures, which would be read as
    // part of the message; they are not what the push carries.
    ['log', '--no-show-signature', '--format=%x00%H%n%B'],
    (line, bytes) => {
      const sha = MESSAGE_START.exec(line)?.[1];
      if (sha !== undefined) {
        closeSection(section, tally);
        section = openSection(`${sha} (message)`);
        lineNumber = 0;
        return;
      }
      if (section === undefined) return;
      lineNumber += 1;
      readLine(section, line, bytes + 1, lineNumber);
    },
  );
  closeSection(section, tally);
}

/** Read each text passed beside the range, under its name. */
function readTexts(texts: Readonly<Record<string, string>>, tally: ScanTally): void {
  for (const [name, text] of Object.entries(texts)) {
    const section = openSection(name);
    text.split('\n').forEach((raw, index) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      readLine(section, line, Buffer.byteLength(line, 'utf8') + 1, index + 1);
    });
    closeSection(section, tally);
  }
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
  lfs: 'a Git LFS pointer, whose content the push uploads unread',
};

function beyondNote(listing: Listing<unknown>): string {
  return listing.beyond > 0 ? `, and ${String(listing.beyond)} more` : '';
}

function summarize(
  tally: ScanTally,
  commits: number,
  range: string,
  textNames: readonly string[],
): string {
  const scope = `the ${plural(commits, 'commit', 'commits')} of \`${range}\``;
  const read =
    textNames.length === 0
      ? `the lines ${scope} add and their messages`
      : `the lines ${scope} add, their messages and ${textNames.map((name) => `\`${name}\``).join(', ')}`;
  const { findings, allowed, unscanned } = tally;
  const sentences: string[] = [];
  if (findings.total > 0) {
    const places = findings.items.map((f) => `${f.file} line ${String(f.line)} (${f.pattern})`);
    sentences.push(
      `What looks like a secret is in ${plural(findings.total, 'place', 'places')} in ${read}: ` +
        `${places.join(', ')}${beyondNote(findings)}.`,
    );
  } else if (unscanned.total > 0) {
    sentences.push(`No secret found in what was read of ${read}, but not all of it was read.`);
  } else if (allowed.total > 0) {
    sentences.push(`No secret found in ${read}, apart from lines marked allowed.`);
  } else {
    sentences.push(`No secret found in ${read}.`);
  }
  if (unscanned.total > 0) {
    const files = unscanned.items.map((u) => `${u.file} (${UNSCANNED_WHY[u.reason]})`);
    sentences.push(`Not read whole: ${files.join(', ')}${beyondNote(unscanned)}.`);
  }
  if (allowed.total > 0) {
    const lines = allowed.items.map((a) => `${a.file} line ${String(a.line)} (${a.pattern})`);
    sentences.push(
      `Marked allowed by an \`aflow-scan: allow\` comment, and so for the operator to read ` +
        `before anything is pushed: ${lines.join(', ')}${beyondNote(allowed)}.`,
    );
  }
  return sentences.join(' ');
}

/**
 * Scan the lines `<baseSha>..<sha>` adds, the messages of its commits, and
 * each text that leaves with them. Refused, not cleared, when either end names
 * no commit or the range is too large to read whole.
 */
export async function scanCommitRange(
  root: string,
  range: string,
  texts: Readonly<Record<string, string>> = {},
): Promise<HostCommitScanOutput> {
  const ends = HOST_COMMIT_RANGE_PATTERN.exec(range);
  if (ends?.[1] === undefined || ends[2] === undefined) {
    throw new WorktreeError(`\`${range}\` is not a range of two shas.`, 'unknown_ref');
  }
  const base = await resolveRangeEnd(root, ends[1]);
  const head = await resolveRangeEnd(root, ends[2]);
  const resolved = `${base}..${head}`;

  const tally: ScanTally = {
    findings: new Listing(),
    allowed: new Listing(),
    unscanned: new Listing(),
  };
  await readAddedLines(root, base, head, tally);
  await readMessages(root, base, head, tally);
  readTexts(texts, tally);
  const commits = await countCommits(root, base, head);
  const unflagged = tally.findings.total === 0;
  const clean = unflagged && tally.allowed.total === 0 && tally.unscanned.total === 0;
  return {
    clean,
    findings: tally.findings.items,
    unscanned: tally.unscanned.items,
    allowed: tally.allowed.items,
    summary: summarize(tally, commits, resolved, Object.keys(texts)),
    ...(unflagged ? { unflaggedRange: resolved } : {}),
    ...(clean ? { clearedRange: resolved } : {}),
  };
}
