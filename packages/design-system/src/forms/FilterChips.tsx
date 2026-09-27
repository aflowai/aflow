import type { HTMLAttributes, ReactNode } from 'react';

export interface FilterChipOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface FilterChipsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Available options */
  options: FilterChipOption[];
  /** Currently selected value(s) */
  value?: string | string[];
  /** Change handler */
  onChange?: (value: string) => void;
  /** Allow "all" / no selection */
  allowEmpty?: boolean;
  /** Size */
  size?: 'sm' | 'md';
}

export function FilterChips({
  options,
  value,
  onChange,
  allowEmpty: _allowEmpty = true,
  size = 'sm',
  style,
  ...rest
}: FilterChipsProps) {
  const selectedSet = new Set(Array.isArray(value) ? value : value != null ? [value] : []);
  const isSmall = size === 'sm';

  return (
    <div
      role="group"
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: 'var(--space-xs)',
        flexWrap: 'wrap',
        ...style,
      }}
      {...rest}
    >
      {options.map((opt) => {
        const isActive = selectedSet.has(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange?.(opt.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-xs)',
              padding: isSmall
                ? 'var(--space-xs) var(--space-md)'
                : 'var(--space-sm) var(--space-lg)',
              fontSize: isSmall ? 'var(--font-size-xs)' : 'var(--font-size-sm)',
              fontWeight: isActive ? 'var(--font-weight-medium)' : 'var(--font-weight-normal)',
              color: isActive ? 'var(--color-content-primary)' : 'var(--color-content-muted)',
              backgroundColor: isActive ? 'var(--color-interactive-muted)' : 'transparent',
              border: '1px solid',
              borderColor: isActive ? 'var(--color-border-strong)' : 'var(--color-border-subtle)',
              borderRadius: 'var(--radius-full)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all var(--transition-duration-fast) var(--transition-timing-default)',
              lineHeight: 1,
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
