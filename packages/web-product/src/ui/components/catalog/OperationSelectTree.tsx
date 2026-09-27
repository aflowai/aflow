'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Checkbox, Icon, Text } from '@aflow/design-system';

import { useOperationCatalog, type CatalogOperation } from '../../hooks/use-operation-catalog.js';
import type { BlockedOperation } from '../../hooks/use-space-operation-grants.js';

export const treeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '6px 10px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// Tree primitives
// ---------------------------------------------------------------------------

export function TreeSubGroup({
  id,
  label,
  count,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={{ ...treeRowStyle, paddingLeft: 22, cursor: 'default' }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'inline-flex',
            padding: 0,
          }}
          title={id}
        >
          <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
        </button>
        <button
          type="button"
          onClick={onToggle}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: 0,
          }}
        >
          <Text size="sm" weight="semibold" truncate>
            {label}
          </Text>
        </button>
        {count && (
          <Text size="xs" color="muted">
            {count}
          </Text>
        )}
      </div>
      {expanded && (
        <div
          style={{
            paddingLeft: 40,
            paddingBottom: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function TreeLeaf({
  checked,
  onToggle,
  label,
  warn,
}: {
  checked: boolean;
  onToggle: () => void;
  label: ReactNode;
  /** When set, the op is outside the space profile; value = required capability. */
  warn?: string;
}) {
  return (
    <div
      style={{
        paddingLeft: 40,
        paddingRight: 6,
        borderRadius: 'var(--radius-sm)',
        background: checked ? 'var(--color-surface-2)' : 'transparent',
      }}
    >
      <Checkbox checked={checked} onChange={onToggle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {label}
          {warn && (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
              title={`Not enabled by this space’s capability profile — requires ${warn}`}
            >
              <Icon name="warning" size="xs" color="var(--color-warning-default)" />
              <Text size="xs" color="muted">
                needs {warn}
              </Text>
            </span>
          )}
        </span>
      </Checkbox>
    </div>
  );
}

export function TreeHint({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '6px 22px' }}>
      <Text size="sm" color="muted" style={{ fontStyle: 'italic' }}>
        {children}
      </Text>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog slice
// ---------------------------------------------------------------------------

/**
 * The catalog operations that can be handed to an agent as a tool. Structural
 * runtime primitives (ai.text.generate, ai.agent.turn, …) are excluded — the
 * agent generates and decides natively, so they are never tools.
 */
export function useAgentOperations(): {
  operations: CatalogOperation[];
  isLoading: boolean;
  /** Set when the catalog could not be read. Callers that judge a saved id
      against the catalog must not treat an empty list as "no such operation". */
  error: string | null;
} {
  const { operations, isLoading, error } = useOperationCatalog();
  const agentOperations = useMemo(
    () => operations.filter((o) => o.agentTool !== false),
    [operations],
  );
  return { operations: agentOperations, isLoading, error };
}

// ---------------------------------------------------------------------------
// OperationSelectTree
// ---------------------------------------------------------------------------

export interface OperationSelectTreeProps {
  /** Search text. While non-empty every matching group is expanded. */
  query: string;
  selected: readonly string[];
  onToggle: (operationId: string) => void;
  blockedById?: Map<string, BlockedOperation>;
  /** `page` has room for the display name next to the id; `compact` does not. */
  variant?: 'compact' | 'page';
}

/**
 * Agent-grantable operations grouped by step type, as a checkbox tree. Renders
 * the rows only — the caller owns the surrounding container and search field so
 * one search box can drive this alongside other capability arms.
 */
export function OperationSelectTree({
  query,
  selected,
  onToggle,
  blockedById,
  variant = 'compact',
}: OperationSelectTreeProps) {
  const { operations } = useAgentOperations();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ql = query.trim().toLowerCase();
  const searching = ql.length > 0;

  const groups = useMemo(() => {
    const map = new Map<string, CatalogOperation[]>();
    for (const o of operations) {
      if (
        ql &&
        !o.operationId.toLowerCase().includes(ql) &&
        !(o.displayName ?? '').toLowerCase().includes(ql)
      )
        continue;
      const list = map.get(o.stepType) ?? [];
      list.push(o);
      map.set(o.stepType, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [operations, ql]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleExpanded = (stepType: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(stepType)) next.delete(stepType);
      else next.add(stepType);
      return next;
    });
  };

  if (groups.length === 0) return <TreeHint>No operations match.</TreeHint>;

  return (
    <>
      {groups.map(([stepType, ops]) => {
        const sel = ops.filter((o) => selectedSet.has(o.operationId)).length;
        return (
          <TreeSubGroup
            key={stepType}
            id={`op:${stepType}`}
            label={stepType}
            count={sel > 0 ? `${sel}/${ops.length}` : String(ops.length)}
            expanded={searching || expanded.has(stepType)}
            onToggle={() => {
              toggleExpanded(stepType);
            }}
          >
            {ops.map((o) => {
              const checked = selectedSet.has(o.operationId);
              const blk = blockedById?.get(o.operationId);
              return (
                <TreeLeaf
                  key={o.operationId}
                  checked={checked}
                  onToggle={() => {
                    onToggle(o.operationId);
                  }}
                  {...(blk ? { warn: blk.requires } : {})}
                  label={
                    <>
                      <Text size="sm" variant="mono">
                        {o.operationId}
                      </Text>
                      {variant === 'page' && o.displayName && (
                        <Text size="xs" color="muted">
                          {o.displayName}
                        </Text>
                      )}
                    </>
                  }
                />
              );
            })}
          </TreeSubGroup>
        );
      })}
    </>
  );
}
