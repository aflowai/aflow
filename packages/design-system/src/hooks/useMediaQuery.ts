'use client';

import { useState, useEffect } from 'react';

/**
 * useMediaQuery — Subscribe to a CSS media query.
 * Returns false during SSR and on first render (hydration-safe).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = () => {
      setMatches(mql.matches);
    };
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [query]);

  return matches;
}
