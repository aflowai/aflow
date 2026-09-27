'use client';

import { type HTMLAttributes, type ReactNode, useState } from 'react';

export interface AccordionItemData {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}

export interface AccordionProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Items to render */
  items: AccordionItemData[];
  /** Allow multiple items open at once */
  multiple?: boolean;
  /** Initially expanded item IDs */
  defaultExpanded?: string[];
  /** Controlled expanded state */
  expanded?: string[];
  /** Change handler */
  onExpandedChange?: (expanded: string[]) => void;
}

export function Accordion({
  items,
  multiple = false,
  defaultExpanded = [],
  expanded: controlledExpanded,
  onExpandedChange,
  style,
  ...rest
}: AccordionProps) {
  const [internalExpanded, setInternalExpanded] = useState<string[]>(defaultExpanded);
  const expanded = controlledExpanded ?? internalExpanded;

  function toggle(id: string) {
    let next: string[];
    if (expanded.includes(id)) {
      next = expanded.filter((x) => x !== id);
    } else {
      next = multiple ? [...expanded, id] : [id];
    }
    if (controlledExpanded == null) {
      setInternalExpanded(next);
    }
    onExpandedChange?.(next);
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      {items.map((item, i) => {
        const isOpen = expanded.includes(item.id);
        return (
          <div key={item.id}>
            {i > 0 && <div style={{ borderTop: '1px solid var(--color-border-subtle)' }} />}
            <button
              type="button"
              onClick={() => {
                toggle(item.id);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-md)',
                width: '100%',
                padding: 'var(--space-md) var(--space-lg)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--color-content-primary)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 'var(--font-weight-medium)',
                transition:
                  'background-color var(--transition-duration-fast) var(--transition-timing-default)',
              }}
              aria-expanded={isOpen}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="currentColor"
                style={{
                  flexShrink: 0,
                  color: 'var(--color-content-muted)',
                  transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition:
                    'transform var(--transition-duration-fast) var(--transition-timing-default)',
                }}
              >
                <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
              <span style={{ flex: 1 }}>{item.title}</span>
              {item.subtitle && (
                <span
                  style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-content-muted)' }}
                >
                  {item.subtitle}
                </span>
              )}
              {item.badge}
            </button>
            {isOpen && (
              <div
                style={{
                  padding: '0 var(--space-lg) var(--space-lg)',
                }}
              >
                {item.children}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
