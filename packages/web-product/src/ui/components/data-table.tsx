'use client';

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Text, Row } from '@aflow/design-system';

/* -------------------------------------------------------------------------- */
/*  Tabular data analysis                                                     */
/* -------------------------------------------------------------------------- */

/** A primitive JSON value (renderable in a table cell). */
type Primitive = string | number | boolean | null | undefined;

function isPrimitive(v: unknown): v is Primitive {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function isPlainObject(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

/**
 * Extract the primitive-valued keys from an object.
 * Returns the keys whose values are primitives. Used to determine
 * which columns to show in a table (non-primitive fields are skipped).
 */
function primitiveKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter((k) => isPrimitive(obj[k]));
}

/**
 * Check if an array of objects is "mostly flat" — every item is a plain object
 * and at least 2 keys across all items hold primitive values.
 */
function isMostlyFlatArray(arr: unknown[]): arr is Array<Record<string, unknown>> {
  if (!arr.every(isPlainObject)) return false;
  const allPrimKeys = new Set<string>();
  for (const row of arr) {
    for (const k of primitiveKeys(row)) {
      allPrimKeys.add(k);
    }
  }
  return allPrimKeys.size >= 2;
}

export interface TabularRows {
  kind: 'rows';
  columns: string[];
  hiddenColumns: string[];
  rows: Array<Record<string, Primitive>>;
}
export interface TabularKeyValue {
  kind: 'keyvalue';
  entries: Array<[string, Primitive]>;
}
export interface TabularWrapped {
  kind: 'wrapped';
  label: string;
  table: TabularRows;
  metadata: Array<[string, Primitive]>;
}
export interface TabularPrimitives {
  kind: 'primitives';
  values: Primitive[];
}

export type TabularData = TabularRows | TabularKeyValue | TabularWrapped | TabularPrimitives;

/** Max visible columns — extra columns are hidden behind "+N more columns". */
const MAX_VISIBLE_COLUMNS = 12;

/** Arrays larger than this bail out to JsonViewer (too much data for a table). */
const MAX_ARRAY_SIZE = 500;

/**
 * Build a TabularRows from an array of objects, keeping only primitive-valued columns.
 * Caps visible columns at MAX_VISIBLE_COLUMNS.
 */
function buildRowsTable(arr: Array<Record<string, unknown>>): TabularRows | null {
  const keySet = new Set<string>();
  for (const row of arr) {
    for (const k of primitiveKeys(row)) {
      keySet.add(k);
    }
  }
  const allColumns = [...keySet];
  if (allColumns.length < 2) return null;

  const columns = allColumns.slice(0, MAX_VISIBLE_COLUMNS);
  const hiddenColumns = allColumns.slice(MAX_VISIBLE_COLUMNS);

  const rows = arr.map((row) => {
    const projected: Record<string, Primitive> = {};
    for (const col of columns) {
      const v = row[col];
      projected[col] = isPrimitive(v) ? v : undefined;
    }
    return projected;
  });

  return { kind: 'rows', columns, hiddenColumns, rows };
}

/**
 * Analyze whether `data` is tabular. Returns a discriminated shape or `null`.
 *
 * Layout heuristic: when `rows <= 2` and `columns >= 4`, the rows table is
 * automatically flipped to key-value layout by the DataTable component
 * (more scannable when there are more columns than rows).
 */
export function analyzeTabularData(data: unknown): TabularData | null {
  // Array cases
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    // Too large for table rendering — bail to JsonViewer
    if (data.length > MAX_ARRAY_SIZE) return null;

    // Array of primitives → single-column table
    if (data.every(isPrimitive)) {
      return { kind: 'primitives', values: data };
    }

    // Array of mostly-flat objects → rows table (primitive columns only)
    if (isMostlyFlatArray(data)) {
      return buildRowsTable(data);
    }

    return null;
  }

  // Object cases
  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) return null;

    // Check for wrapped table: exactly one array-of-objects key, rest (if any) are primitives
    const arrayKeys: string[] = [];
    const scalarKeys: Array<[string, Primitive]> = [];
    let nonMatchCount = 0;
    for (const [k, v] of entries) {
      if (Array.isArray(v) && v.length > 0 && isMostlyFlatArray(v)) {
        arrayKeys.push(k);
      } else if (isPrimitive(v)) {
        scalarKeys.push([k, v]);
      } else {
        nonMatchCount++;
      }
    }

    if (arrayKeys.length === 1 && nonMatchCount === 0) {
      const label = arrayKeys[0] ?? '';
      const arr = data[label] as Array<Record<string, unknown>>;
      const inner = buildRowsTable(arr);
      if (inner) {
        return { kind: 'wrapped', label, table: inner, metadata: scalarKeys };
      }
    }

    // Plain flat object (all primitive values, ≥2 keys) → key-value table
    if (entries.length >= 2 && entries.every(([, v]) => isPrimitive(v))) {
      return { kind: 'keyvalue', entries: entries as Array<[string, Primitive]> };
    }

    return null;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Cell rendering                                                            */
