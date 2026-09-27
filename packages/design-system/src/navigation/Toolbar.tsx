import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between toolbar sections */
  gap?: SpaceToken;
  /** Padding */
  padding?: SpaceToken;
  /** Wrap items when space is tight */
  wrap?: boolean;
  children?: ReactNode;
}

export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(function Toolbar(
  { gap = 'md', padding, wrap: _wrap = true, style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: `var(--space-${gap})`,
    ...(padding != null ? { padding: `var(--space-${padding})` } : undefined),
    ...style,
  };

  return (
    <div ref={ref} role="toolbar" style={s} {...rest}>
      {children}
    </div>
  );
});

export interface ToolbarRowProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between items */
  gap?: SpaceToken;
  /** Vertical alignment */
  align?: 'start' | 'center' | 'end';
  /** Horizontal distribution */
  justify?: 'start' | 'end' | 'between';
  /** Wrap items */
  wrap?: boolean;
  children?: ReactNode;
}

const JUSTIFY_MAP = {
  start: 'flex-start',
  end: 'flex-end',
  between: 'space-between',
} as const;

export const ToolbarRow = forwardRef<HTMLDivElement, ToolbarRowProps>(function ToolbarRow(
  { gap = 'md', align = 'center', justify = 'start', wrap = false, style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : 'center',
    justifyContent: JUSTIFY_MAP[justify],
    gap: `var(--space-${gap})`,
    flexWrap: wrap ? 'wrap' : 'nowrap',
    ...style,
  };

  return (
    <div ref={ref} style={s} {...rest}>
      {children}
    </div>
  );
});
