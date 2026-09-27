export type DiffLineKind = 'context' | 'added' | 'removed' | 'skip';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const LCS_CELL_BUDGET = 4_000_000;
const CONTEXT_RUN_LIMIT = 8;
const CONTEXT_EDGE_LINES = 3;

/**
 * Line-level unified diff (before → after): common prefix/suffix trimmed,
 * LCS over the middle, long unchanged runs collapsed into a `skip` marker.
 * Falls back to whole-block removed/added when the middle exceeds the DP
 * budget.
 */
export function unifiedDiffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const lines: DiffLine[] = [];
  for (const text of a.slice(0, start)) lines.push({ kind: 'context', text });
  lines.push(...diffMiddle(a.slice(start, endA), b.slice(start, endB)));
  for (const text of a.slice(endA)) lines.push({ kind: 'context', text });
  return collapseContextRuns(lines);
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length === 0) return b.map((text) => ({ kind: 'added' as const, text }));
  if (b.length === 0) return a.map((text) => ({ kind: 'removed' as const, text }));
  if (a.length * b.length > LCS_CELL_BUDGET) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }

  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * cols + j] ?? 0, lcs[i * cols + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    // The loop bound guarantees both; the fallback is unreachable and is here
    // because an index signature cannot say so.
    const left = a[i] ?? '';
    const right = b[j] ?? '';
    if (left === right) {
      out.push({ kind: 'context', text: left });
      i++;
      j++;
    } else if ((lcs[(i + 1) * cols + j] ?? 0) >= (lcs[i * cols + j + 1] ?? 0)) {
      out.push({ kind: 'removed', text: left });
      i++;
    } else {
      out.push({ kind: 'added', text: right });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] ?? '' });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] ?? '' });
  return out;
}

function collapseContextRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (): void => {
    if (run.length > CONTEXT_RUN_LIMIT) {
      out.push(...run.slice(0, CONTEXT_EDGE_LINES));
      out.push({
        kind: 'skip',
        text: `… ${String(run.length - CONTEXT_EDGE_LINES * 2)} unchanged lines`,
      });
      out.push(...run.slice(run.length - CONTEXT_EDGE_LINES));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const line of lines) {
    if (line.kind === 'context') {
      run.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}
