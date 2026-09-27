/**
 * StuckAlert — Amber/saffron border pulse for stuck nodes (DL-10).
 *
 * Renders a pulsing border around its children when active. Falls back
 * to a static amber border when prefers-reduced-motion is on.
 *
 * @example
 * ```tsx
 * <StuckAlert active>
 *   <AnatomicalNode kind="worker" state="stuck" />
 * </StuckAlert>
 * ```
 */
import type { CSSProperties, ReactNode } from 'react';

export interface StuckAlertProps {
  /** Whether this node is in stuck state. */
  active: boolean;
  /** Disable animation (for testing). */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const STUCK_KEYFRAMES = `
@keyframes cybernetic-stuck-pulse {
  0%, 100% { border-color: var(--color-cybernetic-attention); box-shadow: 0 0 0 0 transparent; }
  50% { border-color: var(--color-cybernetic-regression); box-shadow: 0 0 8px 2px var(--color-cybernetic-attention); }
}
`;

let keyframesInjected = false;
function ensureKeyframes() {
  if (keyframesInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = STUCK_KEYFRAMES;
  document.head.appendChild(style);
  keyframesInjected = true;
}

export function StuckAlert({ active, disabled, children, className, style }: StuckAlertProps) {
  if (typeof document !== 'undefined') {
    ensureKeyframes();
  }

  const alertStyle: CSSProperties = {
    position: 'relative',
    borderRadius: 'var(--radius-md)',
    border: '2px solid transparent',
    ...(active
      ? disabled
        ? {
            borderColor: 'var(--color-cybernetic-attention)',
            boxShadow: '0 0 6px 1px var(--color-cybernetic-attention)',
          }
        : {
            animation: 'cybernetic-stuck-pulse 1200ms var(--motion-pulse-easing) infinite',
          }
      : undefined),
    ...style,
  };

  return (
    <div className={className} style={alertStyle}>
      {children}
    </div>
  );
}
