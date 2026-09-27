import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

// ─── List ───────────────────────────────────────────────────────────────────

export interface ListProps extends HTMLAttributes<HTMLDivElement> {
  /** Content — should be ListItem elements */
  children?: ReactNode;
  /** Show divider lines between items */
  dividers?: boolean;
  /** Gap between items (ignored when dividers is true) */
  gap?: 'none' | 'xs' | 'sm' | 'md';
}

export function List({
  children,
  dividers = false,
  gap = 'sm',
  className = '',
  ...props
}: ListProps) {
  const classNames = ['ds-list', dividers && 'ds-list--dividers', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      role="list"
      className={classNames}
      style={
        !dividers && gap !== 'none'
          ? { gap: `var(--space-${gap === 'xs' ? '1' : gap === 'sm' ? '2' : '3'})` }
          : undefined
      }
      {...props}
    >
      {children}
    </div>
  );
}

// ─── ListItem ───────────────────────────────────────────────────────────────

export interface ListItemProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'value'
> {
  /** Primary text */
  title?: string;
  /** Secondary text below title */
  subtitle?: string;
  /** Leading icon element */
  icon?: ReactNode;
  /** Leading avatar element */
  avatar?: ReactNode;
  /** Trailing value text (e.g. count, date) */
  value?: ReactNode;
  /** Trailing element (overrides value) */
  trailing?: ReactNode;
  /** Show hover/press affordance — renders as <button> when true */
  clickable?: boolean;
  /** Selected state — shows accent indicator */
  selected?: boolean;
  /** Rich content — replaces title/subtitle when provided */
  children?: ReactNode;
}

export const ListItem = forwardRef<HTMLButtonElement, ListItemProps>(function ListItem(
  {
    title,
    subtitle,
    icon,
    avatar,
    value,
    trailing,
    clickable = false,
    selected = false,
    children,
    className = '',
    disabled,
    ...props
  },
  ref,
) {
  const classNames = [
    'ds-list-item',
    clickable && 'ds-list-item--clickable',
    selected && 'ds-list-item--selected',
    disabled && 'ds-list-item--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const leading = icon ?? avatar;
  const trailingContent =
    trailing ?? (value != null ? <span className="ds-list-item__value">{value}</span> : null);

  const content = (
    <>
      {leading && <span className="ds-list-item__leading">{leading}</span>}
      <span className="ds-list-item__main">
        {children ?? (
          <>
            {title && <span className="ds-list-item__title">{title}</span>}
            {subtitle && <span className="ds-list-item__subtitle">{subtitle}</span>}
          </>
        )}
      </span>
      {trailingContent && <span className="ds-list-item__trailing">{trailingContent}</span>}
    </>
  );

  if (clickable) {
    return (
      <button
        ref={ref}
        role="listitem"
        type="button"
        className={classNames}
        disabled={disabled}
        {...props}
      >
        {content}
      </button>
    );
  }

  return (
    <div role="listitem" className={classNames} {...(props as HTMLAttributes<HTMLDivElement>)}>
      {content}
    </div>
  );
});
