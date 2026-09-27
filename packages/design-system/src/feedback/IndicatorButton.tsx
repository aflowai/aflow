'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/iconMap.js';

// ============================================================================
// Public API
// ============================================================================

export type IndicatorTone = 'idle' | 'info' | 'warning' | 'danger';

export interface IndicatorButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  /** Phoenix icon name (curated set). */
  icon: IconName;
  /**
   * Required accessible label. Doubles as the hover tooltip. The button
   * is icon-only — without a label, it is invisible to assistive tech.
   */
  label: string;
  /**
   * Overlaid count badge. Hidden when undefined or <= 0. Larger values
   * are formatted with `formatBadgeCount` (e.g. 99+).
   */
  count?: number;
  /**
   * Visual urgency. `idle` is muted; `warning` is amber; `danger` is red;
   * `info` is the accent tone (used for low-urgency awareness signals).
   * Default `idle`.
   */
  tone?: IndicatorTone;
  /**
   * Subtle pulse animation. Use sparingly — only when "something is
   * happening right now" needs ambient signal. Respects
   * `prefers-reduced-motion`.
   */
  pulse?: boolean;
}

// ============================================================================
// Pure helpers (testable without DOM)
// ============================================================================

/**
 * Resolve the visible badge label from a numeric count.
 * Returns `null` when nothing should render.
 */
export function formatBadgeCount(count: number | undefined): string | null {
  if (count === undefined || count <= 0) return null;
  if (!Number.isFinite(count)) return null;
  if (count > 99) return '99+';
  return String(Math.floor(count));
}

/** CSS color token per tone. Centralised so the indicator and the badge match. */
export function indicatorToneColor(tone: IndicatorTone): string {
  switch (tone) {
    case 'idle':
      return 'var(--color-text-secondary, #888)';
    case 'info':
      return 'var(--color-accent-default, #a78bfa)';
    case 'warning':
      return 'var(--color-warning-default, #f59e0b)';
    case 'danger':
      return 'var(--color-cybernetic-regression, var(--color-danger-default, #ef4444))';
  }
}

/** True iff the indicator should announce a pending count to assistive tech. */
export function indicatorShouldAnnounceCount(count: number | undefined): boolean {
  return formatBadgeCount(count) !== null;
}

// ============================================================================
// Pulse keyframes — defined once per page mount, with reduced-motion guard.
// ============================================================================

const PULSE_KEYFRAMES_ID = '__ds-indicator-button-pulse';

function ensurePulseKeyframes(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PULSE_KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_KEYFRAMES_ID;
  style.textContent = `
.ds-indicator-button--pulse {
  position: relative;
}
.ds-indicator-button--pulse::after {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  pointer-events: none;
  animation: ds-indicator-pulse 2.4s ease-out infinite;
  box-shadow: 0 0 0 0 currentColor;
}
@keyframes ds-indicator-pulse {
  0%   { box-shadow: 0 0 0 0   currentColor;      opacity: 0.55; }
  70%  { box-shadow: 0 0 0 3px rgba(0, 0, 0, 0);  opacity: 0;    }
  100% { box-shadow: 0 0 0 0   rgba(0, 0, 0, 0);  opacity: 0;    }
}
@media (prefers-reduced-motion: reduce) {
  .ds-indicator-button--pulse::after { animation: none !important; }
}`;
  document.head.appendChild(style);
}

// ============================================================================
// Component
// ============================================================================

export const IndicatorButton = forwardRef(function IndicatorButton(
  {
    icon,
    label,
    count,
    tone = 'idle',
    pulse = false,
    disabled = false,
    style,
    className,
    onClick,
    ...rest
  }: IndicatorButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  ensurePulseKeyframes();

  const badgeLabel = formatBadgeCount(count);
  const color = indicatorToneColor(tone);
  const announceCount = indicatorShouldAnnounceCount(count);

  const buttonStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    padding: 0,
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    background: 'transparent',
    color,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background-color 120ms ease, color 120ms ease',
    // Pulse animation lives on the `::after` pseudo-element registered
    // by `ensurePulseKeyframes()` — gated by the
    // `ds-indicator-button--pulse` class added below when `pulse` is
    // true. Keeping it off the button itself avoids inheriting the
    // button's rectangular `border-radius` for the ring shape.
    ...style,
  };

  const composedClassName = [
    'ds-indicator-button',
    pulse ? 'ds-indicator-button--pulse' : '',
    `ds-indicator-button--${tone}`,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      style={buttonStyle}
      className={composedClassName}
      onClick={onClick}
      {...rest}
    >
      <Icon name={icon} size="sm" weight="bold" />
      {badgeLabel !== null && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            minWidth: 14,
            height: 14,
            padding: '0 4px',
            borderRadius: 999,
            background: color,
            color: 'var(--color-surface-canvas, #111)',
            fontSize: 9,
            fontWeight: 700,
            lineHeight: '14px',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            boxShadow: '0 0 0 1.5px var(--color-surface-canvas, #111)',
          }}
        >
          {badgeLabel}
        </span>
      )}
      {announceCount && (
        // Visually hidden, screen-reader announced — keeps the badge
        // available to assistive tech without forcing the aria-label
        // to carry the count (which would change every refresh).
        <span
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {badgeLabel} pending
        </span>
      )}
    </button>
  );
});
