'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_MARGIN = 20; // px from bottom counted as "at bottom"
const TOUCH_DEAD_ZONE = 2; // px before a touch swipe counts as a gesture
const USER_INPUT_WINDOW = 250; // ms after user input during which scroll events are trusted
const BURST_WINDOW = 450; // ms; growth within this of the last auto-scroll counts as a burst
const SCROLL_NEUTRAL_BUFFER_MS = 100; // ms past a height transition's declared end

/**
 * Where to scroll so the reader keeps the view they had, after content was
 * inserted above them.
 *
 * Distance from the BOTTOM is the invariant, not `scrollTop`. Everything below
 * the viewport keeps its offset when a list grows upward, so the same distance
 * from the bottom is the same view; holding `scrollTop` instead holds a pixel
 * offset that now names an older message, which is the jump this prevents.
 */
export function anchoredScrollTop(scrollHeight: number, distanceFromBottom: number): number {
  return Math.max(0, scrollHeight - distanceFromBottom);
}

/** Max value of a comma-separated CSS time list ("0.25s, 120ms"), in ms. */
function maxCssTimeMs(list: string): number {
  let max = 0;
  for (const part of list.split(',')) {
    const trimmed = part.trim();
    const value = Number.parseFloat(trimmed);
    if (Number.isNaN(value)) continue;
    max = Math.max(max, trimmed.endsWith('ms') ? value : value * 1000);
  }
  return max;
}

/**
 * Sticky-bottom scroll behavior.
 *
 * The two failure modes this is designed around:
 *  1. Position-based disengage races programmatic smooth-scrolls and rapid
 *     SSE bursts, so the view "gets stuck" above the threshold.
 *  2. Position-based disengage tied tightly to streaming makes the surface
 *     too sticky — every new token resets scroll, stealing the viewport
 *     while the user is reading earlier content.
 *
 * Solution: distinguish user intent from automatic scrolls.
 *
 *  - **User input → disengage immediately.** Wheel-up, touch swipe down,
 *    PageUp/ArrowUp/Home, mousedown on the scrollbar all flip pinned → false.
 *  - **Scroll position → re-engage only.** When scroll lands within
 *    `BOTTOM_MARGIN` we set pinned → true; we never set it false from a scroll
 *    event alone.
 *  - **Scroll position with recent user input → also disengage.** Catches
 *    scrollbar drags (which fire scroll without wheel/touch).
 *  - **ResizeObserver drives auto-scroll** when pinned. Only growth triggers
 *    a scroll — shrink (collapses, tab switches) is ignored.
 *  - **Height tweens are scroll-neutral** (no frame-by-frame chasing), but
 *    the first completed tween on a given element fires one explicit
 *    scroll-to-bottom so the initial content expansion (spinner → full card)
 *    still pulls itself into view.
 *
 * Attach `scrollRef` to the scrollable container, `contentRef` to a wrapper
 * around the dynamic content, and `onScroll` to the container. `isPinned` is
 * exposed as state for "scroll to latest" UI affordances.
 */
