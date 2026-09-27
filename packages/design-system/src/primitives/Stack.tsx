import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  /** Content */
  children?: ReactNode;
  /** Gap between items */
  gap?: SpaceToken;
  /** Horizontal alignment */
  align?: 'start' | 'center' | 'end' | 'stretch';
  /** Whether to reverse the order */
  reverse?: boolean;
}

const alignMap: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

export function Stack({
  children,
  gap = 'lg',
  align = 'stretch',
  reverse = false,
  className = '',
  style,
  ...props
}: StackProps) {
  const stackStyle: CSSProperties = {
    display: 'flex',
    flexDirection: reverse ? 'column-reverse' : 'column',
    alignItems: alignMap[align],
    gap: `var(--space-${gap})`,
    ...style,
  };

  return (
    <div className={`ds-stack ${className}`} style={stackStyle} {...props}>
      {children}
    </div>
  );
}

export interface InlineProps extends HTMLAttributes<HTMLDivElement> {
  /** Content */
  children?: ReactNode;
  /** Gap between items */
  gap?: SpaceToken;
  /** Vertical alignment */
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
  /** Horizontal distribution */
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  /** Whether to wrap items */
  wrap?: boolean;
  /** Whether to reverse the order */
  reverse?: boolean;
}

const justifyMap: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
};

export function Inline({
  children,
  gap = 'md',
  align = 'center',
  justify = 'start',
  wrap = false,
  reverse = false,
  className = '',
  style,
  ...props
}: InlineProps) {
  const inlineStyle: CSSProperties = {
    display: 'flex',
    flexDirection: reverse ? 'row-reverse' : 'row',
    alignItems: alignMap[align] ?? align,
    justifyContent: justifyMap[justify],
    flexWrap: wrap ? 'wrap' : 'nowrap',
    gap: `var(--space-${gap})`,
    ...style,
  };

  return (
    <div className={`ds-inline ${className}`} style={inlineStyle} {...props}>
      {children}
    </div>
  );
}
