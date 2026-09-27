'use client';

import { useState, type ImgHTMLAttributes } from 'react';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  /** Image URL (e.g. logo, profile photo) */
  src: string;
  /** Accessible description */
  alt: string;
  /** Size preset */
  size?: AvatarSize;
}

const sizeMap: Record<AvatarSize, number> = {
  sm: 20,
  md: 28,
  lg: 40,
};

export function Avatar({ src, alt, size = 'md', className = '', style, ...props }: AvatarProps) {
  const [error, setError] = useState(false);
  const px = sizeMap[size];
  const classNames = ['ds-avatar', `ds-avatar--${size}`, className].filter(Boolean).join(' ');

  if (error) {
    return (
      <div
        className={classNames}
        style={{
          width: px,
          height: px,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style,
        }}
        role="img"
        aria-label={alt}
      >
        <span className="ds-avatar__fallback" aria-hidden>
          {alt.slice(0, 1).toUpperCase()}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={classNames}
      width={px}
      height={px}
      style={style}
      onError={() => {
        setError(true);
      }}
      {...props}
    />
  );
}
