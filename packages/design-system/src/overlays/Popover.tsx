'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export type PopoverPlacement =
  'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'right-start' | 'left-start';

export interface PopoverTriggerApi {
  /** Attach to the element the panel should anchor to (measured for position). */
  ref: (node: HTMLElement | null) => void;
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export interface PopoverProps {
  /**
   * Renders the anchor. Attach `ref` to the element to measure, wire `toggle`
   * to its click handler, and read `open` for active state.
   */
  trigger: (api: PopoverTriggerApi) => ReactNode;
  /** Panel content. A function form receives `close` so inner actions can dismiss. */
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  /** Where the panel opens relative to the trigger. Default `bottom-start`. */
  placement?: PopoverPlacement;
  /** Fixed panel width (px). When omitted, matches the trigger width clamped to `minWidth`. */
  width?: number;
  /** Minimum panel width when auto-sizing to the trigger (px). Default 180. */
  minWidth?: number;
  /** Gap between trigger and panel (px). Default 6. */
  offset?: number;
  /** Controlled open state. Pair with `onOpenChange` to drive it externally. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Accessible label for the panel. When provided, the panel is exposed as
   * `role="dialog"` with this name; omit it and the panel carries no dialog
   * role (so it never ships as an unnamed dialog to screen readers).
   */
  'aria-label'?: string;
  /** Style merged onto the panel surface (overrides defaults like padding/maxHeight). */
  panelStyle?: CSSProperties;
  panelClassName?: string;
}

const VIEWPORT_MARGIN = 8;

export interface PopoverRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

/**
 * Pure geometry — given the trigger rect, the viewport, and placement, return
 * the fixed-position style (anchors + width) for the panel. Top placements
 * anchor by `bottom` so the panel grows upward; horizontal position always
 * resolves to a `left` clamped inside the viewport. Kept pure so the layout
 * math is unit-testable without a DOM.
 */
export function computePopoverPanelStyle(
  rect: PopoverRect,
  viewport: PopoverViewport,
  opts: {
    placement: PopoverPlacement;
    width?: number | undefined;
    minWidth: number;
    offset: number;
    margin: number;
  },
): CSSProperties {
  const { placement, width, minWidth, offset, margin } = opts;
  const w = width ?? Math.max(rect.width, minWidth);
  const maxLeft = Math.max(margin, viewport.width - margin - w);
  const clampLeft = (left: number) => Math.min(Math.max(left, margin), maxLeft);

  const style: CSSProperties = { position: 'fixed', width: w };
  switch (placement) {
    case 'bottom-start':
      style.top = rect.bottom + offset;
      style.left = clampLeft(rect.left);
      break;
    case 'bottom-end':
      style.top = rect.bottom + offset;
      style.left = clampLeft(rect.right - w);
      break;
    case 'top-start':
      style.bottom = viewport.height - rect.top + offset;
      style.left = clampLeft(rect.left);
      break;
    case 'top-end':
      style.bottom = viewport.height - rect.top + offset;
      style.left = clampLeft(rect.right - w);
      break;
    case 'right-start':
      style.top = rect.top;
      style.left = clampLeft(rect.right + offset);
      break;
    case 'left-start':
      style.top = rect.top;
      style.left = clampLeft(rect.left - offset - w);
      break;
  }
  return style;
}

/**
 * Anchored, portaled floating panel. Non-modal: dismisses on outside click,
 * Escape, or a `close()` call from content. Positions itself relative to the
 * trigger and repositions on scroll/resize. The trigger and content are
 * supplied by the caller, so this stays a pure positioning + dismissal shell.
 */
export function Popover({
  trigger,
  children,
  placement = 'bottom-start',
  width,
  minWidth = 180,
  offset = 6,
  open: controlledOpen,
  onOpenChange,
  'aria-label': ariaLabel,
  panelStyle,
  panelClassName,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);
  const toggle = useCallback(() => {
    setOpen(!open);
  }, [setOpen, open]);

  const triggerRef = useRef<HTMLElement | null>(null);
  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
  }, []);
  const [panelPos, setPanelPos] = useState<CSSProperties | null>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPanelPos(
      computePopoverPanelStyle(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { placement, width, minWidth, offset, margin: VIEWPORT_MARGIN },
      ),
    );
  }, [placement, width, minWidth, offset]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => {
      reposition();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, reposition, close]);

  return (
    <>
      {trigger({ ref: setTriggerRef, open, toggle, close })}
      {open &&
        panelPos &&
        createPortal(
          <>
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 'var(--z-popover)' as unknown as number,
              }}
              onClick={close}
            />
            <div
              {...(ariaLabel ? { role: 'dialog', 'aria-label': ariaLabel } : {})}
              className={panelClassName}
              style={{
                ...panelPos,
                zIndex: 'var(--z-popover)' as unknown as number,
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: 'min(70vh, 560px)',
                overflowY: 'auto',
                background: 'var(--color-surface-1)',
                backdropFilter: 'blur(16px)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-lg)',
                padding: 'var(--space-3)',
                ...panelStyle,
              }}
            >
              {typeof children === 'function' ? children({ close }) : children}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
