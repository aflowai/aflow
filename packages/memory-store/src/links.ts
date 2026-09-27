import {
  LINK_CONTEXT_CHARS,
  LINK_SCAN_BYTES,
  LINK_TARGET_MAX_BYTES,
  MAX_LINKS_PER_DOC,
} from './linkConstants.js';

export interface ParsedLink {
  targetPath: string;
  ordinal: number;
  occurrenceCount: number;
  firstContext?: string;
  /**
   * The target as written, absolute but without the markdown completion. Set
   * only when `.md` was appended, and dropped once the write has decided which
   * of the two a live document answers to.
   */
  spelledTargetPath?: string;
}

export interface LinkParseResult {
  links: ParsedLink[];
  clamped: boolean;
  scanTruncated: boolean;
}

const BIDI_OVERRIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function isBidiOverride(codePoint: number): boolean {
  for (const [lo, hi] of BIDI_OVERRIDE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * Directional marks and zero-width / invisible format characters. These are not
 * caught by the override/isolate ranges above but still shift bidi rendering or
 * hide text: ALM (U+061C); ZWSP/ZWNJ/ZWJ/LRM/RLM (U+200B–200F); word joiner
 * (U+2060); ZWNBSP / BOM (U+FEFF). They must not survive into an agent-facing
 * hook or a resolved path.
 */
function isInvisibleFormat(codePoint: number): boolean {
  if (codePoint === 0x061c) return true;
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true;
  if (codePoint === 0x2060) return true;
  if (codePoint === 0xfeff) return true;
  return false;
}

export const WIKILINK_SYNTAX = /\[\[[^\]]*\]\]/g;

/**
 * Make wikilink syntax inert in text that a writer is embedding into a document
 * it authors — a prompt, a caption, a title. Prose that merely spells
 * `[[/some/path]]` is otherwise indexed as a real outgoing link and shows up as
 * a backlink on a document the writer never read.
 *
 * The brackets are rewritten rather than escaped. A leading backslash is not a
 * defence: the scanner reads `\` as "skip the next character", so text that
 * already ends in a backslash consumes the escape and leaves the opener live.
 */
export function neutralizeWikilinks(text: string): string {
  return text.replace(WIKILINK_SYNTAX, (link) => link.replaceAll('[', '(').replaceAll(']', ')'));
}

/**
 * Sanitize text that flows into agent/reader-visible surfaces (firstContext,
 * index hooks): NUL and C0/C1/DEL controls become spaces, bidi overrides are
 * dropped outright, and all whitespace collapses to single spaces so no
 * terminal-escape / OSC / visual-order-spoofing sequence survives verbatim.
 */
export function sanitizeInjectedText(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isBidiOverride(cp) || isInvisibleFormat(cp)) continue;
    if (cp === 0x00 || cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * C0 controls are U+0000–U+001F (incl. NUL, TAB, LF, CR), C1 controls
 * U+0080–U+009F, plus DEL (U+007F). Outer whitespace is stripped by trimming
 * before this scan runs, so any control char that reaches here is interior and
 * forbidden — an embedded TAB/CR must not survive into a canonical path.
 */
function isForbiddenControl(codePoint: number): boolean {
  if (codePoint <= 0x1f) return true;
  if (codePoint === 0x7f) return true;
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
  return false;
}

function targetHasForbiddenChar(target: string): boolean {
  for (const ch of target) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isForbiddenControl(cp)) return true;
    if (isBidiOverride(cp)) return true;
    if (isInvisibleFormat(cp)) return true;
    // Unescaped wikilink brackets can never form a real memory path — a nested
    // or unbalanced `[[`/`]]` leaks bracket noise into the resolved target.
    if (ch === '[' || ch === ']') return true;
  }
  return false;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '/';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

/**
 * A path segment is "extensionless" when it carries no filename extension.
 * A leading dot (dotfiles like `.keep`) does NOT count as an extension — the
 * dot before the basename is the visibility marker, not an extension boundary —
 * so `.keep` is extensionless and becomes `.keep.md`, while `data.json` keeps
 * its `.json`. A trailing dot (`foo.`) is treated as extensionless too.
 */
function needsMarkdownExtension(lastSegment: string): boolean {
  const withoutLeadingDots = lastSegment.replace(/^\.+/, '');
  const dotIdx = withoutLeadingDots.lastIndexOf('.');
  if (dotIdx <= 0) return true;
  if (dotIdx === withoutLeadingDots.length - 1) return true;
  return false;
}

export interface ResolvedTarget {
  /** The path the link is indexed under. */
  path: string;
  /**
   * The same target with the markdown completion left off, present only when
   * one was applied. A document filed without an extension — a rendered image,
   * a clip — is reachable at this spelling and at no other.
   */
  spelledPath?: string;
}

/**
 * Resolve a wikilink target to an absolute, within-space memory path.
 * Returns null when the target is rejected (empty, byte-cap, control, bidi).
 */
export function resolveTarget(target: string, sourcePath: string): ResolvedTarget | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > LINK_TARGET_MAX_BYTES) return null;
  if (targetHasForbiddenChar(trimmed)) return null;

  const base = trimmed.startsWith('/') ? trimmed : `${dirOf(sourcePath)}/${trimmed}`;

  const resolved: string[] = [];
  for (const segment of base.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  if (resolved.length === 0) return null;

  const spelledPath = `/${resolved.join('/')}`;

  const lastIdx = resolved.length - 1;
  const lastSegment = resolved[lastIdx]!;
  if (!needsMarkdownExtension(lastSegment)) return { path: spelledPath };

  resolved[lastIdx] = `${lastSegment}.md`;
  return { path: `/${resolved.join('/')}`, spelledPath };
}

