'use client';

import { useEffect } from 'react';

/** How long a scroll container keeps its scrollbar after its last scroll. */
const REVEAL_AFTER_SCROLL_MS = 900;

/**
 * Marks whatever is scrolling with `data-scrolling` until it has been still
 * for a moment, so the base stylesheet shows its scrollbar while it moves and
 * hides it again after. CSS has no selector for a scrolling element. One
 * passive listener on the document serves every scroll container, as scroll
 * events reach it in the capture phase.
 */
export function useScrollbarReveal(): void {
  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target =
        event.target === document ? document.documentElement : (event.target as Element | null);
      if (!(target instanceof Element)) return;
      if (!target.hasAttribute('data-scrolling')) target.setAttribute('data-scrolling', '');
      clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(() => {
          target.removeAttribute('data-scrolling');
        }, REVEAL_AFTER_SCROLL_MS),
      );
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, []);
}
