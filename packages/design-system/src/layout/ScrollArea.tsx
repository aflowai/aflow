import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** Scroll direction */
  direction?: 'vertical' | 'horizontal' | 'both';
  /** Fill available space */
  grow?: boolean;
  children?: ReactNode;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { direction = 'vertical', grow = false, style, children, ...rest },
  ref,
) {
  const overflow =
    direction === 'vertical'
      ? { overflowY: 'auto' as const, overflowX: 'hidden' as const }
      : direction === 'horizontal'
        ? { overflowX: 'auto' as const, overflowY: 'hidden' as const }
        : { overflow: 'auto' as const };

  const s: React.CSSProperties = {
    ...overflow,
    ...(grow ? { flex: 1, minHeight: 0 } : undefined),
    ...style,
  };

  return (
    <div ref={ref} className="ds-scroll-subtle" style={s} {...rest}>
      {children}
    </div>
  );
});
