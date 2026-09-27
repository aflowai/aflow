import type { CSSProperties } from 'react';

export interface ProgressRingProps {
  /** Completion, 0..1. Values outside the range are clamped. */
  value: number;
  /** Outer diameter in pixels. */
  size?: number;
  /** Ring thickness in pixels. */
  thickness?: number;
  /**
   * Colour of the filled arc. Defaults to accent; `auto` reads full as a
   * success and anything short of it as a warning, which is what a score
   * usually means.
   */
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'auto';
  /** Announced to assistive tech, since the ring itself carries no text. */
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
}

const TONE_COLOR: Record<Exclude<ProgressRingProps['tone'], 'auto' | undefined>, string> = {
  accent: 'var(--color-accent-default)',
  success: 'var(--color-success-default)',
  warning: 'var(--color-warning-default)',
  danger: 'var(--color-danger-default)',
};

/**
 * A single ratio, read at a glance.
 *
 * The percentage sits inside the ring rather than beside it so the figure and
 * its completeness are one object: a reader takes "how far along" from the arc
 * without parsing the number, and the number is there when the exact value
 * matters.
 */
export function ProgressRing({
  value,
  size = 52,
  thickness = 5,
  tone = 'auto',
  ariaLabel,
  className = '',
  style,
}: ProgressRingProps) {
  const ratio = Math.min(1, Math.max(0, value));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const resolved = tone === 'auto' ? (ratio >= 1 ? 'success' : 'warning') : tone;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ position: 'relative', width: size, height: size, flexShrink: 0, ...style }}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth={thickness}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={TONE_COLOR[resolved]}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 'var(--font-weight-medium)' as unknown as number,
          color: 'var(--color-text-primary)',
        }}
      >
        {Math.round(ratio * 100)}%
      </div>
    </div>
  );
}
