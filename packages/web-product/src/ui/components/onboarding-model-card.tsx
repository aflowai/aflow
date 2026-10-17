'use client';

import { Badge } from '@aflow/design-system';

/** One model offered at onboarding, selectable as a radio. */
export function ModelCard({
  label,
  via,
  tagline,
  recommended,
  selected,
  onSelect,
}: {
  label: string;
  via: string;
  tagline: string;
  recommended?: boolean | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        border: '2px solid',
        borderColor: selected ? 'var(--color-interactive-default)' : 'var(--color-border-subtle)',
        background: selected ? 'var(--color-surface-1)' : 'transparent',
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-1)',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)' }}>{label}</span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
          via {via}
        </span>
        {recommended && (
          <Badge variant="accent" style={{ fontSize: 'var(--font-size-xs)' }}>
            Recommended
          </Badge>
        )}
      </div>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-secondary)',
          lineHeight: 1.5,
        }}
      >
        {tagline}
      </div>
    </div>
  );
}
