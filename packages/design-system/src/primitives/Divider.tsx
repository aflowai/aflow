import type { CSSProperties, HTMLAttributes } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface DividerProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Subtle (lighter) variant */
  subtle?: boolean;
  /** Vertical margin */
  my?: SpaceToken;
  /** Orientation — horizontal renders <hr>, vertical renders a thin <div> */
  orientation?: 'horizontal' | 'vertical';
}

export function Divider({
  subtle = false,
  my,
  orientation = 'horizontal',
  className = '',
  style,
  ...props
}: DividerProps) {
  const isVertical = orientation === 'vertical';

  const classNames = [
    'ds-divider',
    subtle && 'ds-divider--subtle',
    isVertical && 'ds-divider--vertical',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const dividerStyle: CSSProperties = {
    ...(my != null && {
      marginTop: `var(--space-${my})`,
      marginBottom: `var(--space-${my})`,
    }),
    ...style,
  };

  if (isVertical) {
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        className={classNames}
        style={dividerStyle}
        {...props}
      />
    );
  }

  return <hr className={classNames} style={dividerStyle} {...props} />;
}
