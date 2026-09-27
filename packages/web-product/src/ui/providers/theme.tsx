'use client';

/**
 * The product's theme, shared by every application that serves it.
 *
 * No framework here: React, `localStorage` and `matchMedia`. An application
 * composes it, and a second application cannot end up with a different idea of
 * what `data-theme` means.
 */
'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { storedTheme, THEME_STORAGE_KEY, type Theme } from './themeStorage.js';

export type { Theme } from './themeStorage.js';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const saved = storedTheme(localStorage.getItem(THEME_STORAGE_KEY));
    if (saved) setTheme(saved);
  }, []);

  useEffect(() => {
    if (theme !== 'system') {
      setResolvedTheme(theme);
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    setResolvedTheme(media.matches ? 'dark' : 'light');
    const handler = (event: MediaQueryListEvent) => {
      setResolvedTheme(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => {
      media.removeEventListener('change', handler);
    };
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  const handleSetTheme = (next: Theme): void => {
    setTheme(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
