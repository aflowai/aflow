import type { HTMLAttributes, ReactNode } from 'react';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** What is being measured */
  label: ReactNode;
  /** The reading. Pass the already-formatted string — Stat never formats. */
  value: ReactNode;
  /** Secondary line under the value: a unit, a denominator, a caveat */
  hint?: ReactNode;
  /** Semantic colour for the value */
  tone?: StatTone;
  /** Minimum tile width, so a row of tiles keeps a common rhythm */
  minWidth?: number;
}

const TONE_COLOR: Record<StatTone, string> = {
  default: 'var(--color-text-primary)',
  success: 'var(--color-success-fg)',
  warning: 'var(--color-warning-fg)',
  danger: 'var(--color-danger-fg)',
  muted: 'var(--color-text-muted)',
};

/**
 * One compact metric tile — label over reading. A row of these is the metric
 * strip that heads a detail view.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  minWidth = 120,
  style,
  ...rest
}: StatProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth,
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
          lineHeight: 1.3,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 'var(--font-size-base)',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: TONE_COLOR[tone],
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
      {hint !== undefined && (
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            lineHeight: 1.3,
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}
