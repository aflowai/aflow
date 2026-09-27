'use client';

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * How many items may appear at once and still read as arriving.
 *
 * A turn lands a message and sometimes a card or a separator beside it. A
 * conversation being shown — hydrating on open, or a page of older history
 * loading in — lands tens at once. The gap between the two is wide enough that
 * the exact line does not matter, only that it sits above one turn's worth.
 */
export const MAX_ARRIVING_ITEMS = 4;

/**
 * Whether the change from `previouslyShown` to `itemCount` reads as messages
 * arriving rather than a conversation being shown.
 */
export function isArrivingBatch(previouslyShown: number, itemCount: number): boolean {
  const added = itemCount - previouslyShown;
  return previouslyShown > 0 && added > 0 && added <= MAX_ARRIVING_ITEMS;
}

/**
 * Whether what just mounted is a message arriving or a conversation being shown.
 *
 * Every bubble plays a soft entrance when it mounts as final content, which is
 * right for the message that arrives while you are reading and wrong for the
 * two hundred that mount together when a conversation opens. Measured on a
 * 208-message session, that cascade was the largest layout-shift cluster on the
 * page — CLS 2.61 against a 0.1 threshold — and several of the animations
 * reported no visible change at all, so the cost bought nothing.
 *
 * Counting is what makes this hold. Latching on "the transcript has been shown
 * once" settled a frame after the component mounted, which is *before* the
 * snapshot arrives — so every bubble in it still read `true` and still
 * animated. Size of the change is the honest signal: it does not care whether
 * the items came from a first paint, a re-hydrate, or a page of older history,
 * all three of which are a conversation appearing rather than a message.
 */
const TranscriptEntranceContext = createContext(false);

export function TranscriptEntranceProvider({
  itemCount,
  children,
}: {
  /** Items currently rendered in the transcript. */
  itemCount: number;
  children: ReactNode;
}) {
  // Read during render so the bubbles mounting in THIS commit see the verdict
  // on their own arrival — they latch it in a `useState` initializer, so a
  // value published afterwards would always be one commit too late. The ref is
  // only written in the layout effect, which keeps the render itself pure and
  // gives StrictMode's double render the same answer twice.
  const shownRef = useRef(0);
  const arriving = isArrivingBatch(shownRef.current, itemCount);

  useLayoutEffect(() => {
    shownRef.current = itemCount;
  }, [itemCount]);

  return (
    <TranscriptEntranceContext.Provider value={arriving}>
      {children}
    </TranscriptEntranceContext.Provider>
  );
}

/** True when a bubble mounting now is a message arriving, not history being shown. */
export function useTranscriptSettled(): boolean {
  return useContext(TranscriptEntranceContext);
}
