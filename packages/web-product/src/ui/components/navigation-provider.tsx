'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { Spinner, Text } from '@aflow/design-system';

interface NavigationContextValue {
  push: (href: string) => void;
  replace: (href: string) => void;
  isNavigating: boolean;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider');
  }
  return context;
}

const SAFETY_TIMEOUT_MS = 5000;
const MIN_DISPLAY_MS = 280;
const FADE_OUT_MS = 180;

type OverlayPhase = 'idle' | 'loading' | 'exiting';

export function NavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<OverlayPhase>('idle');
  const prevPathnameRef = useRef(pathname);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const showTimeRef = useRef(0);

  const startLoading = useCallback(() => {
    flushSync(() => {
      setPhase((prev) => {
        if (prev !== 'idle') return prev;
        showTimeRef.current = Date.now();
        return 'loading';
      });
    });
  }, []);

  const beginExit = useCallback(() => {
    const elapsed = Date.now() - showTimeRef.current;
    const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
    setTimeout(() => {
      setPhase('exiting');
    }, remaining);
  }, []);

  const push = useCallback(
    (href: string) => {
      startLoading();
      router.push(href);
    },
    [router, startLoading],
  );

  const replace = useCallback(
    (href: string) => {
      startLoading();
      router.replace(href);
    },
    [router, startLoading],
  );

  // Intercept ALL internal <a> clicks (including next/link) so the overlay
  // appears the instant the user clicks, not after the route chunk loads.
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      // If another handler already called preventDefault() (e.g. ProcessMapNode
      // intercepting plain clicks for the inspector panel), skip the overlay.
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:'))
        return;

      try {
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) return;
        if (url.pathname === pathnameRef.current) return;

        startLoading();
      } catch {
        // malformed URL — ignore
      }
    }

    // Use bubble phase (not capture) so React synthetic event handlers that
    // call preventDefault() run first — the check above will then skip them.
    document.addEventListener('click', handleClick);
    return () => {
      document.removeEventListener('click', handleClick);
    };
  }, [startLoading]);

  // When pathname changes, begin the exit sequence (respects minimum display time)
  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      prevPathnameRef.current = pathname;
      if (phase === 'loading') {
        beginExit();
      }
    }
  }, [pathname, phase, beginExit]);

  // Safety timeout so the overlay never gets stuck
  useEffect(() => {
    if (phase === 'idle') return;
    const id = setTimeout(() => {
      setPhase('idle');
    }, SAFETY_TIMEOUT_MS);
    return () => {
      clearTimeout(id);
    };
  }, [phase]);

  const handleExitEnd = useCallback(() => {
    setPhase('idle');
  }, []);

  return (
    <NavigationContext.Provider value={{ push, replace, isNavigating: phase !== 'idle' }}>
      {children}
      {phase !== 'idle' && (
        <NavigationOverlay exiting={phase === 'exiting'} onExitEnd={handleExitEnd} />
      )}
    </NavigationContext.Provider>
  );
}

function NavigationOverlay({ exiting, onExitEnd }: { exiting: boolean; onExitEnd: () => void }) {
  return (
    <div
      aria-busy="true"
      aria-label="Navigating"
      onAnimationEnd={exiting ? onExitEnd : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, var(--color-bg-primary) 92%, transparent)',
        backdropFilter: 'blur(8px)',
        animation: exiting
          ? `navOverlayFadeOut ${String(FADE_OUT_MS)}ms ease-in forwards`
          : 'navOverlayFadeIn 120ms ease-out',
      }}
    >
      <style>{`
        @keyframes navOverlayFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes navOverlayFadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes navPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
      <Spinner size="xl" style={{ marginBottom: 'var(--space-3)' }} />
      <Text
        variant="muted"
        size="sm"
        style={{
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          animation: 'navPulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        }}
      >
        Loading…
      </Text>
    </div>
  );
}
