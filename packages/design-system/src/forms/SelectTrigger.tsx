import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Icon } from '../icons/Icon.js';

export interface SelectTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Prevents accidental form submission */
  type?: 'button' | 'submit' | 'reset';
  /** Optional icon before the label */
  leadingIcon?: ReactNode;
  /** When false, hides the default caret */
  showCaret?: boolean;
  /** Custom trailing node (replaces the caret when set) */
  trailingSlot?: ReactNode;
  /** Muted label style when no value is selected */
  isPlaceholder?: boolean;
  /** Error border (matches native Select error styling) */
  error?: boolean;
  /** Mirrors open state of the attached surface */
  expanded?: boolean;
  /** Passed to aria-haspopup */
  popup?: 'listbox' | 'menu' | 'dialog' | 'true' | 'false';
}

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger(
    {
      type = 'button',
      leadingIcon,
      showCaret = true,
      trailingSlot,
      isPlaceholder = false,
      error = false,
      expanded,
      popup = 'listbox',
      disabled,
      className = '',
      children,
      ...props
    },
    ref,
  ) {
    const classNames = [
      'ds-select-trigger',
      isPlaceholder && 'ds-select-trigger--placeholder',
      error && 'ds-select-trigger--error',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const trailing =
      trailingSlot ??
      (showCaret ? (
        <Icon
          name="caret-down"
          size="xs"
          color="var(--color-content-muted)"
          style={{ flexShrink: 0 }}
          aria-hidden
        />
      ) : null);

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        className={classNames}
        aria-expanded={expanded}
        aria-haspopup={popup}
        {...props}
      >
        {leadingIcon ? <span className="ds-select-trigger__leading">{leadingIcon}</span> : null}
        <span className="ds-select-trigger__label">{children}</span>
        {trailing ? <span className="ds-select-trigger__trailing">{trailing}</span> : null}
      </button>
    );
  },
);

SelectTrigger.displayName = 'SelectTrigger';