/* -------------------------------------------------------------------------- */

const MAX_VISIBLE_ROWS = 50;

/** Truncate long text cells beyond this many characters. */
const CELL_TRUNCATE_LENGTH = 120;

/** ISO 8601 datetime pattern (with T separator and timezone). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function looksLikeIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value);
}

/**
 * Format a date as relative time (e.g. "3 days ago", "just now", "in 2 hours").
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const absDiff = Math.abs(diffMs);
  const past = diffMs >= 0;

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  const label = (n: number, unit: string) => {
    const s = n === 1 ? `1 ${unit}` : `${n} ${unit}s`;
    return past ? `${s} ago` : `in ${s}`;
  };

  if (seconds < 60) return past ? 'just now' : 'in a moment';
  if (minutes < 60) return label(minutes, 'min');
  if (hours < 24) return label(hours, 'hour');
  if (days < 7) return label(days, 'day');
  if (weeks < 5) return label(weeks, 'week');
  return label(months, 'month');
}

/**
 * Format a full date for the tooltip: "Mar 2, 2026, 11:43 AM"
 */
function formatFullDate(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** UUID pattern: 8-4-4-4-12 hex chars, or 32+ hex chars (no dashes). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{32,}$/i;

function looksLikeId(value: string): boolean {
  return UUID_RE.test(value) || LONG_HEX_RE.test(value);
}

/**
 * Truncated ID pill — shows first 8 chars, copies full value on click.
 */
function IdPill({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    });
  }, [value]);

  const display = value.length > 12 ? `${value.slice(0, 8)}\u2026` : value;

  return (
    <span
      role="button"
      tabIndex={0}
      title={`${value}\nClick to copy`}
      onClick={handleCopy}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleCopy();
      }}
      style={{
        display: 'inline-block',
        maxWidth: '10ch',
        padding: '1px 6px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--font-size-xs)',
        fontFamily: 'var(--font-family-mono)',
        backgroundColor: 'var(--color-surface-2)',
        color: 'var(--color-text-secondary)',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        transition: 'background-color 150ms',
      }}
    >
      {copied ? 'copied!' : display}
    </span>
  );
}

/**
 * Expandable text for long cell values — truncates with ellipsis and a
 * "more" toggle. Short values render directly.
 */
function LongText({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  if (value.length <= CELL_TRUNCATE_LENGTH) {
    return <>{value}</>;
  }

  if (expanded) {
    return (
      <span style={{ wordBreak: 'break-word' }}>
        {value}{' '}
        <button
          onClick={() => {
            setExpanded(false);
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-link)',
            padding: 0,
          }}
        >
          less
        </button>
      </span>
    );
  }

  return (
    <span>
      {value.slice(0, CELL_TRUNCATE_LENGTH)}
      {'\u2026 '}
      <button
        onClick={() => {
          setExpanded(true);
        }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-link)',
          padding: 0,
        }}
      >
        more
      </button>
    </span>
  );
}

/**
 * Relative time display — shows "3 days ago" with full date on hover.
 */
