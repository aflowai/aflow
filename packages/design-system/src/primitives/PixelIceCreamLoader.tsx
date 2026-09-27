import React from 'react';

export interface PixelIceCreamLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: number;
  /**
   * The image to spin. Defaults to `/jester.svg`, which every application
   * serving this component carries in its own `public/`.
   */
  src?: string;
}

export function PixelIceCreamLoader({
  size = 320,
  src = '/jester.svg',
  className = '',
  ...props
}: PixelIceCreamLoaderProps) {
  return (
    <div
      className={`ds-pixel-loader ${className}`}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...props.style,
      }}
      {...props}
    >
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ display: 'block', objectFit: 'contain' }}
        aria-hidden
      />
    </div>
  );
}
