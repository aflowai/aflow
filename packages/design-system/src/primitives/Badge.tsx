import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeVariant =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stalled'
  | 'neutral'
  | 'info'
  | 'warning'
  | 'success'
  | 'danger'
  | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Content */
  children?: ReactNode;
  /** Visual variant */
  variant?: BadgeVariant;
  /** Left icon */
  icon?: ReactNode;
}

export function Badge({
  children,
  variant = 'neutral',
  icon,
  className = '',
  ...props
}: BadgeProps) {
  const classNames = ['ds-badge', `ds-badge--${variant}`, className].filter(Boolean).join(' ');

  return (
    <span className={classNames} {...props}>
      {icon}
      {children}
    </span>
  );
}
