/**
 * Pulse — CSS-only ambient aliveness indicator for active nodes.
 *
 * A gentle opacity wave (0.75 -> 0.95 -> 0.75) at 1.1Hz that signals
 * "on, attending" without demanding attention. Degrades to a static
 * highlight when prefers-reduced-motion is active.
 *
 * @example
 * ```tsx
 * <Pulse active color="var(--color-cybernetic-helmsman)">
 *   <AnatomicalNode kind="executive" />
 * </Pulse>
 * ```
 */
import type { CSSProperties, ReactNode } from 'react';

export interface PulseProps {
  /** Whether the pulse animation is active. */
  active: boolean;
  /** Accent color for the pulse glow. */
  color?: string;
  /** Disable animation (for testing). */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const PULSE_KEYFRAMES = `
@keyframes cybernetic-pulse {
  0%, 100% { opacity: 0.75; }
  50% { opacity: 0.95; }
}
`;

// Inject keyframes once
let keyframesInjected = false;
function ensureKeyframes() {
  if (keyframesInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(style);
  keyframesInjected = true;
}

export function Pulse({ active, color, disabled, children, className, style }: PulseProps) {
  if (typeof document !== 'undefined') {
    ensureKeyframes();
  }

  const pulseStyle: CSSProperties = {
    position: 'relative',
    ...(active && !disabled
      ? {
          animation:
            'cybernetic-pulse var(--motion-pulse-duration) var(--motion-pulse-easing) infinite',
        }
      : { opacity: active ? 0.95 : 0.6 }),
    ...(color ? ({ '--pulse-color': color } as Record<string, string>) : undefined),
    ...style,
  };

  return (
    <div className={className} style={pulseStyle}>
      {children}
    </div>
  );
}