/** The path a target is indexed under, markdown completion included. */
export function canonicalizeTarget(target: string, sourcePath: string): string | null {
  return resolveTarget(target, sourcePath)?.path ?? null;
}

interface RawMatch {
  targetPath: string;
  charIndex: number;
}

/**
 * Find the char count of the longest prefix of `chars` whose UTF-8 encoding
 * fits within `maxBytes`. Returns { limit, truncated } where `limit` is that
 * char count and `truncated` is true when the full string exceeds the budget.
 */
function byteLimitedCharCount(
  chars: string[],
  maxBytes: number,
): { limit: number; truncated: boolean } {
  let bytes = 0;
  for (let i = 0; i < chars.length; i += 1) {
    bytes += Buffer.byteLength(chars[i]!, 'utf8');
    if (bytes > maxBytes) return { limit: i, truncated: true };
  }
  return { limit: chars.length, truncated: false };
}

/**
 * Scan content for `[[target]]` / `[[target|label]]` wikilinks, ignoring any
 * that fall inside fenced code blocks, inline code spans, or backslash escapes.
 * Only the first LINK_SCAN_BYTES of UTF-8 are inspected.
 */
function scanRawMatches(chars: string[]): { matches: RawMatch[]; scanTruncated: boolean } {
  const matches: RawMatch[] = [];
  const { limit, truncated } = byteLimitedCharCount(chars, LINK_SCAN_BYTES);

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  let lineLeadingWhitespace = true;

  let inInlineCode = false;
  let inlineCodeLen = 0;

  let i = 0;
  while (i < limit) {
    const ch = chars[i]!;

    if (ch === '\n') {
      i += 1;
      lineLeadingWhitespace = true;
      // A newline closes an unterminated inline code span so a stray backtick
      // never masks the remainder of the document.
      inInlineCode = false;
      inlineCodeLen = 0;
      continue;
    }

    if (lineLeadingWhitespace && (ch === ' ' || ch === '\t')) {
      i += 1;
      continue;
    }

    const isFenceMarker = ch === '`' || ch === '~';
    if (lineLeadingWhitespace && isFenceMarker) {
      let run = 0;
      let j = i;
      while (j < limit && chars[j] === ch) {
        run += 1;
        j += 1;
      }
      if (run >= 3) {
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
          fenceLen = run;
        } else if (ch === fenceChar && run >= fenceLen && restOfLineIsBlank(chars, j, limit)) {
          // A valid closing fence carries no trailing info string; a line like
          // ```` ```extra ```` stays fence content and must not re-open scanning.
          inFence = false;
          fenceChar = '';
          fenceLen = 0;
        }
        i = j;
        lineLeadingWhitespace = false;
        continue;
      }
    }

    lineLeadingWhitespace = false;

    if (inFence) {
      i += 1;
      continue;
    }

    if (inInlineCode) {
      if (ch === '`') {
        let run = 0;
        let j = i;
        while (j < limit && chars[j] === '`') {
          run += 1;
          j += 1;
        }
        if (run === inlineCodeLen) {
          inInlineCode = false;
          inlineCodeLen = 0;
        }
        i = j;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '`') {
      let run = 0;
      let j = i;
      while (j < limit && chars[j] === '`') {
        run += 1;
        j += 1;
      }
      inInlineCode = true;
      inlineCodeLen = run;
      i = j;
      continue;
    }

    if (ch === '\\') {
      // Backslash escapes the next character; `\[[foo]]` is not a link.
      i += 2;
      continue;
    }

    if (ch === '[' && i + 1 < limit && chars[i + 1] === '[') {
      const close = findClosingBrackets(chars, i + 2, limit);
      if (close >= 0) {
        const inner = chars.slice(i + 2, close).join('');
        const targetPath = inner.includes('|') ? inner.slice(0, inner.indexOf('|')) : inner;
        matches.push({ targetPath, charIndex: i });
        i = close + 2;
        continue;
      }
      // No `]]` before the line ends: no opener on this line can close, so skip
      // to the newline rather than re-scanning from i+1 (which is O(n^2) on a
      // long run of unmatched `[[`).
      i = nextNewline(chars, i + 2, limit);
      continue;
    }

    i += 1;
  }

  return { matches, scanTruncated: truncated };
}

