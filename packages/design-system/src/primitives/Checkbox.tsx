import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type CheckboxSize = 'sm' | 'md';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'children' | 'size'
> {
  /** Checked state (controlled) */
  checked?: boolean;
  /** Change handler */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Explicit label content for common checkbox usage */
  label?: ReactNode;
  /** Label content - when provided, wraps checkbox in a label for accessibility */
  children?: ReactNode;
  /** Error state */
  error?: boolean;
  /** Label size (affects label text when children provided) */
  size?: CheckboxSize;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      checked,
      onChange,
      label,
      children,
      error = false,
      size = 'md',
      className = '',
      id,
      ...props
    },
    ref,
  ) => {
    const labelContent = children ?? label;
    const inputId =
      id ?? (labelContent ? `ds-checkbox-${Math.random().toString(36).slice(2)}` : undefined);
    const classNames = ['ds-checkbox', error && 'ds-checkbox--error', className]
      .filter(Boolean)
      .join(' ');

    const input = (
      <input
        ref={ref}
        type="checkbox"
        id={inputId}
        className={classNames}
        checked={checked}
        onChange={onChange}
        {...props}
      />
    );

    if (labelContent) {
      return (
        <label className={`ds-checkbox-wrapper ds-checkbox-wrapper--${size}`} htmlFor={inputId}>
          {input}
          <span className="ds-checkbox-label">{labelContent}</span>
        </label>
      );
    }

    return input;
  },
);

Checkbox.displayName = 'Checkbox';
