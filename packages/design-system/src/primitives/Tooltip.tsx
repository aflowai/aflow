'use client';

import {
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useCallback,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  /** Tooltip content */
  content: string;
  /** Trigger element */
  children: ReactNode;
  /** Placement */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Delay before showing in ms */
  delayMs?: number;
  /**
   * When true, content wraps within a max width (and scrolls if very tall).
   * Use for longer strings; short labels stay single-line when wrap is false.
   */
  wrap?: boolean | undefined;
}

const GAP = 8;

export function Tooltip({
  content,
  children,
  side = 'right',
  delayMs = 400,
  wrap = false,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setVisible(true);
    }, delayMs);
  }, [delayMs]);

  const hide = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setVisible(false);
    setPosition(null);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handlePointerDown = () => {
      hide();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [hide, visible]);

  useLayoutEffect(() => {
    if (!visible || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    switch (side) {
      case 'right':
        setPosition({ top: centerY, left: rect.right + GAP });
        break;
      case 'left':
        setPosition({ top: centerY, left: rect.left - GAP });
        break;
      case 'top':
        setPosition({ top: rect.top - GAP, left: centerX });
        break;
      case 'bottom':
        setPosition({ top: rect.bottom + GAP, left: centerX });
        break;
    }
  }, [visible, side]);

  // Portal positioning: use fixed so tooltip is never clipped by parent overflow
  const getPortalStyle = (): CSSProperties => {
    if (!position) return {};
    switch (side) {
      case 'right':
        return {
          position: 'fixed' as const,
          left: position.left,
          top: position.top,
          transform: 'translateY(-50%)',
        };
      case 'left':
        return {
          position: 'fixed' as const,
          left: position.left,
          top: position.top,
          transform: 'translateY(-50%) translateX(-100%)',
        };
      case 'top':
        return {
          position: 'fixed' as const,
          left: position.left,
          top: position.top,
          transform: 'translateX(-50%) translateY(-100%)',
        };
      case 'bottom':
        return {
          position: 'fixed' as const,
          left: position.left,
          top: position.top,
          transform: 'translateX(-50%)',
        };
      default:
        return {};
    }
  };

  return (
    <>
      <span
        ref={triggerRef}
        className="ds-tooltip"
        style={{ position: 'relative' }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={hide}
      >
        {children}
      </span>
      {visible &&
        position &&
        createPortal(
          <span
            className={[
              'ds-tooltip__content',
              'ds-tooltip__content--portal',
              wrap ? 'ds-tooltip__content--wrap' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="tooltip"
            style={getPortalStyle()}
          >
            {content}
          </span>,
          document.body,
        )}
    </>
  );
}
