'use client';

import { useEffect, useRef, type MouseEvent, type ReactNode, type CSSProperties } from 'react';
import { Icon } from '../icons/Icon.js';
import { useModalA11y } from './useModalA11y.js';

export interface SheetProps {
  /** Controls visibility. When false, the sheet unmounts. */
  open: boolean;
  /** Title shown in the top header. Required for screen-reader labelling. */
  title: string;
  /** Close handler — wire to escape, back button, and operator dismissal. */
  onClose: () => void;
  /** Sheet body. Vertically scrollable when content overflows. */
  children: ReactNode;
  /** Optional footer rendered below the scroll body, pinned to the bottom. */
  footer?: ReactNode;
  /** Optional override for the close-button icon. Defaults to `arrow-left`. */
  closeIcon?: 'arrow-left' | 'x';
  /**
   * `full` covers the viewport; `right` is a drawer against the trailing edge
   * over a dismissing scrim, for a detail that reads beside its list.
   */
  placement?: 'full' | 'right';
  /** Drawer width when `placement` is `right`. Capped at the viewport width. */
  width?: number | string;
  /** Optional className on the dialog root. */
  className?: string;
  /** Optional style override on the dialog root. */
  style?: CSSProperties;
}

/**
 * Pure helper — does the runtime environment support body-scroll-lock side
 * effects? Lets tests assert the policy without poking `document.body`.
 */
export function sheetCanLockScroll(): boolean {
  return typeof document !== 'undefined';
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
  closeIcon = 'arrow-left',
  placement = 'full',
  width = 640,
  className,
  style,
}: SheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Escape-to-close. Mirrors PeekPanel for muscle-memory consistency.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [open, onClose]);

  // Body scroll lock — prevents the underlying page from scrolling
  // when the sheet is dragged on touch devices, and avoids the
  // double-scrollbar artifact on desktop.
  useEffect(() => {
    if (!open || !sheetCanLockScroll()) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useModalA11y({ enabled: open, containerRef: dialogRef });

  // Move initial focus to the close button when opening, so the user can
  // dismiss with Enter/Space immediately. Runs after useModalA11y's
  // initial-focus effect, which would otherwise land on the dialog root —
  // the close button is a friendlier target for keyboard users.
  useEffect(() => {
    if (open) {
      closeBtnRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const drawer = placement === 'right';

  const content = (
    <>
      {/* Top header — close button + title */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-md, 12px)',
          padding: 'var(--space-sm, 8px) var(--space-md, 12px)',
          height: 48,
          flexShrink: 0,
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 'var(--space-sm, 8px)',
            color: 'var(--color-content-primary)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Icon name={closeIcon} size="md" />
        </button>
        <span
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-medium)' as unknown as number,
            color: 'var(--color-content-primary)',
          }}
        >
          {title}
        </span>
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          minHeight: 0,
          padding: '10px',
          boxSizing: 'border-box',
        }}
      >
        {children}
      </div>

      {/* Footer (optional) */}
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
    </>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className={className}
      // The scrim IS the dialog root in drawer mode: a separate scrim element
      // would be a sibling of the root, and the shared a11y hook marks those
      // inert — an inert scrim cannot be clicked to dismiss.
      {...(drawer
        ? {
            onClick: (event: MouseEvent<HTMLDivElement>) => {
              if (event.target === event.currentTarget) onClose();
            },
          }
        : {})}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal)' as unknown as number,
        display: 'flex',
        ...(drawer
          ? {
              justifyContent: 'flex-end',
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              backdropFilter: 'blur(3px)',
            }
          : {
              flexDirection: 'column',
              backgroundColor: 'var(--color-surface-canvas)',
            }),
        ...style,
      }}
    >
      {drawer ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: typeof width === 'number' ? `min(${String(width)}px, 100vw)` : width,
            maxWidth: '100vw',
            backgroundColor: 'var(--color-surface-canvas)',
            // Every surface token here is translucent; the blur is what keeps
            // the drawer readable over the page it covers.
            backdropFilter: 'blur(16px)',
            borderInlineStart: '1px solid var(--color-border-subtle)',
            boxShadow: 'var(--shadow-xl)',
          }}
        >
          {content}
        </div>
      ) : (
        content
      )}
    </div>
  );
}
