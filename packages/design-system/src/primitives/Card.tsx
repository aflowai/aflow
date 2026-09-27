import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Content */
  children?: ReactNode;
  /** Elevated (shadow) variant */
  elevated?: boolean;
  /** Interactive (hover effect) */
  interactive?: boolean;
  /** Glossy highlight — static top sheen over the alpha surface (no motion). */
  glossy?: boolean;
  /** Running — animated conic-gradient ring (borrowed from running TimelineItem). Composable with `glossy`. */
  running?: boolean;
}

export function Card({
  children,
  elevated = false,
  interactive = false,
  glossy = false,
  running = false,
  className = '',
  ...props
}: CardProps) {
  const classNames = [
    'ds-card',
    elevated && 'ds-card--elevated',
    interactive && 'ds-card--interactive',
    glossy && 'ds-card--glossy',
    running && 'ds-card--running',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames} {...props}>
      {children}
    </div>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardHeader({ children, className = '', ...props }: CardHeaderProps) {
  return (
    <div className={`ds-card__header ${className}`} {...props}>
      {children}
    </div>
  );
}

export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardBody({ children, className = '', ...props }: CardBodyProps) {
  return (
    <div className={`ds-card__body ${className}`} {...props}>
      {children}
    </div>
  );
}

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardFooter({ children, className = '', ...props }: CardFooterProps) {
  return (
    <div className={`ds-card__footer ${className}`} {...props}>
      {children}
    </div>
  );
}
