'use client';

import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery.js';

export interface DialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Called when the dialog should close */
  onClose: () => void;
  /** Dialog title */
  title?: string;
  /** Dialog content */
  children?: ReactNode;
  /** Footer content (typically actions) */
  footer?: ReactNode;
  /** Width of the dialog */
  width?: 'sm' | 'md' | 'lg' | 'xl';
}

const widthMap: Record<string, string> = {
  sm: '400px',
  md: '640px',
  lg: '800px',
  xl: '960px',
};

export function Dialog({ open, onClose, title, children, footer, width = 'md' }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const isMobileViewport = useMediaQuery('(max-width: 639px)');

  // Handle escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  // Focus management
  useEffect(() => {
    if (open) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      // Focus the dialog
      dialogRef.current?.focus();
    } else if (previousActiveElement.current) {
      previousActiveElement.current.focus();
    }
  }, [open]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(3px)',
    display: 'flex',
    alignItems: isMobileViewport ? 'flex-end' : 'center',
    justifyContent: 'center',
    zIndex: 'var(--z-modal)',
    padding: isMobileViewport ? '0' : 'var(--space-4)',
  };

  const dialogStyle: CSSProperties = {
    backgroundColor: 'var(--color-accent-bg)',
    backdropFilter: 'blur(16px)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: isMobileViewport ? 'var(--radius-lg) var(--radius-lg) 0 0' : 'var(--radius-xl)',
    boxShadow: 'var(--shadow-xl)',
    width: '100%',
    maxWidth: isMobileViewport ? '100%' : (widthMap[width] ?? widthMap['md']),
    maxHeight: isMobileViewport ? '90dvh' : 'calc(100dvh - var(--space-8))',
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
    ...(isMobileViewport ? { paddingBottom: 'env(safe-area-inset-bottom)' } : {}),
  };

  const headerStyle: CSSProperties = {
    padding: 'var(--space-4) var(--space-6)',
    borderBottom: '1px solid var(--color-border-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const titleStyle: CSSProperties = {
    fontSize: 'var(--font-size-lg)',
    fontFamily: 'var(--font-family-title)',
    fontWeight: 'var(--font-weight-semibold)',
    color: 'var(--color-text-primary)',
    margin: 0,
  };

  const closeButtonStyle: CSSProperties = {
    padding: 'var(--space-2)',
    margin: 'calc(-1 * var(--space-1))',
    minWidth: 36,
    minHeight: 36,
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const bodyStyle: CSSProperties = {
    padding: isMobileViewport ? 'var(--space-4)' : 'var(--space-6)',
    overflow: 'auto',
    flex: 1,
  };

  const footerStyle: CSSProperties = {
    padding: isMobileViewport ? 'var(--space-3) var(--space-4)' : 'var(--space-4) var(--space-6)',
    borderTop: '1px solid var(--color-border-subtle)',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 'var(--space-2)',
  };

  // Portal to body so --z-modal competes at the root stacking context.
  // Inline mount traps the overlay inside ancestors like ChatLayout's
  // composer (z-index: 2), which loses to local UI such as CollapsibleSide's
  // collapse chevron (z-index: 6).
  return createPortal(
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'dialog-title' : undefined}
        style={dialogStyle}
        tabIndex={-1}
      >
        {title && (
          <div style={headerStyle}>
            <h2 id="dialog-title" style={titleStyle}>
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              style={closeButtonStyle}
              aria-label="Close dialog"
            >
              <CloseIcon />
            </button>
          </div>
        )}
        <div style={bodyStyle}>{children}</div>
        {footer && <div style={footerStyle}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 5L5 15M5 5l10 10" />
    </svg>
  );
}
