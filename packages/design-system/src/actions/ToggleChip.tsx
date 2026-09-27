import { forwardRef, type ReactNode, type ButtonHTMLAttributes } from 'react';

export interface ToggleChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  /** Whether the chip is in its active/pressed state. */
  active: boolean;
  /** Icon element to show (typically <Icon name="..." size="xs" />). */
  icon: ReactNode;
  /** Optional trailing content (badge, count, label). */
  children?: ReactNode;
}

/**
 * ToggleChip — a small pill-shaped toggle button for toolbars and action bars.
 *
 * Active state: accent border + tinted background + accent text.
 * Inactive state: subtle border + transparent background + muted text.
 *
 * @example
 * ```tsx
 * <ToggleChip active={showConfig} icon={<Icon name="gear" size="xs" />} onClick={toggle}>
 *   <Badge variant="info">2</Badge>
 * </ToggleChip>
 * ```
 */
export const ToggleChip = forwardRef<HTMLButtonElement, ToggleChipProps>(function ToggleChip(
  { active, icon, children, className = '', ...rest },
  ref,
) {
  const classes = ['ds-toggle-chip', active && 'ds-toggle-chip--active', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type="button" className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
});