function findClosingBrackets(chars: string[], from: number, limit: number): number {
  for (let k = from; k + 1 < limit; k += 1) {
    if (chars[k] === ']' && chars[k + 1] === ']') return k;
    // A wikilink target never spans a newline.
    if (chars[k] === '\n') return -1;
  }
  return -1;
}

/** Index of the next `\n` at or after `from`, or `limit` if the line runs to the scan boundary. */
function nextNewline(chars: string[], from: number, limit: number): number {
  for (let k = from; k < limit; k += 1) {
    if (chars[k] === '\n') return k;
  }
  return limit;
}

/** True when the remainder of the current line (from `from` to the next `\n`) is only whitespace. */
function restOfLineIsBlank(chars: string[], from: number, limit: number): boolean {
  for (let k = from; k < limit; k += 1) {
    const c = chars[k];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

/**
 * Build the surrounding-prose context for a link's first occurrence: up to
 * LINK_CONTEXT_CHARS characters centred on the link, truncated at word
 * boundaries so a word is never cut mid-token.
 */
function buildContext(chars: string[], charIndex: number): string {
  const half = Math.floor(LINK_CONTEXT_CHARS / 2);
  let start = Math.max(0, charIndex - half);
  let end = Math.min(chars.length, charIndex + half);

  if (start > 0) {
    let s = start;
    while (s < charIndex && !/\s/.test(chars[s]!)) s += 1;
    while (s < charIndex && /\s/.test(chars[s]!)) s += 1;
    if (s < charIndex) start = s;
  }
  if (end < chars.length) {
    let e = end;
    while (e > charIndex && !/\s/.test(chars[e - 1]!)) e -= 1;
    while (e > charIndex && /\s/.test(chars[e - 1]!)) e -= 1;
    if (e > charIndex) end = e;
  }

  const raw = chars.slice(start, end).join('');
  // Drop the wikilink markup itself (target + label) — firstContext carries
  // surrounding prose only — then sanitize away control/bidi injection.
  const collapsed = sanitizeInjectedText(raw.replace(WIKILINK_SYNTAX, ' '));
  if (collapsed.length <= LINK_CONTEXT_CHARS) return collapsed;
  return truncateAtWordBoundary(collapsed, LINK_CONTEXT_CHARS);
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return slice.slice(0, lastSpace).trimEnd();
  return slice.trimEnd();
}

export function parseWikilinks(content: string, sourcePath: string): LinkParseResult {
  const chars = Array.from(content);
  const { matches, scanTruncated } = scanRawMatches(chars);

  const canonicalSource = canonicalizeTarget(sourcePath, sourcePath) ?? sourcePath;

  const byTarget = new Map<string, ParsedLink>();
  const contextIndex = new Map<string, number>();
  let nextOrdinal = 0;

  for (const match of matches) {
    const resolved = resolveTarget(match.targetPath, sourcePath);
    if (resolved === null) continue;
    const canonical = resolved.path;
    if (canonical === canonicalSource) continue;

    const existing = byTarget.get(canonical);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }

    const link: ParsedLink = {
      targetPath: canonical,
      ordinal: nextOrdinal,
      occurrenceCount: 1,
      ...(resolved.spelledPath !== undefined ? { spelledTargetPath: resolved.spelledPath } : {}),
    };
    nextOrdinal += 1;
    byTarget.set(canonical, link);
    contextIndex.set(canonical, match.charIndex);
  }

  let links = Array.from(byTarget.values()).sort((a, b) => a.ordinal - b.ordinal);

  let clamped = false;
  if (links.length > MAX_LINKS_PER_DOC) {
    links = links.slice(0, MAX_LINKS_PER_DOC);
    clamped = true;
  }

  for (const link of links) {
    const idx = contextIndex.get(link.targetPath);
    if (idx === undefined) continue;
    const context = buildContext(chars, idx);
    if (context.length > 0) link.firstContext = context;
  }

  return { links, clamped, scanTruncated };
}
