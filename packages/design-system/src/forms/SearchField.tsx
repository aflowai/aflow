import { type InputHTMLAttributes, forwardRef } from 'react';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Callback when value changes */
  onValueChange?: (value: string) => void;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { onValueChange, onChange, placeholder = 'Search...', style, ...rest },
  ref,
) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        ...style,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 256 256"
        fill="none"
        style={{
          position: 'absolute',
          left: 'var(--space-md)',
          color: 'var(--color-content-muted)',
          pointerEvents: 'none',
          flexShrink: 0,
        }}
      >
        <path
          d="M229.66 218.34l-50.07-50.06a88.11 88.11 0 1 0-11.31 11.31l50.06 50.07a8 8 0 0 0 11.32-11.32ZM40 112a72 72 0 1 1 72 72 72.08 72.08 0 0 1-72-72Z"
          fill="currentColor"
        />
      </svg>
      <input
        ref={ref}
        type="search"
        className="ds-input"
        placeholder={placeholder}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
        style={{
          paddingLeft: 'calc(var(--space-md) + 14px + var(--space-sm))',
          width: '100%',
        }}
        {...rest}
      />
    </div>
  );
});
