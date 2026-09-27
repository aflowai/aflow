import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
  type LabelHTMLAttributes,
} from 'react';

// =============================================================================
// Input
// =============================================================================

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Error state */
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error = false, className = '', ...props }, ref) => {
    const classNames = ['ds-input', error && 'ds-input--error', className]
      .filter(Boolean)
      .join(' ');

    return <input ref={ref} className={classNames} {...props} />;
  },
);

Input.displayName = 'Input';

// =============================================================================
// Textarea
// =============================================================================

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error state */
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error = false, className = '', rows = 3, ...props }, ref) => {
    const classNames = ['ds-input', error && 'ds-input--error', className]
      .filter(Boolean)
      .join(' ');

    return <textarea ref={ref} className={classNames} rows={rows} {...props} />;
  },
);

Textarea.displayName = 'Textarea';

// =============================================================================
// Select
// =============================================================================

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Error state */
  error?: boolean;
  /** Placeholder option */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ error = false, placeholder, children, className = '', ...props }, ref) => {
    const classNames = ['ds-input', error && 'ds-input--error', className]
      .filter(Boolean)
      .join(' ');

    return (
      <select ref={ref} className={classNames} {...props}>
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {children}
      </select>
    );
  },
);

Select.displayName = 'Select';

// =============================================================================
// Label
// =============================================================================

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /** Required indicator */
  required?: boolean;
}

export function Label({ required, children, className = '', ...props }: LabelProps) {
  return (
    <label
      className={`ds-text-sm ds-font-medium ${className}`}
      style={{
        color: 'var(--color-text-primary)',
        display: 'block',
        marginBottom: 'var(--space-1)',
      }}
      {...props}
    >
      {children}
      {required && (
        <span style={{ color: 'var(--color-danger-default)', marginLeft: 'var(--space-0-5)' }}>
          *
        </span>
      )}
    </label>
  );
}

// =============================================================================
// HelperText
// =============================================================================

export interface HelperTextProps {
  children?: ReactNode;
  className?: string;
}

export function HelperText({ children, className = '' }: HelperTextProps) {
  return (
    <p
      className={className}
      style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-muted)',
        marginTop: 'var(--space-1)',
      }}
    >
      {children}
    </p>
  );
}

// =============================================================================
// FieldError
// =============================================================================

export interface FieldErrorProps {
  children?: ReactNode;
  className?: string;
}

export function FieldError({ children, className = '' }: FieldErrorProps) {
  if (!children) return null;

  return (
    <p
      className={className}
      role="alert"
      style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-danger-default)',
        marginTop: 'var(--space-1)',
      }}
    >
      {children}
    </p>
  );
}

// =============================================================================
// Field (composition wrapper)
// =============================================================================

export interface FieldProps {
  /** Field label */
  label?: string;
  /** Whether the field is required */
  required?: boolean;
  /** Helper text */
  helperText?: string;
  /** Error message */
  error?: string;
  /** `id` of the control this labels — without it the label is decorative to assistive tech. */
  htmlFor?: string;
  /** The input element */
  children: ReactNode;
  /** Additional class name */
  className?: string;
}

export function Field({
  label,
  required,
  helperText,
  error,
  htmlFor,
  children,
  className = '',
}: FieldProps) {
  return (
    <div className={className} style={{ marginBottom: 'var(--space-2)' }}>
      {label && (
        <Label required={required ?? false} {...(htmlFor ? { htmlFor } : {})}>
          {label}
        </Label>
      )}
      {children}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        helperText && <HelperText>{helperText}</HelperText>
      )}
    </div>
  );
}
