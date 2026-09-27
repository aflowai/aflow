import { describe, it, expect } from 'vitest';
import { parseWikilinks, canonicalizeTarget } from './links.js';
import {
  LINK_SCAN_BYTES,
  LINK_TARGET_MAX_BYTES,
  MAX_LINKS_PER_DOC,
  LINK_CONTEXT_CHARS,
} from './linkConstants.js';

const SRC = '/notes/source.md';

const NUL = '\u0000';
const C0 = '\u0007'; // BEL
const DEL = '\u007F';
const C1 = '\u0085'; // NEL
const RLO = '\u202E'; // right-to-left override
const LRI = '\u2066'; // left-to-right isolate
const PDI = '\u2069'; // pop directional isolate
const ZWSP = '\u200B'; // zero-width space
const LRM = '\u200E'; // left-to-right mark
const RLM = '\u200F'; // right-to-left mark
const ALM = '\u061C'; // arabic letter mark
const WJ = '\u2060'; // word joiner
const BOM = '\uFEFF'; // zero-width no-break space / BOM

function targets(content: string, source = SRC): string[] {
  return parseWikilinks(content, source).links.map((l) => l.targetPath);
}

// ============================================================================
// canonicalizeTarget
// ============================================================================

describe('canonicalizeTarget', () => {
  it('resolves a relative target against the source directory', () => {
    expect(canonicalizeTarget('sibling', '/notes/source.md')).toBe('/notes/sibling.md');
  });

  it('treats a leading-slash target as absolute', () => {
    expect(canonicalizeTarget('/other/foo', '/notes/source.md')).toBe('/other/foo.md');
  });

  it('collapses . and .. segments', () => {
    // Source dir is /notes/deep; `..` climbs to /notes, then a/b is appended.
    expect(canonicalizeTarget('../a/./b', '/notes/deep/source.md')).toBe('/notes/a/b.md');
    expect(canonicalizeTarget('sub/./a/../b', '/notes/deep/source.md')).toBe(
      '/notes/deep/sub/b.md',
    );
  });

  it('never escapes the root with excess ..', () => {
    expect(canonicalizeTarget('../../../../etc/passwd', '/notes/source.md')).toBe('/etc/passwd.md');
  });

  it('a bare .. at root stays at root', () => {
    expect(canonicalizeTarget('/../foo', '/notes/source.md')).toBe('/foo.md');
  });

  it('appends .md to an extensionless final segment', () => {
    expect(canonicalizeTarget('/notes/foo', SRC)).toBe('/notes/foo.md');
  });

  it('leaves a segment that already has an extension alone', () => {
    expect(canonicalizeTarget('/data/table.json', SRC)).toBe('/data/table.json');
    expect(canonicalizeTarget('/x/report.md', SRC)).toBe('/x/report.md');
  });

  it('treats a dotfile (leading dot only) as extensionless', () => {
    // `.keep` has no extension boundary — the leading dot is a visibility marker.
    expect(canonicalizeTarget('/config/.keep', SRC)).toBe('/config/.keep.md');
    expect(canonicalizeTarget('/.gitignore', SRC)).toBe('/.gitignore.md');
  });

  it('keeps an extension that follows a dotfile prefix', () => {
    expect(canonicalizeTarget('/config/.env.local', SRC)).toBe('/config/.env.local');
  });

  it('treats a trailing-dot segment as extensionless (verbatim append)', () => {
    expect(canonicalizeTarget('/notes/foo.', SRC)).toBe('/notes/foo..md');
  });

  it('rejects an empty / whitespace-only target', () => {
    expect(canonicalizeTarget('', SRC)).toBeNull();
    expect(canonicalizeTarget('   ', SRC)).toBeNull();
  });

  it('rejects a target that collapses to nothing', () => {
    expect(canonicalizeTarget('/', SRC)).toBeNull();
    expect(canonicalizeTarget('..', '/source.md')).toBeNull();
  });

  it('rejects a target exceeding the utf8 byte cap', () => {
    const big = 'a'.repeat(LINK_TARGET_MAX_BYTES + 1);
    expect(canonicalizeTarget(big, SRC)).toBeNull();
  });

  it('accepts a target exactly at the byte cap', () => {
    const atCap = '/' + 'a'.repeat(LINK_TARGET_MAX_BYTES - 1);
    expect(Buffer.byteLength(atCap, 'utf8')).toBe(LINK_TARGET_MAX_BYTES);
    expect(canonicalizeTarget(atCap, SRC)).not.toBeNull();
  });

  it('counts utf8 bytes, not chars, for the cap', () => {
    const emoji = '\u{1F600}'.repeat(300); // 300 code points, 1200 bytes
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(LINK_TARGET_MAX_BYTES);
    expect(canonicalizeTarget(emoji, SRC)).toBeNull();
  });

  it('rejects a target with a NUL byte', () => {
    expect(canonicalizeTarget(`foo${NUL}bar`, SRC)).toBeNull();
  });

  it('rejects a target with C0 control chars', () => {
    expect(canonicalizeTarget(`foo${C0}bar`, SRC)).toBeNull();
  });

  it('rejects a target with a DEL char', () => {
    expect(canonicalizeTarget(`foo${DEL}bar`, SRC)).toBeNull();
  });

  it('rejects a target with C1 control chars', () => {
    expect(canonicalizeTarget(`foo${C1}bar`, SRC)).toBeNull();
  });

  it('allows normal outer whitespace — it is trimmed, not rejected', () => {
    expect(canonicalizeTarget('  /notes/foo  ', SRC)).toBe('/notes/foo.md');
  });

  it('rejects a target with bidi-override / isolate chars', () => {
    expect(canonicalizeTarget(`foo${RLO}bar`, SRC)).toBeNull();
    expect(canonicalizeTarget(`foo${LRI}bar`, SRC)).toBeNull();
    expect(canonicalizeTarget(`foo${PDI}bar`, SRC)).toBeNull();
  });

  it('rejects a target with invisible / directional-mark format chars', () => {
    for (const invisible of [ZWSP, LRM, RLM, ALM, WJ, BOM]) {
      expect(canonicalizeTarget(`foo${invisible}bar`, SRC)).toBeNull();
    }
  });

  it('rejects a target with an interior TAB (not stripped by trimming)', () => {
    expect(canonicalizeTarget('foo\tbar', SRC)).toBeNull();
  });

  it('rejects a target with an interior CR (not stripped by trimming)', () => {
    expect(canonicalizeTarget('foo\rbar', SRC)).toBeNull();
  });

  it('rejects a target containing unescaped wikilink brackets', () => {
    expect(canonicalizeTarget('[[a', SRC)).toBeNull();
    expect(canonicalizeTarget('a]]b', SRC)).toBeNull();
  });
});

