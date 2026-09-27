'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AnimatedWidth } from '../components/AnimatedWidth.js';
import { Icon, type IconName } from '../icons/Icon.js';
import { Text } from '../primitives/Text.js';

const RAIL_WIDTH = 40;

const paneSurface: React.CSSProperties = {
  height: '100%',
  background: 'var(--surface-overlay-alpha)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-xs)',
  overflow: 'hidden',
};

export interface CollapsibleSideProps {
  /** Which edge it docks to (handle + chevrons mirror accordingly). */
  side: 'left' | 'right';
  /** Expanded width when uncontrolled (drag adjusts within min/max). */
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  defaultCollapsed?: boolean;
  icon: IconName;
  label: string;
  /** Attention count shown on the collapsed rail. */
  badge?: number;
  children: ReactNode;
  /**
   * Controlled expanded width (px). When provided, the parent drives the width
   * (e.g. a chat dock that resizes with session state) and width changes
   * animate. Drag still works if `onWidthChange` is supplied — the parent
   * decides how to reconcile a user drag with its own width. Omit for the
   * uncontrolled drag-to-resize dock.
   */
  width?: number;
  /** Called on drag-resize. Required to allow dragging under controlled `width`. */
  onWidthChange?: (width: number) => void;
  /** Controlled collapsed state. Omit for internal (uncontrolled) collapse. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

/**
 * A docked panel that resizes (drag handle on the content-facing edge) and
 * collapses to a thin rail with an optional attention badge. Width animates via
 * `AnimatedWidth`; the tween is suppressed mid-drag so resizing tracks the
 * pointer. Uncontrolled by default (drag + internal collapse); pass `width` /
 * `collapsed` to drive it from the parent.
 */
export function CollapsibleSide({
  side,
  defaultWidth,
  minWidth = 200,
  maxWidth = 560,
  defaultCollapsed = false,
  icon,
  label,
  badge,
  children,
  width: controlledWidth,
  onWidthChange,
  collapsed: controlledCollapsed,
  onCollapsedChange,
}: CollapsibleSideProps) {
  const [internalWidth, setInternalWidth] = useState(defaultWidth);
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ startX: 0, startW: 0 });

  const width = controlledWidth ?? internalWidth;
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const dragEnabled = controlledWidth === undefined || onWidthChange !== undefined;

  const setCollapsed = useCallback(
    (next: boolean) => {
      onCollapsedChange?.(next);
      if (controlledCollapsed === undefined) setInternalCollapsed(next);
    },
    [onCollapsedChange, controlledCollapsed],
  );

  const onHandleDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: width };
      setDragging(true);
      const move = (ev: MouseEvent) => {
        const delta = ev.clientX - drag.current.startX;
        const next = side === 'left' ? drag.current.startW + delta : drag.current.startW - delta;
        const clamped = Math.min(maxWidth, Math.max(minWidth, next));
        if (controlledWidth !== undefined) onWidthChange?.(clamped);
        else setInternalWidth(clamped);
      };
      const up = () => {
        setDragging(false);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, side, minWidth, maxWidth, controlledWidth, onWidthChange],
  );

  const handle = dragEnabled && !collapsed && (
    <div
      onMouseDown={onHandleDown}
      title="Drag to resize"
      style={{ width: 6, flexShrink: 0, cursor: 'col-resize', alignSelf: 'stretch' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-interactive-default)';
      }}
      onMouseLeave={(e) => {
        if (!dragging) e.currentTarget.style.background = 'transparent';
      }}
    />
  );

  return (
    <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
      {side === 'right' && handle}
      <AnimatedWidth open width={collapsed ? RAIL_WIDTH : width} animate={!dragging}>
        {collapsed ? (
          <button
            type="button"
            onClick={() => {
              setCollapsed(false);
            }}
            title={`Expand ${label}`}
            style={{
              ...paneSurface,
              width: RAIL_WIDTH,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--space-sm)',
              paddingTop: 10,
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-secondary)',
            }}
          >
            <Icon name={side === 'left' ? 'caret-right' : 'caret-left'} size="xs" />
            <Icon name={icon} size="sm" />
            {badge != null && badge > 0 && (
              <span
                style={{
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 8,
                  background: 'var(--color-warning-default)',
                  color: 'var(--color-accent-bg)',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {badge}
              </span>
            )}
            <Text size="xs" color="muted" style={{ writingMode: 'vertical-rl', marginTop: 4 }}>
              {label}
            </Text>
          </button>
        ) : (
          <div style={{ position: 'relative', height: '100%' }}>
            <button
              type="button"
              onClick={() => {
                setCollapsed(true);
              }}
              title={`Collapse ${label}`}
              style={{
                position: 'absolute',
                top: '50%',
                transform: 'translateY(-50%)',
                ...(side === 'left' ? { right: 2 } : { left: 0 }),
                zIndex: 6,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 36,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-subtle)',
                background: 'var(--color-surface-1)',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
              }}
            >
              <Icon name={side === 'left' ? 'caret-left' : 'caret-right'} size="xs" />
            </button>
            {children}
          </div>
        )}
      </AnimatedWidth>
      {side === 'left' && handle}
    </div>
  );
}
