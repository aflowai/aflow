'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Icon, Text, type IconName } from '@aflow/design-system';

export interface SkillSummary {
  slug: string;
  name: string;
  mode: 'optimization' | 'process' | 'project';
  status: string;
  origin: string | null;
  archivedAt?: string | null | undefined;
}

const MODE_ICON: Record<string, IconName> = {
  optimization: 'bullseye',
  process: 'gears',
  project: 'slalom',
};

const UNKNOWN_MODE_ICON: IconName = 'info';

function modeIcon(mode: string): IconName {
  return MODE_ICON[mode] ?? UNKNOWN_MODE_ICON;
}

export function SkillSwitcher({
  skills,
  selectedSlug,
  onSelect,
}: {
  skills: SkillSummary[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const current = skills.find((s) => s.slug === selectedSlug) ?? null;

  const { catalog, operator, archivedCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: SkillSummary) => !q || s.name.toLowerCase().includes(q) || s.slug.includes(q);
    const matched = skills.filter(match);
    const visible = showArchived ? matched : matched.filter((s) => !s.archivedAt);
    return {
      catalog: visible.filter((s) => s.origin !== null),
      operator: visible.filter((s) => s.origin === null),
      archivedCount: matched.filter((s) => s.archivedAt).length,
    };
  }, [skills, query, showArchived]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          background: 'var(--color-surface-0)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-full)',
          padding: '6px 12px 6px 14px',
          cursor: 'pointer',
          maxWidth: 560,
        }}
      >
        <Icon name="skill" size="lg" />
        <Text size="lg" weight="semibold" truncate style={{ minWidth: 0 }}>
          {current?.name ?? 'Select a skill'}
        </Text>
        {current && (
          <Badge variant="neutral" icon={<Icon name={modeIcon(current.mode)} size="xs" />}>
            {current.mode}
          </Badge>
        )}
        <Icon name="caret-down" size="sm" style={{ color: 'var(--color-text-muted)' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            width: 'min(360px, calc(100vw - var(--space-8)))',
            maxHeight: 440,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-surface-0)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: 'var(--space-sm)' }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search skills…"
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 'var(--font-size-base)',
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text-primary)',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ overflow: 'auto', paddingBottom: 'var(--space-sm)' }}>
            <SwitcherGroup
              label="Skills catalog"
              items={catalog}
              selectedSlug={selectedSlug}
              onPick={(s) => {
                onSelect(s);
                setOpen(false);
              }}
            />
            <SwitcherGroup
              label="Operator-authored"
              items={operator}
              selectedSlug={selectedSlug}
              onPick={(s) => {
                onSelect(s);
                setOpen(false);
              }}
            />
            {catalog.length === 0 && operator.length === 0 && (
              <div style={{ padding: 'var(--space-md)' }}>
                <Text size="sm" color="muted">
                  No skills match.
                </Text>
              </div>
            )}
          </div>
          {archivedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setShowArchived((v) => !v);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-sm)',
                width: '100%',
                padding: 'var(--space-sm) var(--space-md)',
                background: 'var(--color-surface-1)',
                border: 'none',
                borderTop: '1px solid var(--color-border-subtle)',
                cursor: 'pointer',
              }}
            >
              <Icon
                name={showArchived ? 'eye-slash' : 'eye'}
                size="sm"
                style={{ color: 'var(--color-text-muted)' }}
              />
              <Text size="sm" color="muted">
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </Text>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SwitcherGroup({
  label,
  items,
  selectedSlug,
  onPick,
}: {
  label: string;
  items: SkillSummary[];
  selectedSlug: string | null;
  onPick: (slug: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <Text
        size="xs"
        variant="label"
        color="muted"
        weight="semibold"
        style={{
          display: 'block',
          padding: '6px 12px',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </Text>
      {items.map((s) => {
        const active = s.slug === selectedSlug;
        return (
          <button
            key={s.slug}
            type="button"
            onClick={() => {
              onPick(s.slug);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-sm)',
              width: '100%',
              textAlign: 'left',
              padding: '8px 12px',
              background: active ? 'var(--color-surface-2)' : 'transparent',
              border: 'none',
              borderLeft: `2px solid ${active ? 'var(--color-interactive-default)' : 'transparent'}`,
              cursor: 'pointer',
            }}
          >
            <Icon name={modeIcon(s.mode)} size="sm" style={{ color: 'var(--color-text-muted)' }} />
            <Text size="base" truncate style={{ flex: 1 }}>
              {s.name}
            </Text>
            {s.archivedAt && <Badge variant="warning">archived</Badge>}
          </button>
        );
      })}
    </div>
  );
}
