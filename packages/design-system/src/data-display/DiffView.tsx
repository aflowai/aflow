'use client';

import { useMemo, type CSSProperties } from 'react';
import { computeLineDiff, diffJson, diffStats, type DiffLine } from './diff.js';

export interface DiffViewProps {
  /** Values diffed as stable, key-sorted JSON (the default format). */
  before?: unknown;
  after?: unknown;
  /** Diff `before`/`after` as plain text instead of JSON. */
  format?: 'json' | 'text';
  /** Precomputed diff lines — overrides `before`/`after`. */
  lines?: DiffLine[];
  /** Collapse long runs of unchanged lines into a fold (default true). */
  collapseUnchanged?: boolean;
  /** Unchanged lines kept around each change when collapsing (default 3). */
  contextLines?: number;
  maxHeight?: number | string;
  /** Shown when there is no change. */
  emptyLabel?: string;
}

type Row = { kind: 'line'; line: DiffLine } | { kind: 'fold'; count: number; key: string };

const GUTTER: CSSProperties = {
  flex: '0 0 auto',
  width: 40,
  textAlign: 'right',
  padding: '0 8px',
  color: 'var(--color-text-muted)',
  userSelect: 'none',
  opacity: 0.7,
};

function rowBg(op: DiffLine['op']): string | undefined {
  if (op === 'add') return 'color-mix(in srgb, var(--color-success-default) 16%, transparent)';
  if (op === 'del') return 'color-mix(in srgb, var(--color-danger-default) 16%, transparent)';
  return undefined;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function sign(op: DiffLine['op']): string {
  return op === 'add' ? '+' : op === 'del' ? '-' : ' ';
}

function signColor(op: DiffLine['op']): string {
  if (op === 'add') return 'var(--color-success-fg)';
  if (op === 'del') return 'var(--color-danger-fg)';
  return 'var(--color-text-muted)';
}

/**
 * Reusable unified line diff. Feed it two values (JSON-diffed by default), two
 * strings (`format="text"`), or precomputed `lines`. Long unchanged stretches
 * fold away so only the changes and their surrounding context show.
 */
export function DiffView(props: DiffViewProps) {
  const lines = useMemo<DiffLine[]>(() => {
    if (props.lines) return props.lines;
    if (props.format === 'text') {
      return computeLineDiff(asText(props.before), asText(props.after));
    }
    return diffJson(props.before, props.after);
  }, [props.lines, props.before, props.after, props.format]);

  const stats = useMemo(() => diffStats(lines), [lines]);

  const rows = useMemo<Row[]>(() => {
    const collapse = props.collapseUnchanged ?? true;
    if (!collapse) return lines.map((line) => ({ kind: 'line', line }));

    const ctx = props.contextLines ?? 3;
    const keep = new Array<boolean>(lines.length).fill(false);
    lines.forEach((line, idx) => {
      if (line.op === 'context') return;
      const lo = Math.max(0, idx - ctx);
      const hi = Math.min(lines.length - 1, idx + ctx);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    });

    const out: Row[] = [];
    let idx = 0;
    while (idx < lines.length) {
      const line = lines[idx];
      if (line && keep[idx]) {
        out.push({ kind: 'line', line });
        idx++;
        continue;
      }
      const start = idx;
      let count = 0;
      while (idx < lines.length && !keep[idx]) {
        count++;
        idx++;
      }
      out.push({ kind: 'fold', count, key: `fold-${start}` });
    }
    return out;
  }, [lines, props.collapseUnchanged, props.contextLines]);

  if (!stats.changed) {
    return (
      <div
        style={{
          padding: 'var(--space-md)',
          color: 'var(--color-text-muted)',
          fontSize: 13,
          textAlign: 'center',
        }}
      >
        {props.emptyLabel ?? 'No changes'}
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        overflow: 'auto',
        maxHeight: props.maxHeight ?? 460,
        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        fontSize: 12,
        lineHeight: '18px',
        background: 'var(--color-surface-1)',
      }}
    >
      {rows.map((row, i) =>
        row.kind === 'fold' ? (
          <div
            key={row.key}
            style={{
              padding: '2px 12px',
              color: 'var(--color-text-muted)',
              background: 'var(--color-surface-2)',
              borderTop: '1px solid var(--color-border-subtle)',
              borderBottom: '1px solid var(--color-border-subtle)',
              fontSize: 11,
            }}
          >
            ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
          </div>
        ) : (
          <div
            key={`${row.line.op}-${row.line.beforeLine ?? ''}-${row.line.afterLine ?? ''}-${i}`}
            style={{ display: 'flex', background: rowBg(row.line.op), whiteSpace: 'pre' }}
          >
            <span style={GUTTER}>{row.line.beforeLine ?? ''}</span>
            <span style={GUTTER}>{row.line.afterLine ?? ''}</span>
            <span
              style={{
                flex: '0 0 auto',
                width: 16,
                textAlign: 'center',
                color: signColor(row.line.op),
                fontWeight: 600,
              }}
            >
              {sign(row.line.op)}
            </span>
            <span style={{ flex: 1, padding: '0 8px', whiteSpace: 'pre-wrap', minWidth: 0 }}>
              {row.line.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
