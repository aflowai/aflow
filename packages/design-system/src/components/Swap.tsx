'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';

// =============================================================================
// Swap
// =============================================================================

export interface SwapProps {
  /**
   * Identity of the currently-rendered content. When it changes, the
   * outgoing content slides up and fades out while the incoming content
   * rises in from below. Build it from whatever makes two states visually
   * distinct (e.g. an action label + detail signature).
   */
  swapKey: string | number;
  /** Content to render for the current `swapKey`. */
  children: ReactNode;
  className?: string;
}

interface SwapState {
  key: string | number;
  node: ReactNode;
  prevKey: string | number | null;
  prevNode: ReactNode;
  /** Bumped on every swap so the incoming/outgoing layers remount and
   *  re-fire their CSS animations. */
  cycle: number;
}

/**
 * Vertical content swap. A lightweight "ticker" that animates between two
 * states of inline content: the old content slides up + fades out, the new
 * content rises up from below. Used for the live "current action" subline
 * on a running task so each reported action transition reads as motion
 * instead of a hard cut.
 *
 * The current content is snapshotted at swap time, so `swapKey` must encode
 * everything visible (any content change that should animate has to change
 * the key). Under `prefers-reduced-motion` the global reset collapses the
 * slide to an instant cut.
 *
 * Styling lives in `styles/components.css` (`.ds-swap`).
 */
export function Swap({ swapKey, children, className = '' }: SwapProps) {
  const [state, setState] = useState<SwapState>({
    key: swapKey,
    node: children,
    prevKey: null,
    prevNode: null,
    cycle: 0,
  });

  // Update state when the key changes: snapshot the outgoing content and promote the incoming.
  useLayoutEffect(() => {
    setState((prev) => {
      if (swapKey === prev.key) return prev;
      return {
        key: swapKey,
        node: children,
        prevKey: prev.key,
        prevNode: prev.node,
        cycle: prev.cycle + 1,
      };
    });
  }, [swapKey, children]);

  const clearPrev = () => {
    setState((s) => (s.prevKey === null ? s : { ...s, prevKey: null, prevNode: null }));
  };

  return (
    <span className={`ds-swap ${className}`.trim()}>
      <span
        key={`in-${String(state.cycle)}`}
        className={state.cycle > 0 ? 'ds-swap__layer ds-swap__layer--in' : 'ds-swap__layer'}
      >
        {state.node}
      </span>
      {state.prevKey !== null && (
        <span
          key={`out-${String(state.cycle)}`}
          className="ds-swap__layer ds-swap__layer--out"
          aria-hidden="true"
          onAnimationEnd={clearPrev}
        >
          {state.prevNode}
        </span>
      )}
    </span>
  );
}
