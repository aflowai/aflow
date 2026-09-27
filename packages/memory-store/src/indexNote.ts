import {
  INDEX_ENTRY_HOOK_CHARS,
  INDEX_ENTRY_PATH_CHARS,
  INDEX_NOTE_MAX_ENTRIES,
} from './linkConstants.js';
import { parseWikilinks, sanitizeInjectedText, WIKILINK_SYNTAX } from './links.js';

/** Canonical path of a space's memory-map note. */
export const INDEX_NOTE_PATH = '/index.md';

export interface IndexEntry {
  path: string;
  hook: string;
}

export interface IndexParseResult {
  entries: IndexEntry[];
  omittedEntries: number;
}

/**
 * A hook is injected verbatim into a system-role message, so it is sanitized
 * (control/bidi/NUL stripped, whitespace collapsed) and truncated to the hook
 * budget before it can reach agent context.
 */
function sanitizeHook(raw: string): string {
  return truncateHook(sanitizeInjectedText(raw), INDEX_ENTRY_HOOK_CHARS);
}

/**
 * Truncate to a UTF-16 code-unit budget (never splitting a surrogate pair) so
 * the hook satisfies the downstream `z.string().max()` schema, which measures
 * length in code units, not code points.
 */
function truncateHook(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const code = text.charCodeAt(end - 1);
  // Drop a trailing high surrogate that would otherwise be split from its pair.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

const INLINE_CODE_SPAN = /`+[^`]*`+/g;

interface FenceMarker {
  char: string;
  /** True when only whitespace follows the marker run — required to CLOSE a fence. */
  bare: boolean;
}

/**
 * Return the fence marker (`` ` `` or `~`) when a line is a leading run of three
 * or more of the same marker, otherwise null. `bare` distinguishes a valid
 * closing fence (nothing but whitespace after the run) from an opener that may
 * carry an info string — a line like ```` ```extra ```` never closes a block.
 */
function fenceMarkerOf(line: string): FenceMarker | null {
  const stripped = line.replace(/^[ \t]+/, '');
  const first = stripped[0];
  if (first !== '`' && first !== '~') return null;
  let run = 0;
  while (run < stripped.length && stripped[run] === first) run += 1;
  if (run < 3) return null;
  return { char: first, bare: stripped.slice(run).trim().length === 0 };
}

/** Leading list bullet (`- `, `* `, `+ `, `1. `, `1) `) on a Map-of-Content line. */
const LEADING_LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** Leading hook separator left after the wikilink is removed (`—`, `–`, `-`, `:`, `|`). */
const LEADING_HOOK_SEPARATOR = /^\s*[—–\-:|]+\s*/;

/**
 * Reduce a qualifying line to its human summary: inline code spans (which the
 * scanner already excludes from link detection) and the wikilink syntax itself
 * are structure, not prose, so both are removed. A Map-of-Content line reads
 * `- [[/path]] — hook`, so once the wikilink is gone the leading list bullet and
 * the `—`/`:`/`-` separator between it and the hook are structure too — strip
 * them so the hook is the prose alone (`hook`), not `- — hook`.
 */
function hookProse(line: string): string {
  return line
    .replace(INLINE_CODE_SPAN, ' ')
    .replace(WIKILINK_SYNTAX, ' ')
    .replace(LEADING_LIST_MARKER, '')
    .replace(LEADING_HOOK_SEPARATOR, '');
}

/**
 * Parse the lines of an `/index.md` note into `{ path, hook }` entries. A line
 * qualifies only when it carries exactly one wikilink (fence/code-aware via the
 * shared scanner); its remaining prose becomes the sanitized hook. Entries past
 * INDEX_NOTE_MAX_ENTRIES are counted in `omittedEntries` and not returned.
 */
export function parseIndexNote(content: string): IndexParseResult {
  const entries: IndexEntry[] = [];
  let omittedEntries = 0;

  let fenceChar: string | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const fence = fenceMarkerOf(line);
    if (fenceChar !== null) {
      // Only a bare same-marker line closes the block; ```` ```extra ```` is content.
      if (fence !== null && fence.char === fenceChar && fence.bare) fenceChar = null;
      continue;
    }
    if (fence !== null) {
      fenceChar = fence.char;
      continue;
    }

    const parsed = parseWikilinks(line, '/index.md');
    const totalWikilinks = parsed.links.reduce((sum, link) => sum + link.occurrenceCount, 0);
    if (totalWikilinks !== 1) continue;

    const link = parsed.links[0];
    if (link === undefined) continue;

    // The entry path is a second free-form channel into agent context. A real
    // canonical memory path is short; a target beyond the budget is an injection
    // payload, not a doc reference — drop it (counted as omitted), never truncate
    // into a misleading coordinate.
    if (link.targetPath.length > INDEX_ENTRY_PATH_CHARS) {
      omittedEntries += 1;
      continue;
    }

    const hook = sanitizeHook(hookProse(line));

    if (entries.length >= INDEX_NOTE_MAX_ENTRIES) {
      omittedEntries += 1;
      continue;
    }
    entries.push({ path: link.targetPath, hook });
  }

  return { entries, omittedEntries };
}
