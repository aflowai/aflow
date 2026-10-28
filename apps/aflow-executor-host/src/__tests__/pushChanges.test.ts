/**
 * Contract: what a push changes is counted by the caller's own areas — globs
 * over repository-relative paths, `*` within one directory and `**` across
 * any number — and a binary file, which a diff gives no lines, counts at a
 * floor so a push of binaries alone never reads as small.
 */
import { describe, expect, it } from 'vitest';

import { HOST_BINARY_FILE_LINES } from '@aflow/schemas';
import { REVIEW_DEPTH_AREAS } from '../../../../packages/platform-artifacts/src/skillCatalog/publishLocalChangesReview.js';

import { countChanges, globMatcher, parseNumstat } from '../pushChanges.js';

describe('globMatcher', () => {
  it('reads `**` across directories, zero included, and `*` within one', () => {
    const tree = globMatcher('packages/schemas/**');
    expect(tree.test('packages/schemas/src/operations/host.ts')).toBe(true);
    expect(tree.test('packages/schemas-extra/x.ts')).toBe(false);

    const anyMarkdown = globMatcher('**/*.md');
    expect(anyMarkdown.test('README.md')).toBe(true);
    expect(anyMarkdown.test('docs/plans/315.md')).toBe(true);
    expect(anyMarkdown.test('docs/plans/315.mdx')).toBe(false);

    const tests = globMatcher('**/*.test.*');
    expect(tests.test('scripts/check.test.mjs')).toBe(true);
    expect(tests.test('apps/a/src/__tests__/x.ts')).toBe(false);

    expect(globMatcher('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globMatcher('a?c').test('abc')).toBe(true);
    // Regex characters in a path are taken literally.
    expect(globMatcher('a+b.(x)').test('a+b.(x)')).toBe(true);
    expect(globMatcher('a+b.(x)').test('aab.(x)')).toBe(false);
  });
});

describe('parseNumstat', () => {
  it('counts a text file by its lines and a binary file at the floor', () => {
    const output = ['3\t2\tsrc/a.ts', '-\t-\tassets/logo.png', '0\t0\tempty.txt', ''].join('\0');
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', lines: 5 },
      { path: 'assets/logo.png', lines: HOST_BINARY_FILE_LINES },
      { path: 'empty.txt', lines: 0 },
    ]);
  });
});

describe('countChanges', () => {
  it.each(['CLAUDE.md', 'AGENTS.md', 'src/CLAUDE.md', 'docs/AGENTS.md'])(
    'counts %s as sensitive code while ordinary docs remain light',
    (path) => {
      const instructions = countChanges([{ path, lines: 1 }], REVIEW_DEPTH_AREAS);
      expect(instructions.areas['deep']).toEqual({ files: 1, lines: 1 });
      const docs = countChanges(
        [
          { path: 'README.md', lines: 1 },
          { path: 'docs/guide.md', lines: 1 },
        ],
        REVIEW_DEPTH_AREAS,
      );
      expect(docs.areas['deep']).toEqual({ files: 0, lines: 0 });
      expect(docs.areas['light']).toEqual({ files: 2, lines: 2 });
    },
  );

  it('counts files and lines in all and within each area, a file in two areas counted in both', () => {
    const changes = countChanges(
      [
        { path: 'packages/schemas/src/a.test.ts', lines: 4 },
        { path: 'docs/plans/x.md', lines: 20 },
        { path: 'apps/web/logo.png', lines: HOST_BINARY_FILE_LINES },
      ],
      {
        deep: ['packages/schemas/**'],
        light: ['docs/**', '**/*.test.*'],
        none: ['nothing/**'],
      },
    );
    expect(changes).toEqual({
      files: 3,
      lines: 24 + HOST_BINARY_FILE_LINES,
      areas: {
        deep: { files: 1, lines: 4 },
        light: { files: 2, lines: 24 },
        none: { files: 0, lines: 0 },
      },
    });
  });
});
