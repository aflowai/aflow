'use client';

import type { ReactNode } from 'react';
import { Icon, Text } from '@aflow/design-system';

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
  disabled?: boolean;
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
  onToggle,
  expanded,
  annotation,
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
  onToggle?: () => void;
  expanded?: boolean;
  annotation?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: 'var(--space-2) 0',
        borderTop: '1px solid var(--color-border-subtle)',
        opacity: dimmed === true ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {onToggle ? (
            <button
              type="button"
              aria-label={`Tools in ${label}`}
              aria-expanded={expanded}
              onClick={onToggle}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: 0,
                border: 0,
                background: 'none',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
              <Text as="span" size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {label}
              </Text>
            </button>
          ) : controlId !== undefined ? (
            <label htmlFor={controlId} style={{ cursor: 'pointer' }}>
              <Text as="span" size="sm" style={{ overflowWrap: 'anywhere' }}>
                {label}
              </Text>
            </label>
          ) : (
            <Text as="span" size="sm" style={{ overflowWrap: 'anywhere' }}>
              {label}
            </Text>
          )}
          <Text
            as="div"
            size="xs"
            variant="muted"
            style={{
              fontVariantNumeric: 'tabular-nums',
              ...(onToggle ? { paddingLeft: 'var(--space-4)' } : {}),
            }}
          >
            {toolCount} {toolCount === 1 ? 'tool' : 'tools'} · {tokenPrefix ?? ''}
            {tokens < 1000 ? formatToolTokens(tokens) : formatTokens(tokens)} tok
            {annotation ? ` · ${annotation}` : ''}
          </Text>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>{control}</div>
      </div>
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
  disabled = false,
  title,
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
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      {...(id !== undefined ? { id } : {})}
      aria-label={ariaLabel}
      disabled={disabled}
      title={title}
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
        padding: '5px 6px',
        cursor: disabled ? 'default' : 'pointer',
        width: '10.5rem',
        maxWidth: '100%',
        flexShrink: 0,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
