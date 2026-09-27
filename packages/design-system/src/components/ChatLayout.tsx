'use client';

/**
 * ChatLayout — Full-height flex column for chat UIs.
 * Messages area fills available space, composer is pinned to bottom.
 * Responsive: reduces padding and max-width on mobile.
 *
 * Uses the Visual Viewport API on mobile to keep the composer visible
 * above the iOS/Android virtual keyboard — prevents the page from
 * scrolling the header off-screen when the keyboard opens.
 */
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useContext,
  useMemo,
  createContext,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useAutoScrollToBottom } from '../hooks/useAutoScrollToBottom.js';

export interface ChatLayoutProps {
  /** Header slot (optional) */
  header?: ReactNode;
  /** Message list area */
  children: ReactNode;
  /** Composer / input area at the bottom */
  composer?: ReactNode;
}

/**
 * Sticky-bottom scroll state, published by ChatLayout (which owns the scroll
 * container) to its message-area descendants. A "scroll to latest" affordance
 * deep in the tree reads this instead of threading props — and because the
 * scroll hook lives in ChatLayout, it survives ChatLayout remounts (e.g. the
 * page swapping the chat between split-pane and full-width layouts) that would
 * orphan a hook owned higher up.
 */
export interface ChatScrollState {
  /** False once the user has scrolled up away from the bottom. */
  isPinned: boolean;
  /** True when content overflows the viewport (i.e. there is something above to scroll to). */
  isScrollable: boolean;
  /** Re-pin and smooth-scroll to the latest content. */
  scrollToBottom: () => void;
  /**
   * Record the reader's place before content is inserted above them — older
   * history arriving, a card expanding upward. Pair with `restoreAnchor`.
   */
  captureAnchor: () => void;
  /** Put the reader back where `captureAnchor` left them. No-op without one. */
  restoreAnchor: () => void;
  /**
   * Forget that a conversation has been opened here, so the next one to arrive
   * snaps to its end rather than animating there. Call when the content is
   * replaced — this layout outlives the session it shows.
   */
  resetAutoScroll: () => void;
}

const ChatScrollContext = createContext<ChatScrollState>({
  isPinned: true,
  isScrollable: false,
  scrollToBottom: () => {},
  captureAnchor: () => {},
  restoreAnchor: () => {},
  resetAutoScroll: () => {},
});

/** Read ChatLayout's sticky-bottom scroll state (for "new content" affordances). */
export function useChatScroll(): ChatScrollState {
  return useContext(ChatScrollContext);
}

/**
 * Track the Visual Viewport height on mobile.
 * When the iOS keyboard opens, `window.visualViewport.height` shrinks
 * while `window.innerHeight` (layout viewport) stays the same.
 * We use the delta to inset the composer from the bottom.
 */
function useVisualViewportInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.visualViewport) return;

    const vv = window.visualViewport;
    const update = () => {
      // offsetTop accounts for address bar, height is the visible area
      const keyboardInset = window.innerHeight - (vv.height + vv.offsetTop);
      setInset(Math.max(0, keyboardInset));
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();

    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return inset;
}

