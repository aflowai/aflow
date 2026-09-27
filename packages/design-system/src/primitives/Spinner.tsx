import type { HTMLAttributes } from 'react';
import { PixelIceCreamLoader } from './PixelIceCreamLoader.js';

export type SpinnerSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_PX: Record<SpinnerSize, number> = {
  sm: 20,
  md: 32,
  lg: 48,
  xl: 82,
};

export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  /** Size */
  size?: SpinnerSize;
  /** Accessible label */
  label?: string;
  /** URL to the ice cream SVG. Defaults to /icecream.svg. */
  src?: string;
}

export function Spinner({
  size = 'md',
  label = 'Loading',
  src = '/icecream.svg',
  className = '',
  ...props
}: SpinnerProps) {
  return (
    <PixelIceCreamLoader
      size={SIZE_PX[size]}
      src={src}
      className={className}
      role="status"
      aria-label={label}
      {...props}
    />
  );
}