// ============================================================================
// parseWikilinks — grammar
// ============================================================================

describe('parseWikilinks — basic grammar', () => {
  it('parses a bare [[target]]', () => {
    expect(targets('see [[/notes/foo]] here')).toEqual(['/notes/foo.md']);
  });

  it('parses the label form [[a|b]] using only the target', () => {
    expect(targets('see [[/notes/foo|Foo Label]] here')).toEqual(['/notes/foo.md']);
  });

  it('does not store the label separately', () => {
    const { links } = parseWikilinks('see [[/notes/foo|Foo Label]]', SRC);
    expect(links).toHaveLength(1);
    expect(Object.keys(links[0]!)).not.toContain('label');
  });

  it('resolves relative targets against the source directory', () => {
    expect(targets('[[sibling]]')).toEqual(['/notes/sibling.md']);
  });

  it('parses multiple distinct links in document order', () => {
    expect(targets('[[/a]] then [[/b]] then [[/c]]')).toEqual(['/a.md', '/b.md', '/c.md']);
  });
});

// ============================================================================
// parseWikilinks — fence / code / escape exclusion
// ============================================================================

describe('parseWikilinks — code exclusion', () => {
  it('ignores wikilinks inside a ``` fenced block', () => {
    const content = ['before [[/real]]', '```', 'code [[/fake]]', '```', 'after [[/other]]'].join(
      '\n',
    );
    expect(targets(content)).toEqual(['/real.md', '/other.md']);
  });

  it('ignores wikilinks inside a ~~~ fenced block', () => {
    const content = ['[[/real]]', '~~~', '[[/fake]]', '~~~', '[[/other]]'].join('\n');
    expect(targets(content)).toEqual(['/real.md', '/other.md']);
  });

  it('the CRITICAL bash-guard case: [[ -f x ]] inside a fence is not a link', () => {
    const content = ['```bash', 'if [[ -f x ]]; then echo hi; fi', '```'].join('\n');
    expect(targets(content)).toEqual([]);
  });

  it('a longer closing fence than opening still closes', () => {
    const content = ['```', '[[/fake]]', '`````', '[[/real]]'].join('\n');
    expect(targets(content)).toEqual(['/real.md']);
  });

  it('a backtick fence with trailing text does NOT close (CommonMark)', () => {
    const content = ['```', '[[/fake]]', '```extra', '[[/stillfake]]', '```'].join('\n');
    expect(targets(content)).toEqual([]);
  });

  it('a wikilink after a non-closing ```x line stays excluded', () => {
    const content = ['```', '[[/a]]', '```x', '[[/b]]'].join('\n');
    expect(targets(content)).toEqual([]);
  });

  it('handles CRLF-delimited fences', () => {
    const content = '```\r\n[[/fake]]\r\n```\r\n[[/real]]';
    expect(targets(content)).toEqual(['/real.md']);
  });

  it('treats a mid-line triple backtick as an inline span, not a fence', () => {
    expect(targets('inline ```x [[/fake]] y``` then [[/real]]')).toEqual(['/real.md']);
  });

  it('a ``` fence is not closed by a ~~~ line', () => {
    const content = ['```', '[[/fake]]', '~~~', '[[/stillfake]]', '```', '[[/real]]'].join('\n');
    expect(targets(content)).toEqual(['/real.md']);
  });

  it('ignores wikilinks inside inline code spans', () => {
    expect(targets('use `[[/fake]]` but link [[/real]]')).toEqual(['/real.md']);
  });

  it('handles multi-backtick inline code spans', () => {
    expect(targets('``code with ` and [[/fake]]`` then [[/real]]')).toEqual(['/real.md']);
  });

  it('an inline code span does not span across a newline', () => {
    const content = 'text ` unterminated\n[[/real]]';
    expect(targets(content)).toEqual(['/real.md']);
  });

  it('ignores backslash-escaped \\[[...]]', () => {
    expect(targets('escaped \\[[/fake]] and real [[/real]]')).toEqual(['/real.md']);
  });

  it('parses a link after a resolved fenced block correctly', () => {
    const content = ['```', 'x', '```', '', 'Real link: [[/notes/topic]]'].join('\n');
    expect(targets(content)).toEqual(['/notes/topic.md']);
  });

  it('indented fence markers still count as fences', () => {
    const content = ['  ```', '  [[/fake]]', '  ```', '[[/real]]'].join('\n');
    expect(targets(content)).toEqual(['/real.md']);
  });
});