export function useAutoScrollToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isPinned, setIsPinnedState] = useState(true);
  const [isScrollable, setIsScrollable] = useState(false);
  const isPinnedRef = useRef(true);
  const rafId = useRef<number>(0);
  const touchY = useRef<number | null>(null);
  const lastUserInputAt = useRef(0);
  const lastAutoScrollAt = useRef(0);
  const scrollNeutralUntil = useRef(0);
  const pendingAnchor = useRef<number | null>(null);
  const hasAutoScrolled = useRef(false);

  const setPinned = useCallback((next: boolean) => {
    if (isPinnedRef.current === next) return;
    isPinnedRef.current = next;
    setIsPinnedState(next);
  }, []);

  const markUserInput = useCallback(() => {
    lastUserInputAt.current = Date.now();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setIsScrollable(el.scrollHeight > el.clientHeight);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_MARGIN;
    if (atBottom) {
      setPinned(true);
      return;
    }
    // Above bottom: only disengage if a recent user input attests this scroll
    // came from the user (e.g. scrollbar drag). Bare scroll events from our
    // own programmatic scrolls are ignored.
    if (Date.now() - lastUserInputAt.current < USER_INPUT_WINDOW) {
      setPinned(false);
    }
  }, [setPinned]);

  // Capture user-intent signals.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      markUserInput();
      if (e.deltaY < 0) setPinned(false);
    };
    const onTouchStart = (e: TouchEvent) => {
      markUserInput();
      touchY.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      markUserInput();
      const y = e.touches[0]?.clientY ?? null;
      if (y == null || touchY.current == null) return;
      // Finger drags down → content moves down → user wants earlier content.
      if (y > touchY.current + TOUCH_DEAD_ZONE) setPinned(false);
      touchY.current = y;
    };
    const onMouseDown = (e: MouseEvent) => {
      // Covers scrollbar drag — doesn't fire wheel/touch but does fire scroll.
      // Gate to the scrollbar gutter only: a mousedown on content (clicking a
      // button/link, selecting text) must NOT open the user-input window, or a
      // programmatic scroll firing within it (e.g. a smooth auto-scroll
      // mid-animation) would falsely disengage sticky-bottom — leaving the chat
      // stuck after a run completes until the user re-bottoms.
      const scrollbarWidth = el.offsetWidth - el.clientWidth;
      if (scrollbarWidth <= 0) return;
      if (e.clientX >= el.getBoundingClientRect().left + el.clientWidth) markUserInput();
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('mousedown', onMouseDown, { passive: true });

    // Keyboard scrolling fires keydown on whichever element has focus, not on
    // the scroll container itself. Listen at document level and only act when
    // focus is inside our container.
    const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (!active || !el.contains(active)) return;
      markUserInput();
      if (UP_KEYS.has(e.key)) setPinned(false);
    };
    document.addEventListener('keydown', onKey);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [markUserInput, setPinned]);

  // Auto-scroll on content growth when pinned.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Initial mount: jump to bottom while still pinned (the default). Mounting
    // a surface that already has history (chat resuming a thread, run
    // inspector opening a finished run) needs an explicit pin — `grew` would
    // be false since lastHeight already equals the rendered height. Always
    // instant: animating from the top on every load would be jarring.
    if (isPinnedRef.current) {
      const sc = scrollRef.current;
      if (sc) {
        sc.scrollTo({ top: sc.scrollHeight, behavior: 'auto' });
        setIsScrollable(sc.scrollHeight > sc.clientHeight);
      }
      lastAutoScrollAt.current = Date.now();
    }

    // Animated height reflows are layout settling, not new content — chasing
    // them yanks the viewport every time e.g. the workflow-run surface's
    // <AnimatedHeight> timeline grows or shrinks a row. Strategy:
    //
    //  • Any bubbling `height` transitionstart opens a scroll-neutral window
    //    sized to the transition's declared duration. Growth observed inside
    //    the window is absorbed without scrolling (suppresses frame-by-frame
    //    scroll chasing of the tween).
    //
    //  • BUT the very first time a given element completes its height tween
    //    (`transitionend`) we fire one explicit scroll-to-bottom. This covers
    //    the initial content-load case: when the workflow-run card expands
    //    from the loading spinner to the full task timeline, the user sees the
    //    whole card snap into view at the end of the animation rather than
    //    being stuck at the spinner height.
    //
    //  • Discrete content (a new message) mounts with no height transition and
    //    still auto-scrolls through the ResizeObserver path as before.
    const seenTransitionEls = new WeakSet<Element>();

    const onHeightTransitionStart = (e: TransitionEvent) => {
      if (e.propertyName !== 'height' || !(e.target instanceof Element)) return;
      const style = getComputedStyle(e.target);
      // Absolutely-positioned tweens (e.g. the Timeline progress fill) can't
      // move scrollHeight — don't let them open a window.
      if (style.position === 'absolute') return;
      const durationMs =
        maxCssTimeMs(style.transitionDuration) + maxCssTimeMs(style.transitionDelay);
      scrollNeutralUntil.current = Math.max(
        scrollNeutralUntil.current,
        Date.now() + durationMs + SCROLL_NEUTRAL_BUFFER_MS,
      );
      // A ResizeObserver tick can race transitionstart and queue a rAF scroll
      // before the neutral window is open. Cancel it — the transitionend path
      // will fire one clean scroll once the animation settles.
      cancelAnimationFrame(rafId.current);
    };

    const onHeightTransitionEnd = (e: TransitionEvent) => {
      if (e.propertyName !== 'height' || !(e.target instanceof Element)) return;
      const style = getComputedStyle(e.target);
      if (style.position === 'absolute') return;
      // Only act on the first completed tween per element — that's the initial
      // content settling into its full height. Subsequent tweens (row updates,
      // subline changes) are pure layout settling and should stay silent.
      if (seenTransitionEls.has(e.target)) return;
      seenTransitionEls.add(e.target);
      if (!isPinnedRef.current) return;
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el || !isPinnedRef.current) return;
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        lastAutoScrollAt.current = Date.now();
      });
    };

    content.addEventListener('transitionstart', onHeightTransitionStart, { passive: true });
    content.addEventListener('transitionend', onHeightTransitionEnd, { passive: true });

    let lastHeight = content.getBoundingClientRect().height;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const height = entry.contentRect.height;
      const grew = height > lastHeight;
      lastHeight = height;
      const sc = scrollRef.current;
      if (sc) setIsScrollable(sc.scrollHeight > sc.clientHeight);
      if (!grew || !isPinnedRef.current) return;
      if (Date.now() < scrollNeutralUntil.current) return;
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        const now = Date.now();
        // Smooth for an isolated arrival (a new message after a lull); snap
        // during rapid bursts (streaming, fast task ticks) where chasing the
        // live edge smoothly would lag behind it and stack animations.
        const isBurst = now - lastAutoScrollAt.current < BURST_WINDOW;
        lastAutoScrollAt.current = now;
        // The first one snaps. A conversation being shown is not a message
        // arriving after a lull — smoothing it makes the reader watch the view
        // travel to where it should have opened, and every frame of that
        // travel is a layout shift. Measured on a 60-message session: the last
        // message tracked from 872px to 613px over ~20 frames, 0.2 of the
        // page's CLS, for an animation nobody asked to see.
        const isFirst = !hasAutoScrolled.current;
        hasAutoScrolled.current = true;
        el.scrollTo({
          top: el.scrollHeight,
          behavior: isFirst || isBurst || prefersReducedMotion ? 'auto' : 'smooth',
        });
      });
    });
    ro.observe(content);
    return () => {
      content.removeEventListener('transitionstart', onHeightTransitionStart);
      content.removeEventListener('transitionend', onHeightTransitionEnd);
      ro.disconnect();
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [setPinned]);

  /**
   * Hold the reader's place while content is inserted ABOVE them. Capture
   * before asking for the page, restore once it has been laid out.
   */
  /**
   * Forget that this conversation has been opened.
   *
   * `ChatLayout` outlives the session it shows — switching sessions swaps the
   * content under a mounted hook — so a latch that only ever set once meant the
   * first conversation opened snapped and every one after it animated in from
   * the top. The boundary is the content being replaced, which only the caller
   * can see.
   */
  const resetAutoScroll = useCallback(() => {
    hasAutoScrolled.current = false;
    pendingAnchor.current = null;
  }, []);

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pendingAnchor.current = el.scrollHeight - el.scrollTop;
  }, []);

  /** No-op unless a capture is outstanding, so the caller can fire it on every render. */
  const restoreAnchor = useCallback(() => {
    const el = scrollRef.current;
    const distanceFromBottom = pendingAnchor.current;
    if (!el || distanceFromBottom === null) return;
    pendingAnchor.current = null;
    el.scrollTop = anchoredScrollTop(el.scrollHeight, distanceFromBottom);
  }, []);

  return {
    scrollRef,
    contentRef,
    onScroll,
    isPinned,
    isScrollable,
    scrollToBottom,
    captureAnchor,
    restoreAnchor,
    resetAutoScroll,
  };
}
