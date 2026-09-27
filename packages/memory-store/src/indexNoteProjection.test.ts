import { describe, it, expect } from 'vitest';
import { prepareDerivedIndexes } from './derivation.js';
import { assertIndexNoteHash, MemoryHashRequiredError, isIndexNotePath } from './indexNoteGuard.js';
import { INDEX_NOTE_MAX_ENTRIES } from './linkConstants.js';

const CONTROL = ''; // BEL
const RLO = '‮'; // right-to-left override

describe('prepareDerivedIndexes — /index.md projection', () => {
  it('persists a bounded, sanitized indexEntries projection for /index.md', () => {
    const content = [
      '# Index',
      '- [[/a.md]] the first doc',
      '- [[/b.md]] the second doc',
      'This is prose with no link — not an entry.',
      '- [[/c.md]] and [[/d.md]] two links — not an entry (needs exactly one).',
    ].join('\n');

    const { derivation } = prepareDerivedIndexes(content, 'markdown', '/index.md');
    expect(derivation.indexEntries).toEqual([
      { path: '/a.md', hook: 'the first doc' },
      { path: '/b.md', hook: 'the second doc' },
    ]);
    expect(derivation.omittedEntries).toBeUndefined();
  });

  it('trims the leading list bullet and the hook separator (- [[/x]] — hook → hook)', () => {
    const content = [
      '- [[/a.md]] — the first doc',
      '* [[/b.md]]: a colon separator',
      '1. [[/c.md]] no separator',
      '[[/d.md]] — bulletless with separator',
    ].join('\n');
    const { derivation } = prepareDerivedIndexes(content, 'markdown', '/index.md');
    expect(derivation.indexEntries).toEqual([
      { path: '/a.md', hook: 'the first doc' },
      { path: '/b.md', hook: 'a colon separator' },
      { path: '/c.md', hook: 'no separator' },
      { path: '/d.md', hook: 'bulletless with separator' },
    ]);
  });

  it('sanitizes hooks (strips control/bidi) and caps hook length via the parser', () => {
    const content = `- [[/x.md]] before${CONTROL}${RLO}after ${'y'.repeat(400)}`;
    const { derivation } = prepareDerivedIndexes(content, 'markdown', '/index.md');
    const entry = derivation.indexEntries?.[0];
    expect(entry?.path).toBe('/x.md');
    expect(entry?.hook).not.toContain(CONTROL);
    expect(entry?.hook).not.toContain(RLO);
    expect(entry?.hook.length).toBeLessThanOrEqual(160);
  });

  it('caps entries at the parser max and records omittedEntries when exceeded', () => {
    const overBy = 7;
    const lines: string[] = [];
    for (let i = 0; i < INDEX_NOTE_MAX_ENTRIES + overBy; i++) {
      lines.push(`- [[/doc-${String(i)}.md]] entry ${String(i)}`);
    }
    const { derivation } = prepareDerivedIndexes(lines.join('\n'), 'markdown', '/index.md');
    expect(derivation.indexEntries).toHaveLength(INDEX_NOTE_MAX_ENTRIES);
    expect(derivation.omittedEntries).toBe(overBy);
  });

  it('does NOT project for non-/index.md docs', () => {
    const content = '- [[/a.md]] the first doc';
    const { derivation } = prepareDerivedIndexes(content, 'markdown', '/notes/other.md');
    expect(derivation.indexEntries).toBeUndefined();
    expect(derivation.omittedEntries).toBeUndefined();
  });

  it('projects for NON-CANONICAL /index.md spellings that resolve to the canonical row', () => {
    const content = '- [[/a.md]] the first doc';
    // Each spelling canonicalizes to /index.md (the row the doc actually lands on).
    for (const spelling of [
      'index.md',
      '//index.md',
      '/index.md/',
      '/./index.md',
      '/a/../index.md',
    ]) {
      const { derivation } = prepareDerivedIndexes(content, 'markdown', spelling);
      expect(derivation.indexEntries, spelling).toEqual([{ path: '/a.md', hook: 'the first doc' }]);
    }
  });
});

describe('assertIndexNoteHash — shared-curation guard', () => {
  it('requires expectedHash when /index.md already exists', () => {
    expect(() =>
      assertIndexNoteHash({ path: '/index.md', docExists: true, expectedHash: undefined }),
    ).toThrow(MemoryHashRequiredError);
  });

  it('allows a first create of /index.md without a hash', () => {
    expect(() =>
      assertIndexNoteHash({ path: '/index.md', docExists: false, expectedHash: undefined }),
    ).not.toThrow();
  });

  it('allows an update carrying a hash', () => {
    expect(() =>
      assertIndexNoteHash({ path: '/index.md', docExists: true, expectedHash: 'abc123' }),
    ).not.toThrow();
  });

  it('is inert for non-/index.md paths', () => {
    expect(isIndexNotePath('/notes/a.md')).toBe(false);
    expect(() =>
      assertIndexNoteHash({ path: '/notes/a.md', docExists: true, expectedHash: undefined }),
    ).not.toThrow();
  });

  it('fires the guard for NON-CANONICAL /index.md spellings (they land on the same row)', () => {
    for (const spelling of [
      'index.md',
      '//index.md',
      '/index.md/',
      '/./index.md',
      '/a/../index.md',
    ]) {
      expect(isIndexNotePath(spelling), spelling).toBe(true);
      expect(
        () => assertIndexNoteHash({ path: spelling, docExists: true, expectedHash: undefined }),
        spelling,
      ).toThrow(MemoryHashRequiredError);
    }
  });
});