function DateValue({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{value}</>;

  return (
    <span
      title={formatFullDate(date)}
      style={{
        whiteSpace: 'nowrap',
        color: 'var(--color-text-secondary)',
        cursor: 'default',
      }}
    >
      {formatRelativeTime(date)}
    </span>
  );
}

function CellValue({ value }: { value: Primitive }) {
  if (value === null || value === undefined) {
    return <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>—</span>;
  }
  if (typeof value === 'boolean') {
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '1px 6px',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 'var(--font-weight-medium)',
          backgroundColor: value ? 'var(--color-success-subtle)' : 'var(--color-surface-2)',
          color: value ? 'var(--color-success-default)' : 'var(--color-text-muted)',
        }}
      >
        {String(value)}
      </span>
    );
  }
  const str = String(value);
  if (typeof value === 'string' && looksLikeIsoDate(str)) {
    return <DateValue value={str} />;
  }
  if (typeof value === 'string' && looksLikeId(str)) {
    return <IdPill value={str} />;
  }
  return <LongText value={str} />;
}

/* -------------------------------------------------------------------------- */
/*  DataTable component                                                       */
/* -------------------------------------------------------------------------- */

export interface DataTableProps {
  data: TabularData;
}

/**
 * Should this rows table be flipped to vertical (key-value) layout?
 * When there are very few rows but many columns, a vertical layout
 * where each row becomes a key-value section is far more scannable.
 */
function shouldFlipToVertical(columns: string[], rows: Array<Record<string, Primitive>>): boolean {
  return rows.length <= 2 && columns.length >= 4;
}

