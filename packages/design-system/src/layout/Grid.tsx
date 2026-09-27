import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of fixed columns */
  columns?: number;
  /** Minimum child width for auto-fill responsive grid */
  minChildWidth?: string;
  /** Gap between items */
  gap?: SpaceToken;
  /** Row gap (overrides gap for rows) */
  rowGap?: SpaceToken;
  /** Column gap (overrides gap for columns) */
  columnGap?: SpaceToken;
  /** Padding */
  padding?: SpaceToken;
  children?: ReactNode;
}

export const Grid = forwardRef<HTMLDivElement, GridProps>(function Grid(
  {
    columns,
    minChildWidth,
    gap = 'lg',
    rowGap,
    columnGap,
    padding,
    style,
    className,
    children,
    ...rest
  },
  ref,
) {
  let gridTemplateColumns: string;
  if (columns != null) {
    gridTemplateColumns = `repeat(${columns}, 1fr)`;
  } else if (minChildWidth != null) {
    gridTemplateColumns = `repeat(auto-fill, minmax(${minChildWidth}, 1fr))`;
  } else {
    gridTemplateColumns = `repeat(auto-fill, minmax(280px, 1fr))`;
  }

  const s: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns,
    gap: `var(--space-${gap})`,
    ...(rowGap != null ? { rowGap: `var(--space-${rowGap})` } : undefined),
    ...(columnGap != null ? { columnGap: `var(--space-${columnGap})` } : undefined),
    ...(padding != null ? { padding: `var(--space-${padding})` } : undefined),
    ...style,
  };

  // Fixed column counts collapse to a single column on phones via the
  // stylesheet (!important beats the inline template above).
  const mergedClassName =
    columns != null && columns > 1
      ? `ds-grid--fixed-columns${className ? ` ${className}` : ''}`
      : className;

  return (
    <div ref={ref} style={s} {...(mergedClassName ? { className: mergedClassName } : {})} {...rest}>
      {children}
    </div>
  );
});
