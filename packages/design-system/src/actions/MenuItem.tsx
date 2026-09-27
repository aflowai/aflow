import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Leading icon element (typically <Icon name="..." size="sm" />). */
  icon?: ReactNode;
  /** The action this row performs. */
  label: string;
  /** Second line — the current state, or what the action will do. */
  description?: string;
  /** Right-hand slot: a value, a state word, or a disclosure caret. */
  trailing?: ReactNode;
  /** Highlights the row as the current choice or an open panel. */
  active?: boolean;
}

/**
 * One row of a popover menu: the whole row is the hit target, and the icon and
 * trailing slot are decoration on it rather than controls of their own. Flat by
 * design — a menu row that carries its own border and surface reads as selected
 * the moment the menu opens.
 *
 * @example
 * ```tsx
 * <MenuItem
 *   icon={<Icon name="microphone" size="sm" />}
 *   label="Voice mode"
 *   onClick={startVoice}
 * />
 * ```
 */
export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, label, description, trailing, active = false, className = '', ...rest },
  ref,
) {
  const classes = ['ds-menu-item', active && 'ds-menu-item--active', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type="button" className={classes} {...rest}>
      {icon && <span className="ds-menu-item__icon">{icon}</span>}
      <span className="ds-menu-item__main">
        <span className="ds-menu-item__label">{label}</span>
        {description && <span className="ds-menu-item__description">{description}</span>}
      </span>
      {trailing && <span className="ds-menu-item__trailing">{trailing}</span>}
    </button>
  );
});