export const DataTable = memo(function DataTable({ data }: DataTableProps) {
  const [expanded, setExpanded] = useState(false);

  switch (data.kind) {
    case 'rows': {
      if (shouldFlipToVertical(data.columns, data.rows)) {
        return (
          <VerticalRows
            columns={data.columns}
            rows={data.rows}
            hiddenColumns={data.hiddenColumns}
          />
        );
      }
      return (
        <RowsTable
          columns={data.columns}
          hiddenColumns={data.hiddenColumns}
          rows={data.rows}
          expanded={expanded}
          onToggle={() => {
            setExpanded(!expanded);
          }}
        />
      );
    }

    case 'keyvalue':
      return (
        <ScrollWrapper>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map(([k, v]) => (
                <tr key={k}>
                  <td className="kv-key" style={{ fontWeight: 'var(--font-weight-medium)' }}>
                    {k}
                  </td>
                  <td>
                    <CellValue value={v} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollWrapper>
      );

    case 'wrapped': {
      if (shouldFlipToVertical(data.table.columns, data.table.rows)) {
        return <WrappedVertical data={data} />;
      }
      return (
        <WrappedTable
          data={data}
          expanded={expanded}
          onToggle={() => {
            setExpanded(!expanded);
          }}
        />
      );
    }

    case 'primitives':
      return (
        <ScrollWrapper>
          <table>
            <thead>
              <tr>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {data.values.slice(0, expanded ? undefined : MAX_VISIBLE_ROWS).map((v, i) => (
                <tr key={i}>
                  <td>
                    <CellValue value={v} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!expanded && data.values.length > MAX_VISIBLE_ROWS && (
            <ExpandButton
              count={data.values.length}
              onToggle={() => {
                setExpanded(true);
              }}
            />
          )}
        </ScrollWrapper>
      );
  }
});

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

/** Max height before vertical scroll kicks in. */
const MAX_TABLE_HEIGHT = 400;

/**
 * Scroll container with bottom fade gradient when content overflows.
 * The fade signals to the user that more rows exist below the fold.
 */
function ScrollWrapper({
  children,
  rowCount,
  totalRows,
}: {
  children: React.ReactNode;
  rowCount?: number;
  totalRows?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const check = () => {
      const overflows = el.scrollHeight > el.clientHeight + 2;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      setHasOverflow(overflows && !atBottom);
    };

    check();
    el.addEventListener('scroll', check, { passive: true });
    return () => {
      el.removeEventListener('scroll', check);
    };
  }, [children]);

  return (
    <div className="data-table-scroll-container">
      <div className={hasOverflow ? 'data-table-fade' : undefined}>
        <div
          ref={scrollRef}
          className="md-content data-table-scroll"
          style={{ maxHeight: MAX_TABLE_HEIGHT }}
        >
          {children}
        </div>
      </div>
      {totalRows != null && rowCount != null && totalRows > rowCount && (
        <div
          style={{
            padding: 'var(--space-1) var(--space-3)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
          }}
        >
          Showing {rowCount} of {totalRows} rows
        </div>
      )}
    </div>
  );
}

/**
 * Vertical layout for 1–2 rows with many columns.
 * Each row becomes a key-value section. Multiple rows get a subtle separator.
 */
function VerticalRows({
  columns,
  rows,
  hiddenColumns,
}: {
  columns: string[];
  rows: Array<Record<string, Primitive>>;
  hiddenColumns?: string[];
}) {
  const hiddenCount = hiddenColumns?.length ?? 0;

  return (
    <div>
      <ScrollWrapper>
        {rows.map((row, i) => (
          <div key={i}>
            {rows.length > 1 && (
              <div
                style={{
                  fontSize: 'var(--font-size-xs)',
                  fontWeight: 'var(--font-weight-semibold)',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--font-letter-spacing-wide)',
                  padding: 'var(--space-2) var(--space-3) 0',
                  ...(i > 0
                    ? {
                        borderTop: '1px solid var(--color-border-default)',
                        marginTop: 'var(--space-2)',
                      }
                    : {}),
                }}
              >
                Item {i + 1}
              </div>
            )}
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((col) => (
                  <tr key={col}>
                    <td className="kv-key" style={{ fontWeight: 'var(--font-weight-medium)' }}>
                      {col}
                    </td>
                    <td>
                      <CellValue value={row[col]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </ScrollWrapper>
      {hiddenCount > 0 && (
        <Row style={{ padding: 'var(--space-1) var(--space-3)' }}>
          <Text
            size="xs"
            style={{ color: 'var(--color-text-muted)' }}
            title={(hiddenColumns ?? []).join(', ')}
          >
            +{hiddenCount} more {hiddenCount === 1 ? 'column' : 'columns'}
          </Text>
        </Row>
      )}
    </div>
  );
}

/** Number of rows to sample for column width estimation. */
const WIDTH_SAMPLE_SIZE = 20;

/** Min/max column widths in px. */
const COL_MIN_WIDTH = 80;
const COL_MAX_WIDTH = 360;

/**
 * Estimate relative column widths by sampling cell content lengths.
 * Returns a CSS width string per column (e.g. "120px", "240px").
 * Wider text content → proportionally wider column.
 */
function estimateColumnWidths(columns: string[], rows: Array<Record<string, Primitive>>): string[] {
  const sample = rows.slice(0, WIDTH_SAMPLE_SIZE);

  // For each column, find the max rendered length across the sample
  const maxLengths = columns.map((col) => {
    let max = col.length; // header is the minimum baseline
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      const str = String(v);
      // IDs and dates render short — cap their contribution
      if (typeof v === 'string' && (looksLikeId(str) || looksLikeIsoDate(str))) {
        max = Math.max(max, 12);
      } else if (typeof v === 'boolean') {
        max = Math.max(max, 6);
      } else {
        max = Math.max(max, Math.min(str.length, 60)); // cap at 60 chars to avoid outliers dominating
      }
    }
    return max;
  });

  // Convert lengths to proportional widths, clamped to min/max
  const total = maxLengths.reduce((sum, l) => sum + l, 0);
  if (total === 0) return columns.map(() => `${COL_MIN_WIDTH}px`);

  return maxLengths.map((len) => {
    // Proportional share of available space, clamped
    const ratio = len / total;
    const width = Math.max(
      COL_MIN_WIDTH,
      Math.min(COL_MAX_WIDTH, Math.round(ratio * columns.length * 160)),
    );
    return `${width}px`;
  });
}

function RowsTable({
  columns,
  hiddenColumns,
  rows,
  expanded,
  onToggle,
}: {
  columns: string[];
  hiddenColumns?: string[];
  rows: Array<Record<string, Primitive>>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const visibleRows = expanded ? rows : rows.slice(0, MAX_VISIBLE_ROWS);
  const needsExpand = rows.length > MAX_VISIBLE_ROWS;
  const hiddenCount = hiddenColumns?.length ?? 0;
  const colWidths = estimateColumnWidths(columns, rows);

  return (
    <div>
      <ScrollWrapper rowCount={visibleRows.length} totalRows={rows.length}>
        <table>
          <colgroup>
            {colWidths.map((w, i) => (
              <col key={columns[i]} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col}>
                    <CellValue value={row[col]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollWrapper>
      {(needsExpand || hiddenCount > 0) && (
        <Row gap="2" align="center" style={{ padding: 'var(--space-1) var(--space-3)' }}>
          {needsExpand && (
            <ExpandButton count={rows.length} expanded={expanded} onToggle={onToggle} />
          )}
          {hiddenCount > 0 && (
            <Text
              size="xs"
              style={{ color: 'var(--color-text-muted)' }}
              title={(hiddenColumns ?? []).join(', ')}
            >
              +{hiddenCount} more {hiddenCount === 1 ? 'column' : 'columns'}
            </Text>
          )}
        </Row>
      )}
    </div>
  );
}

function WrappedTable({
  data,
  expanded,
  onToggle,
}: {
  data: TabularWrapped;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [showMeta, setShowMeta] = useState(false);

  return (
    <div>
      <RowsTable
        columns={data.table.columns}
        hiddenColumns={data.table.hiddenColumns}
        rows={data.table.rows}
        expanded={expanded}
        onToggle={onToggle}
      />
      <MetadataFooter
        metadata={data.metadata}
        showMeta={showMeta}
        onToggle={() => {
          setShowMeta(!showMeta);
        }}
      />
    </div>
  );
}

/**
 * Wrapped table with vertical layout for the inner rows.
 */
function WrappedVertical({ data }: { data: TabularWrapped }) {
  const [showMeta, setShowMeta] = useState(false);

  return (
    <div>
      <VerticalRows
        columns={data.table.columns}
        rows={data.table.rows}
        hiddenColumns={data.table.hiddenColumns}
      />
      <MetadataFooter
        metadata={data.metadata}
        showMeta={showMeta}
        onToggle={() => {
          setShowMeta(!showMeta);
        }}
      />
    </div>
  );
}

function MetadataFooter({
  metadata,
  showMeta,
  onToggle,
}: {
  metadata: Array<[string, Primitive]>;
  showMeta: boolean;
  onToggle: () => void;
}) {
  if (metadata.length === 0) return null;

  const pillStyle = {
    color: 'var(--color-text-muted)',
    padding: '1px 6px',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-surface-2)',
  } as const;

  // Single metadata item — always show inline, no toggle needed
  if (metadata.length === 1) {
    const first = metadata[0];
    if (first === undefined) return null;
    const [k, v] = first;
    return (
      <Row gap="2" style={{ marginTop: 'var(--space-1)', paddingLeft: 'var(--space-1)' }}>
        <Text size="xs" style={pillStyle}>
          {k}: {String(v ?? '—')}
        </Text>
      </Row>
    );
  }

  return (
    <Row gap="2" style={{ marginTop: 'var(--space-1)', paddingLeft: 'var(--space-1)' }}>
      {showMeta ? (
        <Row gap="2" align="center">
          {metadata.map(([k, v]) => (
            <Text key={k} size="xs" style={pillStyle}>
              {k}: {String(v ?? '—')}
            </Text>
          ))}
          <button
            onClick={onToggle}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-muted)',
              padding: 0,
            }}
          >
            hide
          </button>
        </Row>
      ) : (
        <button
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            padding: 0,
          }}
        >
          {metadata.length} more fields
        </button>
      )}
    </Row>
  );
}

function ExpandButton({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded?: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
      <button
        onClick={onToggle}
        style={{
          background: 'none',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-sm)',
          padding: '2px 8px',
          cursor: 'pointer',
          fontSize: '12px',
          color: 'var(--color-text-muted)',
        }}
      >
        {expanded ? `Show first ${MAX_VISIBLE_ROWS} rows` : `Show all ${count} rows`}
      </button>
    </div>
  );
}
