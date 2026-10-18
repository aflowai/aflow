'use client';

import { useId, useState, type ReactNode } from 'react';
import { Icon, Text } from '@aflow/design-system';

export const placementLabels = {
  always_on: 'Always on',
  on_demand: 'On demand',
  off: 'Off',
  mixed: 'Custom',
} as const;

export function PlacementSection({
  title,
  count,
  countLabel = 'groups',
  description,
  forceOpen = false,
  children,
}: {
  title: string;
  count: number;
  countLabel?: string;
  description: string;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState<boolean | undefined>();
  const id = useId();
  const open = expanded ?? forceOpen;
  return (
    <section aria-label={title} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setExpanded(!open);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          width: '100%',
          padding: 'var(--space-2) 0',
          border: 0,
          background: 'none',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <Icon name={open ? 'caret-down' : 'caret-right'} size="xs" />
        <Text as="span" size="sm" weight="semibold" style={{ flex: 1 }}>
          {title}
        </Text>
        <Text as="span" size="xs" variant="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {count} {count === 1 ? countLabel.slice(0, -1) : countLabel}
        </Text>
      </button>
      {open && (
        <div id={id}>
          <Text as="div" size="xs" variant="muted" style={{ paddingBottom: 'var(--space-2)' }}>
            {description}
          </Text>
          {count ? (
            children
          ) : (
            <Text as="div" size="xs" variant="muted" style={{ paddingBottom: 'var(--space-3)' }}>
              Nothing here.
            </Text>
          )}
        </div>
      )}
    </section>
  );
}
