import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Content */
  children?: ReactNode;
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size */
  size?: ButtonSize;
  /** Loading state */
  loading?: boolean;
  /** Icon-only button (square padding) */
  iconOnly?: boolean;
  /** Left icon */
  leftIcon?: ReactNode;
  /** Right icon */
  rightIcon?: ReactNode;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  iconOnly = false,
  leftIcon,
  rightIcon,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  const classNames = [
    'ds-button',
    `ds-button--${variant}`,
    size !== 'md' && `ds-button--${size}`,
    iconOnly && 'ds-button--icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classNames} disabled={disabled || loading} {...props}>
      {loading && <Spinner size="sm" aria-hidden />}
      {!loading && leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}

// Convenience component for icon buttons
export interface IconButtonProps extends Omit<
  ButtonProps,
  'iconOnly' | 'children' | 'leftIcon' | 'rightIcon'
> {
  /** Icon element */
  icon: ReactNode;
  /** Accessible label */
  'aria-label': string;
}

export function IconButton({ icon, variant = 'ghost', ...props }: IconButtonProps) {
  return (
    <Button variant={variant} iconOnly {...props}>
      {icon}
    </Button>
  );
}
