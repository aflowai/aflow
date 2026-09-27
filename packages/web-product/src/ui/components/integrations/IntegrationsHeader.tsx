'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Icon, Row } from '@aflow/design-system';

export type IntegrationKind = 'api' | 'mcp' | 'repo';
export type Filter = 'all' | IntegrationKind;

const KIND_LABEL: Record<IntegrationKind, string> = { api: 'API', mcp: 'MCP', repo: 'Repo' };

/** Kind badge — surfaced on each card so a mixed list is instantly scannable. */
export function KindBadge({ kind }: { kind: IntegrationKind }) {
  return <Badge variant="info">{KIND_LABEL[kind]}</Badge>;
}

/**
 * Buttons mimicking the prior `<Tabs>` affordance.
 *
 * `offersRepos` is the caller's answer about the coding lane; a filter for a
 * kind this deployment cannot hold would only ever select an empty list.
 */
export function FilterChips({
  value,
  onChange,
  offersRepos,
}: {
  value: Filter;
  onChange: (next: Filter) => void;
  offersRepos: boolean;
}) {
  const options: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'api', label: 'API' },
    { id: 'mcp', label: 'MCP' },
    ...(offersRepos ? [{ id: 'repo' as const, label: 'Repos' }] : []),
  ];
  return (
    <Row gap="1" align="center" wrap>
      {options.map((o) => (
        <Button
          key={o.id}
          variant={value === o.id ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => {
            onChange(o.id);
          }}
        >
          {o.label}
        </Button>
      ))}
    </Row>
  );
}

/**
 * Add button + kind-picker popover. No design-system Menu primitive exists,
 * so this is a small absolutely-positioned popover with two buttons. Closes
 * on outside click or Escape.
 *
 * `offersRepos` is the caller's answer about the coding lane: a designation
 * created for a lane that is absent is configuration the next run refuses.
 */
export function AddIntegrationButton({
  onPick,
  offersRepos,
}: {
  onPick: (kind: IntegrationKind) => void;
  offersRepos: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <Button
        variant="primary"
        leftIcon={<Icon name="plus" size="sm" />}
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Add integration
      </Button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--space-1))',
            right: 0,
            zIndex: 30,
            minWidth: 180,
            background: 'var(--color-surface-1)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: 'var(--space-1)',
            display: 'flex',
            alignItems: 'flex-start',
            flexDirection: 'column',
            gap: 'var(--space-1)',
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="globe" size="sm" />}
            onClick={() => {
              setOpen(false);
              onPick('api');
            }}
          >
            API
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="plugs-connected" size="sm" />}
            onClick={() => {
              setOpen(false);
              onPick('mcp');
            }}
          >
            MCP server
          </Button>
          {offersRepos && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="git-branch" size="sm" />}
              onClick={() => {
                setOpen(false);
                onPick('repo');
              }}
            >
              Code repository
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
