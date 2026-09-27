'use client';

import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { Sheet } from '../overlays/Sheet.js';
import { useModalA11y } from '../overlays/useModalA11y.js';
import { peekPanelShouldUseSheet, peekPanelNextFocusOnTab } from './peekPanelHelpers.js';

// Re-exports so existing consumers (`@aflow/design-system`) keep their
// import paths after the helper extraction.
export { peekPanelShouldUseSheet, peekPanelNextFocusOnTab };

// ============================================================================
// Public API
// ============================================================================

export interface PeekPanelProps {
  /** Whether the panel is open. */
  open: boolean;
  /** Panel title. Used as `aria-label` on the dialog root. */
  title: string;
  /** Optional breadcrumb trail rendered in the header. */
  breadcrumb?: string[];
  /** Close handler. Wired to escape, the close button, and back. */
  onClose: () => void;
  /** Initial width on desktop. Clamped to [MIN_WIDTH, MAX_WIDTH]. */
  width?: number | string;
  /** Footer content (typically action buttons). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  mobileBreakpointPx?: number;
}

// ============================================================================
// Internal constants
// ============================================================================
//
// Pure helpers live in `./peekPanelHelpers.ts` so `Sheet` can share them via
// `useModalA11y` without circular imports.

const KEYFRAMES_ID = '__peek-panel-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `
@keyframes peek-slide-in {
  from { transform: translateX(100%); opacity: 0.8; }
  to   { transform: translateX(0);    opacity: 1; }
}`;
  document.head.appendChild(style);
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_MOBILE_BREAKPOINT_PX = 640;

// ============================================================================
// Hook: useViewportWidth — small subscription used only by PeekPanel.
// ============================================================================

function useViewportWidth(): number | undefined {
  const [width, setWidth] = useState<number | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return window.innerWidth;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => {
      setWidth(window.innerWidth);
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
    };
  }, []);
  return width;
}

// ============================================================================
// Component
// ============================================================================

export function PeekPanel({
  open,
  title,
  breadcrumb,
  onClose,
  width: initialWidth = 400,
  footer,
  children,
  className,
  style,
  mobileBreakpointPx = DEFAULT_MOBILE_BREAKPOINT_PX,
}: PeekPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [currentWidth, setCurrentWidth] = useState(
    typeof initialWidth === 'number' ? initialWidth : 400,
  );
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);

  const viewportWidth = useViewportWidth();
  const useSheet = peekPanelShouldUseSheet(viewportWidth, mobileBreakpointPx);

  // -------- Escape handler --------
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    },
    [open, onClose],
  );
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  // -------- Resize drag (desktop variant only) --------
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStartRef.current = { x: e.clientX, w: currentWidth };
      setIsDragging(true);
    },
    [currentWidth],
  );
  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.x - e.clientX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartRef.current.w + delta));
      setCurrentWidth(newWidth);
    };
    const handleUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  // -------- Modal a11y: previous-focus capture, focus trap, sibling
  //          `inert`. Shared with Sheet via `useModalA11y` so the contract
  useModalA11y({ enabled: open && !useSheet, containerRef: panelRef });

  // Ensure the slide-in keyframes are registered once the panel is open.
  useEffect(() => {
    if (open && !useSheet) ensureKeyframes();
  }, [open, useSheet]);

  if (!open) return null;

  // Responsive collapse — render Sheet instead of side panel on narrow
  // viewports. Sheet brings its own a11y (aria-modal, escape, body lock).
  if (useSheet) {
    return (
      <Sheet open={open} title={title} onClose={onClose} closeIcon="x" footer={footer}>
        {children}
      </Sheet>
    );
  }

  const panelStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: currentWidth,
    background: 'var(--color-surface-2)',
    borderLeft: '1px solid var(--color-border-subtle)',
    zIndex: 'var(--z-overlay)' as unknown as number,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    animation: 'peek-slide-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.12)',
    ...style,
  };

  return (
    <div
      ref={panelRef}
      className={className}
      style={panelStyle}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      {/* Resize handle (left edge) */}
      <div
        onMouseDown={handleDragStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 2,
            height: 32,
            borderRadius: 1,
            background: isDragging
              ? 'var(--color-content-muted, #666)'
              : 'var(--color-border-subtle, #333)',
            transition: isDragging ? 'none' : 'background 150ms',
          }}
        />
      </div>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-cybernetic-ink-muted)',
            cursor: 'pointer',
            padding: 'var(--space-1)',
            fontSize: 'var(--font-size-lg)',
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {'✕'}
        </button>

        {breadcrumb && breadcrumb.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              fontFamily: 'var(--font-family-system)',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-cybernetic-ink-muted)',
            }}
          >
            {breadcrumb.map((segment, i) => (
              <span key={i}>
                {i > 0 && <span style={{ margin: '0 var(--space-1)' }}>{'›'}</span>}
                {segment}
              </span>
            ))}
          </div>
        )}

        <div
          style={{
            flex: 1,
            fontFamily: 'var(--font-family-sans)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-medium)' as unknown as number,
            color: 'var(--color-cybernetic-ink)',
            textAlign: 'right',
          }}
        >
          {title}
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 'var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>

      {/* Footer */}
      {footer && (
        <div
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderTop: '1px solid var(--color-border-subtle)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
