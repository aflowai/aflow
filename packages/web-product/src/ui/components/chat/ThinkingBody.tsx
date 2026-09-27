'use client';

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react';
import { Icon } from '@aflow/design-system';

/**
 * Wrap streaming-thinking content in a bottom-anchored scroll region with an
 * expand toggle. Sticks to the bottom while content grows, so the user always
 * sees the latest tokens; if the user scrolls up to read earlier reasoning,
 * auto-scroll pauses until they return to the bottom.
 */
export function ThinkingBody({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // 8px slack so the sticky bit re-engages when the user is "near enough" to bottom.
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  }, []);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      // When the user collapses, treat it as a return-to-live: re-stick to bottom.
      if (prev) stickToBottomRef.current = true;
      return !prev;
    });
  }, []);

  return (
    <div className={`chat-thinking-box ${expanded ? 'chat-thinking-box--expanded' : ''}`}>
      <button
        type="button"
        className="chat-thinking-toggle"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse thinking' : 'Expand thinking'}
      >
        <Icon name={expanded ? 'caret-up' : 'caret-down'} size="xs" />
      </button>
      <div ref={scrollRef} className="chat-thinking-scroll" onScroll={handleScroll}>
        {children}
      </div>
    </div>
  );
}
