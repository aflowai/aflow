/**
 * PageContainer — Centered, max-width content wrapper for standard pages.
 * Responsive: reduces padding on mobile.
 * All styling inline via tokens.
 */
import type { ReactNode, CSSProperties } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';

export interface PageContainerProps {
  children: ReactNode;
  /** Max width (number = px, or CSS length e.g. token `var(--layout-content-max-width)`) */
  maxWidth?: number | string;
  /** Padding (desktop) */
  padding?: string;
}

const DEFAULT_PAGE_MAX_WIDTH = 'var(--layout-content-max-width)';

export function PageContainer({
  children,
  maxWidth = DEFAULT_PAGE_MAX_WIDTH,
  padding = 'var(--space-2xl)',
}: PageContainerProps) {
  const isMobile = useMediaQuery('(max-width: 639px)');

  const style: CSSProperties = {
    maxWidth,
    margin: '0 auto',
    padding: isMobile ? 'var(--space-3)' : padding,
    width: '100%',
    backgroundColor: 'var(--surface-overlay-alpha)',
    borderRadius: 'var(--radius-2xl)',
    height: 'auto',
    overflow: 'auto',
    marginBottom: '12px',
    scrollbarWidth: 'none',
    flex: 1,
  };

  return <div style={style}>{children}</div>;
}
