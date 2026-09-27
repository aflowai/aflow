import { describe, it, expect } from 'vitest';
import { unifiedDiffLines } from './line-diff';

const render = (lines: ReturnType<typeof unifiedDiffLines>): string[] =>
  lines.map(
    (line) => `${{ context: ' ', added: '+', removed: '-', skip: '…' }[line.kind]}${line.text}`,
  );

describe('unifiedDiffLines', () => {
  it('reports a changed line as removed + added with surrounding context', () => {
    const lines = unifiedDiffLines('a\nb\nc', 'a\nB\nc');
    expect(render(lines)).toEqual([' a', '-b', '+B', ' c']);
  });

  it('handles pure additions and removals', () => {
    expect(render(unifiedDiffLines('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c']);
    expect(render(unifiedDiffLines('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c']);
  });

  it('returns only context for identical inputs', () => {
    const lines = unifiedDiffLines('a\nb', 'a\nb');
    expect(lines.every((line) => line.kind === 'context')).toBe(true);
  });

  it('collapses long unchanged runs into a skip marker', () => {
    const shared = Array.from({ length: 20 }, (_, i) => `line-${String(i)}`).join('\n');
    const lines = unifiedDiffLines(`start\n${shared}`, `START\n${shared}`);
    const skip = lines.find((line) => line.kind === 'skip');
    expect(skip?.text).toContain('unchanged lines');
    expect(lines.filter((line) => line.kind === 'context')).toHaveLength(6);
  });
});
