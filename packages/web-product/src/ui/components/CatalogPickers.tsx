'use client';

/**
 * Dynamic catalog pickers — step types and operations as toggleable chips.
 *
 * Used in BindingsEditor (agent editor) — for catalog.discovery.allowedStepTypes /
 * catalog.coreOperations on ai.agent.turn. Fetches from the catalog API via
 * useOperationCatalog and renders a chip-toggle pattern.
 */

import { useMemo, useState } from 'react';
import { Row, Text, Input, Icon, Badge } from '@aflow/design-system';
import type { IconName } from '@aflow/design-system';
import { useOperationCatalog } from '../hooks/use-operation-catalog.js';

// ---------------------------------------------------------------------------
// Step type metadata (icons + colors) — single source for all step type UI
// ---------------------------------------------------------------------------

export const STEP_TYPE_META: Record<string, { icon: IconName; color: string; label?: string }> = {
  ai: { icon: 'brain', color: 'var(--color-interactive-default)' },
  memory: { icon: 'database', color: 'var(--color-info-default)' },
  api: { icon: 'globe', color: 'var(--color-warning-default)' },
  compute: { icon: 'terminal', color: 'var(--color-success-default)' },
  search: { icon: 'magnifying-glass', color: 'var(--color-interactive-secondary)' },
  agent: { icon: 'robot', color: 'var(--color-interactive-default)', label: 'Agent' },
  user: { icon: 'user', color: 'var(--color-info-default)' },
  eval: { icon: 'list-magnifying-glass', color: 'var(--color-warning-default)', label: 'Eval' },
  guardrail: { icon: 'shield-check', color: 'var(--color-danger-default)', label: 'Guardrail' },
  ui: { icon: 'squares-four', color: 'var(--color-success-default)', label: 'UI' },
  mcp: { icon: 'plugs-connected', color: 'var(--color-interactive-secondary)', label: 'MCP' },
  catalog: { icon: 'list-magnifying-glass', color: 'var(--color-text-secondary)' },
  space: { icon: 'folder-simple', color: 'var(--color-text-secondary)' },
  goal: { icon: 'flag', color: 'var(--color-success-default)', label: 'Goal' },
};

export function getStepTypeIcon(stepType: string): IconName {
  return STEP_TYPE_META[stepType]?.icon ?? 'gear';
}

export function getStepTypeColor(stepType: string): string {
  return STEP_TYPE_META[stepType]?.color ?? 'var(--color-text-muted)';
}

// ---------------------------------------------------------------------------
// StepTypeChips — toggleable chips for selecting step types
// ---------------------------------------------------------------------------

interface StepTypeChipsProps {
  /** Currently selected step type strings */
  value: string[];
  /** Called with updated array on toggle */
  onChange: (value: string[]) => void;
  /** Compact mode — smaller chips, no descriptions */
  compact?: boolean;
}