export function ChatLayout({ header, children, composer }: ChatLayoutProps) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  const keyboardInset = useVisualViewportInset(isMobile);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // The composer floats over the scroller, so the messages reserve the height
  // it actually occupies. It is not a fixed bar: banners, elicitation cards and
  // the mobile stage all ride the same slot, and a constant reserve hides the
  // newest messages behind whichever of them is showing.
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === 'number') setComposerHeight(h);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [composer == null]);

  // Sticky-bottom scroll lives here because ChatLayout owns the actual
  // overflow:auto scroller AND the stable content wrapper — both mount and
  // remount together, so the hook's ResizeObserver is never orphaned.
  const {
    scrollRef,
    contentRef,
    onScroll,
    isPinned,
    isScrollable,
    scrollToBottom,
    captureAnchor,
    restoreAnchor,
    resetAutoScroll,
  } = useAutoScrollToBottom();

  // The scroller is both the keyboard-scroll target (internal `messagesRef`)
  // and the autoscroll hook's `scrollRef`. Fan the node out to both.
  const setMessagesNode = useCallback(
    (node: HTMLDivElement | null) => {
      messagesRef.current = node;
      (scrollRef as { current: HTMLDivElement | null }).current = node;
    },
    [scrollRef],
  );

  const scrollState = useMemo<ChatScrollState>(
    () => ({
      isPinned,
      isScrollable,
      scrollToBottom,
      captureAnchor,
      restoreAnchor,
      resetAutoScroll,
    }),
    [isPinned, isScrollable, scrollToBottom, captureAnchor, restoreAnchor, resetAutoScroll],
  );

  // When keyboard appears (inset > 0), scroll messages to bottom
  const prevInsetRef = useRef(0);
  useEffect(() => {
    if (keyboardInset > 0 && prevInsetRef.current === 0 && messagesRef.current) {
      // Small delay to let layout settle
      requestAnimationFrame(() => {
        messagesRef.current?.scrollTo({
          top: messagesRef.current.scrollHeight,
          behavior: 'smooth',
        });
      });
    }
    prevInsetRef.current = keyboardInset;
  }, [keyboardInset]);

  // Prevent iOS Safari from scrolling the outer page when keyboard opens
  const preventOuterScroll = useCallback(
    (e: TouchEvent) => {
      if (!isMobile || !wrapperRef.current) return;
      // Only prevent scroll on the wrapper itself — allow inner scrollable areas
      if (e.target === wrapperRef.current) {
        e.preventDefault();
      }
    },
    [isMobile],
  );

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || !isMobile) return;
    el.addEventListener('touchmove', preventOuterScroll, { passive: false });
    return () => {
      el.removeEventListener('touchmove', preventOuterScroll);
    };
  }, [isMobile, preventOuterScroll]);

  const wrapperStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    // On mobile with keyboard, reduce the visible height
    ...(isMobile && keyboardInset > 0 ? { paddingBottom: keyboardInset } : {}),
  };

  // The dark box (messagesStyle) is full-bleed: it flexes to the pane width so
  // the surface reads as a wide card. The max-width clamp lives one level in —
  // on the message content (contentConstraintStyle) and the composer — so the
  // *chat* stays readable-width and centered while the *box* fills the space.
  // Don't move maxWidth back up to innerStyle: that re-couples box and content.
  const innerStyle: CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    width: '100%',
  };

  const composerBottomOffset = isMobile ? 'calc(8px + env(safe-area-inset-bottom))' : '30px';

  const messagesStyle: CSSProperties = {
    flex: '1 1 0%',
    overflow: 'auto',
    // Enables momentum scrolling on iOS
    WebkitOverflowScrolling: 'touch',
    overscrollBehavior: 'contain',
    paddingBottom: composer
      ? `calc(${String(composerHeight)}px + ${composerBottomOffset} + var(--space-6))`
      : 0,
    margin: 'var(--space-2-5)',
    borderRadius: 'var(--space-2xl)',
    backgroundColor: 'var(--surface-overlay-alpha)',
  };

  const contentConstraintStyle: CSSProperties = {
    maxWidth: 'var(--layout-content-max-width)',
    marginInline: 'auto',
    // Flex (not just minHeight) so a `flex: 1` child (e.g. an empty state) can
    // fill and vertically center in the scroll box — min-height alone doesn't
    // give percentage-height children a definite height to resolve against.
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100%',
  };

  const composerWrapperStyle: CSSProperties = {
    position: 'absolute',
    bottom: composerBottomOffset,
    left: isMobile ? 'var(--space-3)' : 'var(--space-5)',
    right: isMobile ? 'var(--space-3)' : 'var(--space-5)',
    // Center within the left/right insets and cap at content width, so the
    // composer tracks the message column even though the box is full-bleed.
    maxWidth: 'var(--layout-content-max-width)',
    marginInline: 'auto',
    zIndex: 2,
  };

  return (
    <div ref={wrapperRef} style={wrapperStyle}>
      {header}
      <div style={innerStyle}>
        <div
          ref={setMessagesNode}
          onScroll={onScroll}
          style={messagesStyle}
          className="ds-scroll-subtle"
        >
          <div ref={contentRef} style={contentConstraintStyle}>
            <ChatScrollContext.Provider value={scrollState}>{children}</ChatScrollContext.Provider>
          </div>
        </div>
        {composer && (
          <div ref={composerRef} style={composerWrapperStyle}>
            {composer}
          </div>
        )}
      </div>
    </div>
  );
}
