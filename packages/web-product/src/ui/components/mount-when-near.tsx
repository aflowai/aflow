'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Mount an expensive card only while it is near the viewport, and hold its
 * place with the height it actually took when it is not.
 *
 * A conversation's inline cards are documents, not decorations: every artifact
 * and every frozen applet is a sandboxed iframe with its own JS context and its
 * own scripts. A session that renders a board per turn keeps every historical
 * board alive — measured at 25 live iframes on one chess session, none of them
 * on screen, against a tab reported at 900 MB to 1.5 GB.
 *
 * They cost layout as well as memory. Each iframe paints at its declared
 * minimum height and jumps to its real one when the artifact inside posts back,
 * so every card off screen is also a shift waiting to push the transcript when
 * its script gets around to loading.
 *
 * **Only for content that can be rebuilt from its inputs** — a stateless
 * artifact render, or a frozen applet snapshot. A live applet holds subscriptions
 * and state that unmounting would throw away.
 */
export interface MountWhenNearProps {
  /**
   * Height to hold before this has ever been measured. Pass the same number the
   * child declares as its minimum — not an estimate of the content, which is
   * how a reserved height ends up causing the shift it was added to prevent.
   */
  reserve: number;
  /**
   * How far outside the viewport still counts as near. Generous by default:
   * mounting late enough for the reader to see a gap is worse than holding a
   * few extra documents.
   */
  rootMargin?: string;
  children: ReactNode;
}

/**
 * The height to hold, given what has been measured so far and what just came in.
 *
 * Only ever grows. A card caught mid-mount reports a height it is about to
 * leave — an iframe still at its minimum before the document inside reports
 * back — and holding the smaller of the two collapses the transcript the moment
 * the card scrolls away.
 */
export function nextReservedHeight(measured: number | null, incoming: number): number | null {
  if (!Number.isFinite(incoming) || incoming <= 0) return measured;
  if (measured !== null && incoming <= measured) return measured;
  return incoming;
}

export function MountWhenNear({ reserve, rootMargin = '200%', children }: MountWhenNearProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Without IntersectionObserver there is no way to tell near from far, and the
  // safe direction is showing the card.
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const measuredRef = useRef<number | null>(null);
  const [reserved, setReserved] = useState(reserve);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setNear(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [rootMargin]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !near || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (typeof height !== 'number') return;
      const next = nextReservedHeight(measuredRef.current, height);
      if (next !== null && next !== measuredRef.current) {
        measuredRef.current = next;
        setReserved(next);
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [near]);

  return (
    <div
      ref={ref}
      style={near ? undefined : { height: reserved }}
      aria-busy={near ? undefined : true}
    >
      {near ? children : null}
    </div>
  );
}
