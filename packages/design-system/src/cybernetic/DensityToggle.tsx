/**
 * DensityToggle — Two-value toggle for the Narration Log density (DL-17).
 *
 * Switches between Essentials (one-line decision events) and Deep
 * (adds reasoning prose, worker rationale, learner argumentation).
 *
 * @example
 * ```tsx
 * <DensityToggle value="essentials" onChange={setDensity} />
 * ```
 */
import type { CSSProperties } from 'react';

export type Density = 'essentials' | 'deep';

export interface DensityToggleProps {
  /** Current density value. */
  value: Density;
  /** Change handler. */
  onChange: (density: Density) => void;
  /** Disable the toggle. */
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function DensityToggle({ value, onChange, disabled, className, style }: DensityToggleProps) {
  const containerStyle: CSSProperties = {
    display: 'inline-flex',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-subtle)',
    overflow: 'hidden',
    opacity: disabled ? 0.5 : 1,
    ...style,
  };

  const buttonStyle = (active: boolean): CSSProperties => ({
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-family-sans)',
    fontWeight: active ? 500 : 400,
    color: active ? 'var(--color-cybernetic-ink)' : 'var(--color-cybernetic-ink-muted)',
    background: active ? 'var(--color-cybernetic-overlay)' : 'transparent',
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all var(--transition-duration-fast) var(--transition-timing-default)',
  });

  return (
    <div
      className={className}
      style={containerStyle}
      role="radiogroup"
      aria-label="Narration density"
    >
      <button
        role="radio"
        aria-checked={value === 'essentials'}
        onClick={() => {
          if (!disabled) onChange('essentials');
        }}
        style={buttonStyle(value === 'essentials')}
      >
        Essentials
      </button>
      <button
        role="radio"
        aria-checked={value === 'deep'}
        onClick={() => {
          if (!disabled) onChange('deep');
        }}
        style={buttonStyle(value === 'deep')}
      >
        Deep
      </button>
    </div>
  );
}
