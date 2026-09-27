import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { SpaceToken } from '../tokens.js';

export type PanelVariant = 'default' | 'subtle' | 'elevated' | 'outline';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Visual treatment */
  variant?: PanelVariant;
  /** Padding */
  padding?: SpaceToken;
  /** Border radius */
  rounded?: boolean;
  /** Fill available height */
  grow?: boolean;
  children?: ReactNode;
}

const VARIANT_STYLES: Record<PanelVariant, React.CSSProperties> = {
  default: {
    backgroundColor: 'var(--color-surface-canvas)',
    border: '1px solid var(--color-border-default)',
  },
  subtle: {
    backgroundColor: 'var(--color-surface-raised)',
    border: '1px solid var(--color-border-subtle)',
  },
  elevated: {
    backgroundColor: 'var(--color-surface-canvas)',
    boxShadow: 'var(--shadow-md)',
    border: '1px solid transparent',
  },
  outline: {
    backgroundColor: 'transparent',
    border: '1px solid var(--color-border-subtle)',
  },
};

export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { variant = 'default', padding = 'lg', rounded = true, grow = false, style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    ...VARIANT_STYLES[variant],
    padding: `var(--space-${padding})`,
    borderRadius: rounded ? 'var(--radius-md)' : '0',
    ...(grow ? { flex: 1 } : undefined),
    overflow: 'hidden',
    ...style,
  };

  return (
    <div ref={ref} style={s} {...rest}>
      {children}
    </div>
  );
});
