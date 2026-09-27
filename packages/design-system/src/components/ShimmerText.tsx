import type { HTMLAttributes, ReactNode } from 'react';

// =============================================================================
// ShimmerText
// =============================================================================

export interface ShimmerTextProps extends HTMLAttributes<HTMLSpanElement> {
  /** Text (or inline nodes) to render with the shimmer treatment. */
  children?: ReactNode;
}

/**
 * Animated gradient "thinking" text — the canonical "AI is working"
 * affordance. A highlight band sweeps across the text. Under
 * `prefers-reduced-motion` the global reset stops the sweep and the text
 * settles to a static muted color.
 *
 * Styling lives in `styles/components.css` (`.ds-shimmer-text`).
 */
export function ShimmerText({ children, className = '', ...props }: ShimmerTextProps) {
  return (
    <span className={`ds-shimmer-text ${className}`.trim()} {...props}>
      {children}
    </span>
  );
}
