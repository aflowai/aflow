import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface ColumnProps extends HTMLAttributes<HTMLDivElement> {
  /** Gap between children */
  gap?: SpaceToken;
  /** Cross-axis alignment */
  align?: 'start' | 'center' | 'end' | 'stretch';
  /** Main-axis distribution */
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  /** Reverse direction */
  reverse?: boolean;
  /** Flex grow to fill parent */
  grow?: boolean;
  /** Padding */
  padding?: SpaceToken;
  /** Horizontal padding */
  paddingX?: SpaceToken;
  /** Vertical padding */
  paddingY?: SpaceToken;
  children?: ReactNode;
}

const ALIGN_MAP = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
} as const;

const JUSTIFY_MAP = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
} as const;

export const Column = forwardRef<HTMLDivElement, ColumnProps>(function Column(
  {
    gap = 'md',
    align = 'stretch',
    justify = 'start',
    reverse = false,
    grow = false,
    padding,
    paddingX,
    paddingY,
    style,
    children,
    ...rest
  },
  ref,
) {
  const s: React.CSSProperties = {
    display: 'flex',
    flexDirection: reverse ? 'column-reverse' : 'column',
    alignItems: ALIGN_MAP[align],
    justifyContent: JUSTIFY_MAP[justify],
    gap: `var(--space-${gap})`,
    minWidth: 0,
    ...(grow ? { flex: 1 } : undefined),
    ...(padding != null ? { padding: `var(--space-${padding})` } : undefined),
    ...(paddingX != null
      ? { paddingLeft: `var(--space-${paddingX})`, paddingRight: `var(--space-${paddingX})` }
      : undefined),
    ...(paddingY != null
      ? { paddingTop: `var(--space-${paddingY})`, paddingBottom: `var(--space-${paddingY})` }
      : undefined),
    ...style,
  };

  return (
    <div ref={ref} style={s} {...rest}>
      {children}
    </div>
  );
});
