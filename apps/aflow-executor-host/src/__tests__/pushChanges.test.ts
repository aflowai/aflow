/**
 * Contract: what a push changes is counted by the caller's own areas — globs
 * over repository-relative paths, `*` within one directory and `**` across
 * any number — and a binary file is a file with no lines.
 */
import { describe, expect, it } from 'vitest';

import { countChanges, globMatcher } from '../pushChanges.js';

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

describe('countChanges', () => {
  it('counts files and lines in all and within each area, a file in two areas counted in both', () => {
    const changes = countChanges(
      [
        { path: 'packages/schemas/src/a.test.ts', lines: 4 },
        { path: 'docs/plans/x.md', lines: 20 },
        { path: 'apps/web/logo.png', lines: 0 },
      ],
      {
        deep: ['packages/schemas/**'],
        light: ['docs/**', '**/*.test.*'],
        none: ['nothing/**'],
      },
    );
    expect(changes).toEqual({
      files: 3,
      lines: 24,
      areas: {
        deep: { files: 1, lines: 4 },
        light: { files: 2, lines: 24 },
        none: { files: 0, lines: 0 },
      },
    });
  });
});