// ============================================================================
// parseWikilinks — self-link drop
// ============================================================================

describe('parseWikilinks — self-links', () => {
  it('drops a link whose target canonicalizes to the source path', () => {
    expect(targets('[[/notes/source]] and [[/notes/other]]')).toEqual(['/notes/other.md']);
  });

  it('drops a relative self-link', () => {
    expect(targets('[[source]] and [[other]]')).toEqual(['/notes/other.md']);
  });
});

// ============================================================================
// parseWikilinks — dedup + ordinal
// ============================================================================

describe('parseWikilinks — dedup and ordinal determinism', () => {
  it('collapses duplicate targets into one link with occurrenceCount', () => {
    const { links } = parseWikilinks('[[/a]] [[/b]] [[/a]] [[/a]]', SRC);
    expect(links).toHaveLength(2);
    const a = links.find((l) => l.targetPath === '/a.md')!;
    expect(a.occurrenceCount).toBe(3);
    const b = links.find((l) => l.targetPath === '/b.md')!;
    expect(b.occurrenceCount).toBe(1);
  });

  it('ordinal reflects order of first accepted occurrence', () => {
    const { links } = parseWikilinks('[[/b]] [[/a]] [[/b]]', SRC);
    const b = links.find((l) => l.targetPath === '/b.md')!;
    const a = links.find((l) => l.targetPath === '/a.md')!;
    expect(b.ordinal).toBe(0);
    expect(a.ordinal).toBe(1);
  });

  it('ordinals are contiguous and count only accepted links', () => {
    const content = `[[source]] [[/a]] [[foo${NUL}bar]] [[/b]]`;
    const { links } = parseWikilinks(content, SRC);
    expect(links.map((l) => [l.targetPath, l.ordinal])).toEqual([
      ['/a.md', 0],
      ['/b.md', 1],
    ]);
  });

  it('two spellings that canonicalize to the same path dedup together', () => {
    const { links } = parseWikilinks('[[/notes/x]] [[x]]', SRC);
    expect(links).toHaveLength(1);
    expect(links[0]!.occurrenceCount).toBe(2);
  });
});

// ============================================================================
// parseWikilinks — canonicalization inside parsing
// ============================================================================

describe('parseWikilinks — canonicalization', () => {
  it('normalizes .. in a link target', () => {
    expect(targets('[[../topic]]', '/notes/deep/src.md')).toEqual(['/notes/topic.md']);
  });

  it('root-escape is clamped', () => {
    expect(targets('[[../../../../x]]')).toEqual(['/x.md']);
  });

  it('preserves an explicit extension', () => {
    expect(targets('[[/data/rows.csv]]')).toEqual(['/data/rows.csv']);
  });
});

