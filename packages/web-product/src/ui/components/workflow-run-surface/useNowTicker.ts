'use client';

import { useEffect, useState } from 'react';

const TICK_INTERVAL_MS = 1000;

/**
 * Returns a `nowMs` value that advances roughly once per second while
 * `active === true`. Stable (no advancement) when inactive or under
 * `prefers-reduced-motion: reduce`.
 */
export function useNowTicker(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!active) return;
    if (typeof window === 'undefined') return; // SSR safety
    // Respect reduced-motion preference: freeze the ticker.
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    let rafId = 0;
    let lastTick = performance.now();
    const tick = (t: number) => {
      if (t - lastTick >= TICK_INTERVAL_MS) {
        setNow(Date.now());
        lastTick = t;
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [active]);

  return now;
}
