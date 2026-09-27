'use client';

import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

// =============================================================================
// AnimatedWidth — horizontal twin of AnimatedHeight
// =============================================================================

export interface AnimatedWidthProps extends HTMLAttributes<HTMLDivElement> {
  /** When false, collapses to width 0 (content clipped, slides out). Default true. */
  open?: boolean;
  /**
   * Expanded width. A number is px. When omitted, the wrapper follows the
   * content's natural width via ResizeObserver (the true AnimatedHeight twin);
   * when given, it's a fixed-width collapse (no observer needed) — the common
   * docked-panel case.
   */
  width?: number | string;
  /**
   * Suppress the width tween — set false while drag-resizing so the wrapper
   * tracks the pointer instantly, true for collapse/expand so it animates.
   * Default true.
   */
  animate?: boolean;
  children?: ReactNode;
}

/** A number is treated as px; a string passes through verbatim. */
export const toCssWidth = (v: number | string): string =>
  typeof v === 'number' ? `${String(v)}px` : v;

/**
 * Smoothly animates its own width between expanded and collapsed (0) states,
 * for docking/collapsing side panels. Mirrors {@link AnimatedHeight}: an
 * explicit pixel width on the wrapper + a CSS transition tween, with overflow
 * clipped so content slides rather than reflows. Under `prefers-reduced-motion`
 * the global reset collapses the tween to a cut.
 *
 * Two modes: pass `width` for a fixed docked panel (collapses between that width
 * and 0, no observer); omit it to follow the content's natural width via
 * ResizeObserver. Set `animate={false}` while drag-resizing so the width tracks
 * the pointer without lag.
 *
 * Styling lives in `styles/components.css` (`.ds-animated-width`).
 */
export function AnimatedWidth({
  open = true,
  width,
  animate = true,
  children,
  className = '',
  style,
  ...props
}: AnimatedWidthProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);

  /**
   * Set the width, and don't tween the first one.
   *
   * A panel arriving already has an entrance; tweening its width as well means
   * animating a LAYOUT property, and everything sharing the row is re-laid out
   * on every frame of it. Measured on the chat stage: the conversation beside
   * it re-wrapped and re-centred six times in 200 ms as the panel opened from
   * zero, which is most of that page's layout shift.
   *
   * Matches `AnimatedHeight`, which mounts at its natural size for the same
   * reason and only animates what happens after.
   */
  const applyWidth = (outer: HTMLDivElement, target: string): void => {
    if (openedRef.current) {
      outer.style.width = target;
      return;
    }
    openedRef.current = true;
    const previous = outer.style.transition;
    outer.style.transition = 'none';
    outer.style.width = target;
    // Read it back so the untweened width is committed before transitions
    // return; without this the browser coalesces both writes and tweens anyway.
    void outer.offsetWidth;
    outer.style.transition = previous;
  };

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return undefined;

    // Fixed-width docked panel — collapse between the given width and 0, no observer.
    if (width !== undefined) {
      const w = toCssWidth(width);
      inner.style.width = w; // keep content laid out at full width while clipped
      applyWidth(outer, open ? w : '0px');
      return undefined;
    }

    // Content-driven mode (the AnimatedHeight twin). Guard ResizeObserver for
    // SSR / jsdom where it is absent.
    inner.style.width = '';
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyWidth(outer, open ? `${String(entry.contentRect.width)}px` : '0px');
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
    };
  }, [open, width]);

  return (
    <div
      ref={outerRef}
      className={`ds-animated-width ${className}`.trim()}
      style={{ ...style, ...(animate ? null : { transition: 'none' }) }}
      {...props}
    >
      <div ref={innerRef} className="ds-animated-width__inner">
        {children}
      </div>
    </div>
  );
}