// ============================================================================
// parseWikilinks — target rejection
// ============================================================================

describe('parseWikilinks — target rejection', () => {
  it('silently skips an over-cap target (no diagnostic, not a link)', () => {
    const big = 'x'.repeat(LINK_TARGET_MAX_BYTES + 5);
    expect(targets(`[[${big}]] [[/real]]`)).toEqual(['/real.md']);
  });

  it('silently skips a NUL-bearing target', () => {
    expect(targets(`[[foo${NUL}bar]] [[/real]]`)).toEqual(['/real.md']);
  });

  it('silently skips a bidi-override target', () => {
    expect(targets(`[[foo${RLO}bar]] [[/real]]`)).toEqual(['/real.md']);
  });

  it('silently skips an empty target [[]]', () => {
    expect(targets('[[]] [[/real]]')).toEqual(['/real.md']);
  });

  it('silently skips a target with an interior CR', () => {
    expect(targets('link [[foo\rbar]] and [[/real]]')).toEqual(['/real.md']);
  });

  it('silently skips a target with an interior TAB', () => {
    expect(targets('[[foo\tbar]] [[/real]]')).toEqual(['/real.md']);
  });

  it('does not leak nested opening brackets into a target', () => {
    expect(targets('[[[[a]]]] real [[/real]]')).toEqual(['/real.md']);
  });

  it('drops a garbage target with interior brackets/space, keeping the clean link', () => {
    // The first `]]` closes the opener, yielding an inner with `[[` — bracket
    // noise is rejected, so only the clean link survives.
    expect(targets('[[/a [[/b]] c]] real [[/real]]')).toEqual(['/real.md']);
  });
});

// ============================================================================
// parseWikilinks — scan truncation
// ============================================================================

describe('parseWikilinks — LINK_SCAN_BYTES truncation', () => {
  it('does not set scanTruncated for small content', () => {
    const res = parseWikilinks('[[/a]]', SRC);
    expect(res.scanTruncated).toBe(false);
  });

  it('sets scanTruncated and ignores links beyond the byte budget', () => {
    const filler = 'x'.repeat(LINK_SCAN_BYTES);
    const content = `[[/early]]${filler}[[/late]]`;
    const res = parseWikilinks(content, SRC);
    expect(res.scanTruncated).toBe(true);
    expect(res.links.map((l) => l.targetPath)).toEqual(['/early.md']);
  });

  it('does not truncate content exactly at the byte budget', () => {
    const content = 'a'.repeat(LINK_SCAN_BYTES);
    expect(Buffer.byteLength(content, 'utf8')).toBe(LINK_SCAN_BYTES);
    const res = parseWikilinks(content, SRC);
    expect(res.scanTruncated).toBe(false);
  });
});

// ============================================================================
// parseWikilinks — MAX_LINKS clamp
// ============================================================================

describe('parseWikilinks — MAX_LINKS_PER_DOC clamp', () => {
  it('keeps the first MAX_LINKS_PER_DOC distinct links and sets clamped', () => {
    const parts: string[] = [];
    for (let i = 0; i < MAX_LINKS_PER_DOC + 20; i += 1) {
      parts.push(`[[/n/${String(i)}]]`);
    }
    const res = parseWikilinks(parts.join(' '), SRC);
    expect(res.clamped).toBe(true);
    expect(res.links).toHaveLength(MAX_LINKS_PER_DOC);
    expect(res.links[0]!.targetPath).toBe('/n/0.md');
    expect(res.links[MAX_LINKS_PER_DOC - 1]!.targetPath).toBe(
      `/n/${String(MAX_LINKS_PER_DOC - 1)}.md`,
    );
  });

  it('does not set clamped at exactly MAX_LINKS_PER_DOC', () => {
    const parts: string[] = [];
    for (let i = 0; i < MAX_LINKS_PER_DOC; i += 1) {
      parts.push(`[[/n/${String(i)}]]`);
    }
    const res = parseWikilinks(parts.join(' '), SRC);
    expect(res.clamped).toBe(false);
    expect(res.links).toHaveLength(MAX_LINKS_PER_DOC);
  });

  it('counts distinct targets, not occurrences, toward the clamp', () => {
    // One target repeated many times is a single link, never clamped.
    const res = parseWikilinks('[[/a]] '.repeat(MAX_LINKS_PER_DOC + 50), SRC);
    expect(res.clamped).toBe(false);
    expect(res.links).toHaveLength(1);
    expect(res.links[0]!.occurrenceCount).toBe(MAX_LINKS_PER_DOC + 50);
  });
});