export function StepTypeChips({ value, onChange, compact }: StepTypeChipsProps) {
  const { stepTypes, isLoading } = useOperationCatalog();
  const selectedSet = new Set(value);

  if (isLoading) {
    return (
      <Text variant="muted" size="xs">
        Loading step types…
      </Text>
    );
  }

  if (stepTypes.length === 0) {
    return (
      <Text variant="muted" size="xs">
        No step types available
      </Text>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
      {stepTypes.map((st) => {
        const active = selectedSet.has(st.type);
        const meta = STEP_TYPE_META[st.type];
        const iconName = meta?.icon ?? 'gear';
        const accentColor = active ? (meta?.color ?? 'var(--color-accent-default)') : undefined;

        return (
          <button
            key={st.type}
            type="button"
            onClick={() => {
              const next = active ? value.filter((v) => v !== st.type) : [...value, st.type];
              onChange(next);
            }}
            title={compact ? st.displayName : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: compact ? '2px 6px' : '3px 10px',
              borderRadius: 'var(--radius-full)',
              border: active
                ? `1.5px solid ${accentColor}`
                : '1px solid var(--color-border-default)',
              backgroundColor: active
                ? 'var(--color-surface-raised)'
                : 'var(--color-surface-default)',
              color: active ? accentColor : 'var(--color-content-secondary)',
              fontSize: compact ? 'var(--font-size-xs)' : 'var(--font-size-sm)',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <Icon name={iconName} size="xs" />
            {st.displayName}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OperationChips — toggleable chips for selecting operations
// ---------------------------------------------------------------------------

interface OperationChipsProps {
  /** Currently selected operation ID strings */
  value: string[];
  /** Called with updated array on toggle */
  onChange: (value: string[]) => void;
  /** Only show operations for these step types (if empty, shows all) */
  filterStepTypes?: string[];
  /** Compact mode */
  compact?: boolean;
}

export function OperationChips({ value, onChange, filterStepTypes, compact }: OperationChipsProps) {
  const { operations, isLoading } = useOperationCatalog();
  const [search, setSearch] = useState('');
  const selectedSet = new Set(value);

  const filteredOps = useMemo(() => {
    let ops = operations;
    if (filterStepTypes && filterStepTypes.length > 0) {
      const allowed = new Set(filterStepTypes);
      ops = ops.filter((o) => allowed.has(o.stepType));
    }
    if (search) {
      const q = search.toLowerCase();
      ops = ops.filter(
        (o) => o.operationId.toLowerCase().includes(q) || o.displayName.toLowerCase().includes(q),
      );
    }
    return ops;
  }, [operations, filterStepTypes, search]);

  // Group by step type for readability
  const grouped = useMemo(() => {
    const map = new Map<string, typeof filteredOps>();
    for (const op of filteredOps) {
      const list = map.get(op.stepType) ?? [];
      list.push(op);
      map.set(op.stepType, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredOps]);

  if (isLoading) {
    return (
      <Text variant="muted" size="xs">
        Loading operations…
      </Text>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <Input
        type="search"
        placeholder="Search operations…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
        style={{ fontSize: 'var(--font-size-xs)' }}
      />

      {value.length > 0 && (
        <Row gap="1" style={{ flexWrap: 'wrap' }}>
          <Text variant="muted" size="xs" style={{ marginRight: 'var(--space-1)' }}>
            Selected:
          </Text>
          {value.map((opId) => {
            const op = operations.find((o) => o.operationId === opId);
            return (
              <Badge
                key={opId}
                variant="info"
                style={{ fontSize: '9px', cursor: 'pointer' }}
                onClick={() => {
                  onChange(value.filter((v) => v !== opId));
                }}
              >
                {op?.displayName ?? opId} ×
              </Badge>
            );
          })}
        </Row>
      )}

      <div
        style={{
          maxHeight: '200px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
        className="ds-scroll-subtle"
      >
        {grouped.length === 0 ? (
          <Text variant="muted" size="xs">
            No operations match
          </Text>
        ) : (
          grouped.map(([stepType, ops]) => (
            <div key={stepType}>
              <Text
                variant="muted"
                size="xs"
                style={{ fontWeight: 600, marginBottom: 'var(--space-1)' }}
              >
                {stepType}
              </Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                {ops.map((op) => {
                  const active = selectedSet.has(op.operationId);
                  return (
                    <button
                      key={op.operationId}
                      type="button"
                      onClick={() => {
                        const next = active
                          ? value.filter((v) => v !== op.operationId)
                          : [...value, op.operationId];
                        onChange(next);
                      }}
                      title={op.description}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                        padding: compact ? '1px 5px' : '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        border: active
                          ? '1.5px solid var(--color-accent-default)'
                          : '1px solid var(--color-border-default)',
                        backgroundColor: active
                          ? 'var(--color-accent-subtle)'
                          : 'var(--color-surface-default)',
                        color: active
                          ? 'var(--color-accent-default)'
                          : 'var(--color-content-secondary)',
                        fontSize: '11px',
                        fontWeight: active ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.12s ease',
                      }}
                    >
                      {op.displayName}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
