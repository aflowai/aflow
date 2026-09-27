'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// =============================================================================
// SwapStack
// =============================================================================

export interface SwapStackProps {
  /**
   * Identity of the current (bottom) content. When it changes, the new
   * content rolls in at the bottom, the existing lines shift up one notch and
   * dim with age, and the oldest line slides up + fades out the top. Build it
   * from whatever makes two states visually distinct (e.g. an action label +
   * detail signature).
   */
  swapKey: string | number;
  /** Content to render for the current `swapKey`. */
  children: ReactNode;
  /** Maximum number of trail lines kept on screen (newest + history). */
  depth?: number;
  className?: string;
}

interface StackEntry {
  /** Unique per push (the cycle it was created at). The React key — the content
   *  `key` can legitimately recur in the trail (e.g. a step runs, another runs,
   *  then the first runs again), so it can't double as the list key. */
  id: number;
  /** Content identity — decides when a new line rolls in. */
  key: string | number;
  node: ReactNode;
}

interface StackState {
  /** Newest last. Length ≤ depth. */
  entries: StackEntry[];
  /** The just-evicted oldest line, kept for the duration of one roll so it
   *  can animate out the top instead of vanishing. */
  exiting: StackEntry | null;
  /** Bumped on every roll so the FLIP effect re-fires. */
  cycle: number;
}

/** Opacity by rank-from-bottom (0 = current). Falls back to the last value
 *  for any rank beyond the table, so a larger `depth` still degrades cleanly. */
const OPACITY_RAMP = [1, 0.55, 0.32];

function rankOpacity(rankFromBottom: number): number {
  return OPACITY_RAMP[Math.min(rankFromBottom, OPACITY_RAMP.length - 1)] ?? 1;
}

/**
 * Vertical rolling trail. Where {@link Swap} shows a single live line and
 * discards the previous one, `SwapStack` keeps the last `depth` distinct
 * states as a short, age-dimmed column: the current action sits at the bottom
 * in full color, recent history rises above it progressively fainter. Each new
 * `swapKey` rolls the whole column up one line (the existing in/out motion of
 * `Swap`, extended to a trail) — used for the live "current action" subline on
 * a running workflow task so an operator can see the last few steps, not just
 * the instantaneous one.
 *
 * History is kept in component state only (it's ephemeral live decoration); on
 * remount it rebuilds from the next few events. The current node is snapshotted
 * at swap time, so `swapKey` must encode everything visible. Under
 * `prefers-reduced-motion` the global reset collapses the roll to an instant
 * cut.
 *
 * Styling lives in `styles/components.css` (`.ds-swap-stack`).
 */
export function SwapStack({ swapKey, children, depth = 3, className = '' }: SwapStackProps) {
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const [state, setState] = useState<StackState>({
    entries: [{ id: 0, key: swapKey, node: children }],
    exiting: null,
    cycle: 0,
  });

  // Push a new entry when the key changes; stage the evicted oldest for exit.
  // (Same-key children updates are ignored — the detail is folded into the key,
  // exactly as `Swap` does, so this never loops on fresh JSX identity.)
  useLayoutEffect(() => {
    setState((prev) => {
      const head = prev.entries[prev.entries.length - 1];
      if (head?.key === swapKey) return prev;
      const cycle = prev.cycle + 1;
      const next = [...prev.entries, { id: cycle, key: swapKey, node: children }];
      const exiting = next.length > depth ? (next.shift() ?? null) : null;
      return { entries: next, exiting, cycle };
    });
  }, [swapKey, children, depth]);

  // FLIP the track up one line on each roll: snap it down by one line with no
  // transition, force a reflow so that start frame sticks, then release to rest
  // with a transition. The bottom-pinned track clips the outgoing line off the
  // top and reveals the incoming line rising in at the bottom.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || state.cycle === 0) return;
    track.style.transition = 'none';
    track.style.transform = 'translateY(var(--ds-swap-stack-line-h))';
    void track.offsetHeight;
    track.style.transition = 'transform var(--ds-swap-stack-dur) var(--ds-swap-stack-ease)';
    track.style.transform = 'translateY(0)';
  }, [state.cycle]);

  // Drop the staged exit line once its roll completes. A function with a
  // narrower param is structurally assignable to React's handler type.
  const clearExiting = (e: { propertyName: string }) => {
    if (e.propertyName !== 'transform') return;
    setState((s) => (s.exiting === null ? s : { ...s, exiting: null }));
  };

  const visibleCount = Math.min(state.entries.length, depth);

  return (
    <span
      className={`ds-swap-stack ${className}`.trim()}
      style={{ height: `calc(${String(visibleCount)} * var(--ds-swap-stack-line-h))` }}
    >
      <span ref={trackRef} className="ds-swap-stack__track" onTransitionEnd={clearExiting}>
        {state.exiting && (
          <span
            key={`exit-${String(state.cycle)}`}
            className="ds-swap-stack__line ds-swap-stack__line--exit"
          >
            {state.exiting.node}
          </span>
        )}
        {state.entries.map((entry, i) => {
          const rankFromBottom = state.entries.length - 1 - i;
          const current = rankFromBottom === 0;
          return (
            <span
              key={`e-${String(entry.id)}`}
              className={`ds-swap-stack__line${current ? ' ds-swap-stack__line--current' : ''}`}
              style={{ opacity: rankOpacity(rankFromBottom) }}
            >
              {entry.node}
            </span>
          );
        })}
      </span>
    </span>
  );
}