// ============================================================================
// parseWikilinks — firstContext
// ============================================================================

describe('parseWikilinks — firstContext', () => {
  it('captures surrounding prose around the first occurrence', () => {
    const { links } = parseWikilinks('The quick brown [[/fox]] jumps over.', SRC);
    expect(links[0]!.firstContext).toBeDefined();
    expect(links[0]!.firstContext).toContain('quick');
    expect(links[0]!.firstContext).toContain('jumps');
  });

  it('collapses whitespace in the context', () => {
    const { links } = parseWikilinks('a\n\n  b   [[/x]]   c\n\nd', SRC);
    expect(links[0]!.firstContext).not.toMatch(/\n/);
    expect(links[0]!.firstContext).not.toMatch(/ {2,}/);
  });

  it('caps context length at LINK_CONTEXT_CHARS', () => {
    const before = 'word '.repeat(200);
    const after = ' end';
    const { links } = parseWikilinks(`${before}[[/x]]${after}`, SRC);
    expect(links[0]!.firstContext!.length).toBeLessThanOrEqual(LINK_CONTEXT_CHARS);
  });

  it('truncates at a word boundary (never exceeds the cap)', () => {
    const longWord = 'z'.repeat(LINK_CONTEXT_CHARS + 50);
    const content = `${longWord} [[/x]]`;
    const { links } = parseWikilinks(content, SRC);
    const ctx = links[0]!.firstContext!;
    expect(ctx.length).toBeLessThanOrEqual(LINK_CONTEXT_CHARS);
  });

  it('uses the first occurrence for context on a duplicated target', () => {
    const { links } = parseWikilinks('FIRST here [[/dup]] ... SECOND here [[/dup]]', SRC);
    expect(links[0]!.firstContext).toContain('FIRST');
  });

  it('anchors context on the FIRST occurrence, not the last, across a wide gap', () => {
    const content = `AAA [[/dup]] BBB ${'z'.repeat(400)} CCC [[/dup]] DDD`;
    const { links } = parseWikilinks(content, SRC);
    const ctx = links[0]!.firstContext!;
    expect(ctx).toContain('AAA');
    expect(ctx).not.toContain('DDD');
  });

  it('pins the exact whitespace-collapsed context string', () => {
    const { links } = parseWikilinks('The quick brown [[/fox]] jumps over.', SRC);
    expect(links[0]!.firstContext).toBe('The quick brown jumps over.');
  });

  it('does not carry the wikilink markup or label text into firstContext', () => {
    const { links } = parseWikilinks('alpha beta [[/x|Label]] gamma delta', SRC);
    const ctx = links[0]!.firstContext!;
    expect(ctx).not.toContain('[[');
    expect(ctx).not.toContain(']]');
    expect(ctx).not.toContain('Label');
    expect(ctx).toBe('alpha beta gamma delta');
  });

  it('sanitizes control / bidi / NUL / terminal-escape sequences out of firstContext', () => {
    const content = `before \x1b]0;pwn\x07 ${NUL} ${RLO} evil [[/good]] after`;
    const { links } = parseWikilinks(content, SRC);
    const ctx = links[0]!.firstContext!;
    for (const ch of ctx) {
      const cp = ch.codePointAt(0)!;
      const isControl = cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
      const isBidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
      expect(isControl || isBidi).toBe(false);
    }
    expect(ctx).not.toContain('\x1b');
    expect(ctx).not.toContain(NUL);
    expect(ctx).not.toContain(RLO);
  });
});

// ============================================================================
// parseWikilinks — pathological input (no quadratic blowup)
// ============================================================================

describe('parseWikilinks — pathological input performance', () => {
  it('handles a long run of unclosed [[ in near-linear time', () => {
    const t0 = performance.now();
    const res = parseWikilinks('[['.repeat(200000), SRC);
    const elapsed = performance.now() - t0;
    expect(res.links).toEqual([]);
    // An unmatched `[[` can never become a link; re-scanning from i+1 would be
    // O(n^2). The advance-to-newline fix keeps this well under a second.
    expect(elapsed).toBeLessThan(1000);
  });

  it('handles many unclosed [[ separated by prose without blowup', () => {
    const t0 = performance.now();
    const res = parseWikilinks(('[[' + 'x'.repeat(100)).repeat(50000), SRC);
    const elapsed = performance.now() - t0;
    expect(res.links).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });
});
