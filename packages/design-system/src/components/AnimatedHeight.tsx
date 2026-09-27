'use client';

import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

// =============================================================================
// AnimatedHeight
// =============================================================================

export interface AnimatedHeightProps extends HTMLAttributes<HTMLDivElement> {
  /** Content whose natural height drives the animated wrapper height. */
  children?: ReactNode;
}

/**
 * Smoothly animates its own height whenever the content inside grows or
 * shrinks (sublines mounting/unmounting, text wrapping, lists gaining
 * rows). CSS can't transition to/from `height: auto`, so content-driven
 * size changes normally snap — this wrapper keeps an explicit pixel
 * height (synced from the inner content via ResizeObserver, which fires
 * before paint, so there's no flash of unclipped content) and lets the
 * CSS transition tween between the pixel values. Everything below the
 * wrapper slides along in normal flow.
 *
 * The very first measurement lands on an `auto` height, which is
 * non-interpolable — so mount renders at natural size with no animation,
 * exactly what you want. Under `prefers-reduced-motion` the global reset
 * collapses the tween to a cut.
 *
 * Caveat: the wrapper clips overflow while heights disagree, so shadows /
 * focus rings on content at the very bottom edge can be shaved during the
 * tween. Absolutely-positioned children that anchor to an ancestor
 * outside the wrapper escape the clip (and don't contribute height).
 *
 * Styling lives in `styles/components.css` (`.ds-animated-height`).
 */
export function AnimatedHeight({ children, className = '', ...props }: AnimatedHeightProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // The inner box has no border/padding, so contentRect is its full
      // (fractional) height — offsetHeight would round and jiggle by 1px.
      outer.style.height = `${String(entry.contentRect.height)}px`;
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={outerRef} className={`ds-animated-height ${className}`.trim()} {...props}>
      <div ref={innerRef} className="ds-animated-height__inner">
        {children}
      </div>
    </div>
  );
}
