'use client';

import { useState, useRef, useCallback, type ReactNode, type CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ResizablePanelProps {
  children: ReactNode;
  /** Which side the resize handle appears on */
  side: 'left' | 'right';
  /** Initial width in px */
  defaultWidth: number;
  /** Minimum width in px */
  minWidth?: number | undefined;
  /** Maximum width in px */
  maxWidth?: number | undefined;
  /** Extra styles on the container */
  style?: CSSProperties | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResizablePanel({
  children,
  side,
  defaultWidth,
  minWidth = 180,
  maxWidth = 700,
  style,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = ev.clientX - startX.current;
        // If handle is on the left side of the panel, dragging left = wider
        const newWidth = side === 'left' ? startWidth.current - delta : startWidth.current + delta;
        setWidth(Math.min(maxWidth, Math.max(minWidth, newWidth)));
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, side, minWidth, maxWidth],
  );

  const handleStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 6,
    cursor: 'col-resize',
    zIndex: 5,
    // Visible on hover
    transition: 'background 150ms',
    ...(side === 'left' ? { left: -3 } : { right: -3 }),
  };

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* Drag handle */}
      <div
        style={handleStyle}
        onMouseDown={handleMouseDown}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = 'var(--color-interactive-default)';
        }}
        onMouseLeave={(e) => {
          if (!isDragging.current) {
            (e.currentTarget as HTMLDivElement).style.background = 'transparent';
          }
        }}
        title="Drag to resize"
      />
      {children}
    </div>
  );
}
