'use client';

import { useState, useEffect } from 'react';
import { breakpoints, type BreakpointToken } from '../tokens.js';

/**
 * useBreakpoint — Returns the current active breakpoint and boolean helpers.
 *
 * Breakpoints (min-width, mobile-first):
 *   sm: 640px   md: 768px   lg: 1024px   xl: 1280px
 *
 * `isMobile` = below sm (< 640px)
 * `isTablet` = sm..lg (640–1023px)
 * `isDesktop` = lg+ (>= 1024px)
 *
 * Returns 'xs' when below the smallest breakpoint.
 */

type Breakpoint = 'xs' | BreakpointToken;

interface BreakpointResult {
  /** Current named breakpoint */
  breakpoint: Breakpoint;
  /** Below sm (< 640px) */
  isMobile: boolean;
  /** Between sm and lg (640–1023px) */
  isTablet: boolean;
  /** lg or above (>= 1024px) */
  isDesktop: boolean;
  /** Viewport width >= given breakpoint */
  above: (bp: BreakpointToken) => boolean;
  /** Viewport width < given breakpoint */
  below: (bp: BreakpointToken) => boolean;
}

const orderedBps: BreakpointToken[] = ['xl', 'lg', 'md', 'sm'];

function resolve(): Breakpoint {
  if (typeof window === 'undefined') return 'xs';
  const w = window.innerWidth;
  for (const bp of orderedBps) {
    if (w >= breakpoints[bp]) return bp;
  }
  return 'xs';
}

export function useBreakpoint(): BreakpointResult {
  const [bp, setBp] = useState<Breakpoint>('xs');

  useEffect(() => {
    setBp(resolve());
    const handler = () => {
      setBp(resolve());
    };
    window.addEventListener('resize', handler, { passive: true });
    return () => {
      window.removeEventListener('resize', handler);
    };
  }, []);

  const above = (target: BreakpointToken): boolean => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth >= breakpoints[target];
  };

  const below = (target: BreakpointToken): boolean => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth < breakpoints[target];
  };

  return {
    breakpoint: bp,
    isMobile: bp === 'xs',
    isTablet: bp === 'sm' || bp === 'md',
    isDesktop: bp === 'lg' || bp === 'xl',
    above,
    below,
  };
}
