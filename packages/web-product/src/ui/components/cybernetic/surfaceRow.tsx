'use client';

import type { ReactNode } from 'react';
import { Row, Text } from '@aflow/design-system';

/**
 * The row shape and the placement control shared by the capability and
 * connection halves of the tool panel.
 *
 * Shared because they are one decision wearing two labels — "what does this
 * agent carry, and what does it cost". Two widgets for that (a dropdown on one
 * half, a toggle chip on the other) made the same state read differently
 * depending on which list you were looking at.
 */

/**
 * Token counts at the two scales this panel shows them, formatted by SURFACE
 * rather than by magnitude — the same figure reads differently depending on
 * what it is being compared against.
 *
 * `formatTokens` is for anything that sits in the aggregate column: bundle
 * rows, section headers, the panel total. Always `k`, because a column mixing
 * `636` with `1.5k` makes the reader check the unit on every line, and at that
 * scale the leading digit is the whole decision.
 *
 * `formatToolTokens` is for the individual tools inside a pinned connection.
 * Those are small — a median of ~190 and a floor near 50 — so `k` would print
 * `0.1k` down the entire list and hide the differences the operator is there to
 * act on when picking which endpoints fit under the cap.
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 10000) return `${String(Math.round(tokens / 1000))}k`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

export function formatToolTokens(tokens: number): string {
  return String(tokens);
}

export interface PlacementOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Every row quotes its size and price, whatever tier it currently sits in —
 * the operator is deciding whether to move it, and that needs the number
 * BEFORE the move, not after.
 */
export function SurfaceRow({
  label,
  sublabel,
  toolCount,
  tokens,
  tokenPrefix,
  dimmed,
  showHint,
  control,
  controlId,
  children,
}: {
  label: string;
  sublabel?: string;
  toolCount: number;
  tokens: number;
  /** `+` marks a figure that would be ADDED, not one being carried. */
  tokenPrefix?: string | undefined;
  /** Reserved for genuinely inert rows — never for a row that is merely off. */
  dimmed?: boolean;
  /** Descriptions are off by default — seventeen of them is a wall, not help. */
  showHint?: boolean;
  control: ReactNode;
  /**
   * `id` of the control, which makes the row's name a label for it. The name is
   * what the operator reads the row by, so it should be what they can aim at —
   * the control is a narrow chip at the far end.
   */
  controlId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: 'var(--space-1) 0',
        borderTop: '1px solid var(--color-border-subtle)',
        opacity: dimmed === true ? 0.6 : 1,
      }}
    >
      <Row align="center" gap="2">
        <div style={{ flex: 1, minWidth: 0 }}>
          {controlId !== undefined ? (
            <label htmlFor={controlId} style={{ cursor: 'pointer' }}>
              <Text size="sm">{label}</Text>
            </label>
          ) : (
            <Text size="sm">{label}</Text>
          )}
        </div>
        <Text
          size="xs"
          variant="muted"
          style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
        </Text>
        <Text
          size="xs"
          variant="muted"
          style={{
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            minWidth: '2.75rem',
            textAlign: 'right',
          }}
        >
          {tokenPrefix ?? ''}
          {formatTokens(tokens)} tok
        </Text>
        <div style={{ minWidth: '7rem', display: 'flex', justifyContent: 'flex-end' }}>
          {control}
        </div>
      </Row>
      {/* Full width, under the row rather than inside the label column, so a
          long description wraps against the panel instead of a starved flex
          child. Hidden unless asked for. */}
      {showHint === true && sublabel !== undefined && (
        <Text size="xs" variant="muted" style={{ display: 'block', padding: '0 0 var(--space-1)' }}>
          {sublabel}
        </Text>
      )}
      {children}
    </div>
  );
}

/**
 * The placement control. Full text colour, not muted: it is the one interactive
 * thing on the row, and a muted dropdown read as disabled on rows that were
 * perfectly editable.
 */
export function PlacementSelect<T extends string>({
  id,
  value,
  options,
  ariaLabel,
  onChange,
}: {
  /** Pair with the row's `controlId` so the row's name labels this control. */
  id?: string;
  value: T;
  options: ReadonlyArray<PlacementOption<T>>;
  /**
   * Kept alongside the row's label element: the label carries the name the
   * operator reads, this says which of the row's several numbers the control
   * acts on.
   */
  ariaLabel: string;
  onChange: (value: T) => void;
}) {
  return (
    <select
      {...(id !== undefined ? { id } : {})}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => {
        onChange(e.target.value as T);
      }}
      style={{
        font: 'inherit',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-default)',
        background: 'var(--color-surface-raised)',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-sm)',
        padding: '2px 4px',
        cursor: 'pointer',
        width: '100%',
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A collapsible tier. The count sits in the header so a collapsed section still
 * answers "how much is in here and what does it cost" without being opened.
 */
export function SurfaceSection({
  title,
  count,
  toolCount,
  tokens,
  open,
  onToggle,
  footnote,
  children,
}: {
  title: string;
  count: number;
  toolCount: number;
  tokens?: number;
  open: boolean;
  onToggle: () => void;
  footnote?: string;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          background: 'none',
          border: 0,
          padding: 'var(--space-1) 0',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'block',
          width: '100%',
        }}
      >
        <Row align="center" gap="2">
          <Text size="xs" variant="muted" style={{ width: '0.75rem' }}>
            {open ? '▾' : '▸'}
          </Text>
          <Text
            size="xs"
            weight="semibold"
            style={{ textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}
          >
            {title}
          </Text>
          <Text
            size="xs"
            variant="muted"
            style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {count} · {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
            {tokens !== undefined ? ` · ${formatTokens(tokens)} tok` : ''}
          </Text>
        </Row>
      </button>
      {/* Above the rows, not below: it says what this tier MEANS, which is
          what the operator needs before reading the list rather than after. */}
      {open && footnote !== undefined && (
        <Text size="xs" variant="muted" style={{ display: 'block', padding: '0 0 var(--space-1)' }}>
          {footnote}
        </Text>
      )}
      {open && <div>{children}</div>}
    </div>
  );
}
