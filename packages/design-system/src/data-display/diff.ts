/**
 * Line-based unified diff (LCS) — no React, no dependencies. Reusable for any
 * before/after text or JSON.
 *
 * `diffJson` stable-sorts object keys before serializing, so structural diffs
 * are minimal and deterministic — readable for a human and clean for an AI
 * assistant that reasons over "what changed" alongside the validation result.
 */

export type DiffOp = 'add' | 'del' | 'context';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the "before" text (present on del/context). */
  beforeLine?: number;
  /** 1-based line number in the "after" text (present on add/context). */
  afterLine?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: boolean;
}

/** Above this many DP cells (~16MB Int32Array) the LCS table is skipped for a
 *  cheap prefix/suffix-trim diff, so a huge input can't freeze the tab. */
const LCS_CELL_CAP = 4_000_000;

export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_CELL_CAP) return coarseDiff(a, b);
  const width = m + 1;

  // Longest-common-subsequence lengths, filled bottom-up. A flat Int32Array
  // sidesteps noUncheckedIndexedAccess and keeps the hot loop allocation-free.
  const dp = new Int32Array((n + 1) * width);
  const at = (k: number): number => dp[k] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? at((i + 1) * width + (j + 1)) + 1
          : Math.max(at((i + 1) * width + j), at(i * width + (j + 1)));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let beforeNo = 1;
  let afterNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'context', text: a[i] ?? '', beforeLine: beforeNo++, afterLine: afterNo++ });
      i++;
      j++;
    } else if (at((i + 1) * width + j) >= at(i * width + (j + 1))) {
      out.push({ op: 'del', text: a[i] ?? '', beforeLine: beforeNo++ });
      i++;
    } else {
      out.push({ op: 'add', text: b[j] ?? '', afterLine: afterNo++ });
      j++;
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] ?? '', beforeLine: beforeNo++ });
  while (j < m) out.push({ op: 'add', text: b[j++] ?? '', afterLine: afterNo++ });
  return out;
}

/** O(n+m) fallback for very large inputs: keep the common prefix/suffix as
 *  context and treat the divergent middle as a wholesale del-then-add block. */
function coarseDiff(a: string[], b: string[]): DiffLine[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }
  const out: DiffLine[] = [];
  let beforeNo = 1;
  let afterNo = 1;
  for (let k = 0; k < lo; k++)
    out.push({ op: 'context', text: a[k] ?? '', beforeLine: beforeNo++, afterLine: afterNo++ });
  for (let k = lo; k < hiA; k++) out.push({ op: 'del', text: a[k] ?? '', beforeLine: beforeNo++ });
  for (let k = lo; k < hiB; k++) out.push({ op: 'add', text: b[k] ?? '', afterLine: afterNo++ });
  for (let k = hiA; k < a.length; k++)
    out.push({ op: 'context', text: a[k] ?? '', beforeLine: beforeNo++, afterLine: afterNo++ });
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === 'add') added++;
    else if (line.op === 'del') removed++;
  }
  return { added, removed, changed: added + removed > 0 };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeysDeep(src[key]);
    return out;
  }
  return value;
}

/** Pretty JSON with deterministically-sorted keys — yields minimal diffs. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

export function diffJson(before: unknown, after: unknown): DiffLine[] {
  return computeLineDiff(stableJson(before), stableJson(after));
}
