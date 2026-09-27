'use client';

/**
 * Toast — transient feedback channel.
 *
 * ToastProvider holds the queue and renders the stack via a portal on
 * --z-toast: bottom-center above the safe area on phones, bottom-right on
 * desktop. Auto-dismisses (pause on hover), dismissible, announced via
 * aria-live. Danger toasts persist longer and announce assertively.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../hooks/useMediaQuery.js';

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss delay; danger defaults longer. 0 disables auto-dismiss. */
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, 'title' | 'tone'>> {
  id: number;
  description: string | undefined;
  durationMs: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const TONE_COLOR: Record<ToastTone, string> = {
  neutral: 'var(--color-content-secondary)',
  success: 'var(--color-success-default)',
  warning: 'var(--color-warning-default, var(--color-status-paused, #b8860b))',
  danger: 'var(--color-danger-default)',
};

const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = ++idRef.current;
    const tone = options.tone ?? 'neutral';
    const durationMs = options.durationMs ?? (tone === 'danger' ? 8000 : 5000);
    setToasts((prev) => [
      ...prev.slice(-(MAX_VISIBLE - 1)),
      { id, title: options.title, description: options.description, tone, durationMs },
    ]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function Toaster({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  if (typeof document === 'undefined' || toasts.length === 0) return null;

  const stackStyle: CSSProperties = {
    position: 'fixed',
    zIndex: 'var(--z-toast)' as unknown as number,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    pointerEvents: 'none',
    ...(isMobile
      ? {
          left: 'var(--space-3)',
          right: 'var(--space-3)',
          bottom: 'calc(var(--space-3) + env(safe-area-inset-bottom))',
          alignItems: 'stretch',
        }
      : {
          right: 'var(--space-5)',
          bottom: 'var(--space-5)',
          width: 360,
          alignItems: 'stretch',
        }),
  };

  return createPortal(
    <div style={stackStyle}>
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (toast.durationMs === 0 || hovered) return;
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.durationMs);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, toast.durationMs, hovered, onDismiss]);

  const cardStyle: CSSProperties = {
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-3)',
    padding: 'var(--space-3) var(--space-4)',
    backgroundColor: 'var(--surface-raised-alpha, var(--color-surface-raised))',
    WebkitBackdropFilter: 'blur(16px)',
    backdropFilter: 'blur(16px)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: 'var(--shadow-lg)',
  };

  const barStyle: CSSProperties = {
    alignSelf: 'stretch',
    width: 2,
    flexShrink: 0,
    borderRadius: 1,
    backgroundColor: TONE_COLOR[toast.tone],
  };

  return (
    <div
      role="status"
      aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
      style={cardStyle}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
    >
      <div style={barStyle} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-medium)' as unknown as number,
            color: 'var(--color-content-primary)',
            overflowWrap: 'anywhere',
          }}
        >
          {toast.title}
        </div>
        {toast.description && (
          <div
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-content-muted)',
              marginTop: 'var(--space-0-5)',
              overflowWrap: 'anywhere',
            }}
          >
            {toast.description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          onDismiss(toast.id);
        }}
        aria-label="Dismiss notification"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 'var(--space-1)',
          margin: 'calc(-1 * var(--space-1))',
          minWidth: 28,
          minHeight: 28,
          color: 'var(--color-content-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M15 5L5 15M5 5l10 10" />
        </svg>
      </button>
    </div>
  );
}
