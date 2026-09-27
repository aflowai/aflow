'use client';

/**
 * CatalogToolSelector — purpose-built editor for the `catalog` config on ai.agent.turn steps.
 *
 * Replaces the generic ObjectValueEditor with a two-level accordion:
 *   1. Step type chips (scope selection) → writes catalog.discovery.allowedStepTypes
 *   2. Collapsible groups per step type with operation checkboxes → writes catalog.coreOperations
 *
 * Also: discovery toggle, advanced settings expandable.
 */

import { useMemo, useState } from 'react';
import { Text, Checkbox, Badge, Icon, Divider, Input, Select } from '@aflow/design-system';
import { StepTypeChips } from '../../CatalogPickers.js';
import { getStepTypeIcon, getStepTypeColor } from '../../CatalogPickers.js';
import type { CatalogOperation } from '../../../hooks/use-operation-catalog.js';
import type { IconName } from '@aflow/design-system';

/** Known keys on `step.config.catalog.discovery` sub-object. */
interface DiscoveryConfigRecord {
  allowedStepTypes?: unknown;
  allowedApiIds?: unknown;
  allowedAgents?: unknown;
  excludeOperationIds?: unknown;
  excludeGroupIds?: unknown;
  [key: string]: unknown;
}

/** Known keys on `step.config.catalog` — use for dot access (TS index signature + ESLint dot-notation). */
interface CatalogConfigRecord {
  coreOperations?: unknown;
  coreAgents?: unknown;
  coreApis?: unknown;
  discoveryStepId?: unknown;
  discovery?: DiscoveryConfigRecord | undefined;
  format?: unknown;
  [key: string]: unknown;
}

interface CatalogToolSelectorProps {
  /** The raw catalog config object from step.config.catalog */
  value: Record<string, unknown>;
  /** Called with the updated catalog config object */
  onChange: (value: Record<string, unknown>) => void;
  /** Available operations from the catalog API */
  operations: CatalogOperation[];
}

/** Check if a value is a ${state.*} or ${input.*} variable reference. */
function isStateRef(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('${') && v.endsWith('}');
}

/** Extract typed arrays from the raw config object, handling ${state.*} refs. */
function extractConfig(raw: Record<string, unknown>) {
  const r = raw as CatalogConfigRecord;
  const disc = r.discovery;
  const rawStepTypes = disc?.allowedStepTypes;
  const stepTypes = Array.isArray(rawStepTypes) ? (rawStepTypes as string[]) : [];
  const stepTypesIsRef = isStateRef(rawStepTypes);

  const rawCoreOps = r.coreOperations;
  const coreOperations = Array.isArray(rawCoreOps) ? (rawCoreOps as string[]) : [];
  const coreOpsIsRef = isStateRef(rawCoreOps);

  const discoveryStepId = typeof r.discoveryStepId === 'string' ? r.discoveryStepId : undefined;
  const format = typeof r.format === 'string' ? r.format : undefined;
  return { stepTypes, stepTypesIsRef, coreOperations, coreOpsIsRef, discoveryStepId, format };
}

export function CatalogToolSelector({ value, onChange, operations }: CatalogToolSelectorProps) {
  const catalogRaw = value as CatalogConfigRecord;
  const config = extractConfig(value);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const toggleExpanded = (stepType: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(stepType)) {
        next.delete(stepType);
      } else {
        next.add(stepType);
      }
      return next;
    });
  };

  // Filter operations by selected step types.
  // When stepTypes is a state ref, show all operations (the actual scope is resolved at runtime).
  const scopeOps = useMemo(() => {
    if (config.stepTypesIsRef) {
      // State ref — can't resolve at edit time. Show all agent-visible operations
      // so the author can pick core tools from any step type.
      return operations.filter((op) => (op.operationId as string) !== 'ai.agent.turn');
    }
    if (config.stepTypes.length === 0) return [];
    const allowed = new Set(config.stepTypes);
    return operations.filter(
      (op) => allowed.has(op.stepType) && (op.operationId as string) !== 'ai.agent.turn',
    );
  }, [operations, config.stepTypes, config.stepTypesIsRef]);

  // Group scope ops by step type
  const grouped = useMemo(() => {
    const map = new Map<string, CatalogOperation[]>();
    for (const op of scopeOps) {
      const list = map.get(op.stepType) ?? [];
      list.push(op);
      map.set(op.stepType, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [scopeOps]);

  // Filter by search
  const filteredGrouped = useMemo(() => {
    if (!search) return grouped;
    const q = search.toLowerCase();
    return grouped
      .map(
        ([st, ops]) =>
          [
            st,
            ops.filter(
              (op) =>
                op.operationId.toLowerCase().includes(q) ||
                op.displayName.toLowerCase().includes(q),
            ),
          ] as [string, CatalogOperation[]],
      )
      .filter(([, ops]) => ops.length > 0);
  }, [grouped, search]);

  const coreSet = new Set(config.coreOperations);

  const updateConfig = (patch: Partial<Record<string, unknown>>) => {
    // Handle discovery sub-object writes — allowedStepTypes and excludeOperationIds
    // live under discovery.*, so we merge them into the nested object.
    const patchAny = patch as Record<string, unknown>;
    if ('allowedStepTypes' in patchAny || 'excludeOperationIds' in patchAny) {
      const currentDisc = (value as CatalogConfigRecord).discovery ?? {};
      const discPatch: Record<string, unknown> = { ...currentDisc };
      if ('allowedStepTypes' in patchAny) {
        const st = patchAny['allowedStepTypes'];
        if (Array.isArray(st) && (st as unknown[]).length === 0) {
          delete discPatch['allowedStepTypes'];
        } else {
          discPatch['allowedStepTypes'] = st;
        }
        delete patchAny['allowedStepTypes'];
      }
      if ('excludeOperationIds' in patchAny) {
        discPatch['excludeOperationIds'] = patchAny['excludeOperationIds'];
        delete patchAny['excludeOperationIds'];
      }
      // Clean up empty discovery object
      const hasKeys = Object.keys(discPatch).length > 0;
      patchAny['discovery'] = hasKeys ? discPatch : undefined;
    }
    const next = { ...value, ...patch } as CatalogConfigRecord;
    if (Array.isArray(next.coreOperations) && (next.coreOperations as unknown[]).length === 0) {
      delete next.coreOperations;
    }
    // Remove undefined keys
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) delete next[k];
    }
    onChange(next);
  };

  const toggleCoreOp = (opId: string) => {
    const next = coreSet.has(opId)
      ? config.coreOperations.filter((id) => id !== opId)
      : [...config.coreOperations, opId];
    updateConfig({ coreOperations: next });
  };

  const toggleAllForStepType = (stepType: string) => {
    const opsForType = scopeOps
      .filter((op) => op.stepType === stepType)
      .map((op) => op.operationId as string);
    const opsForTypeSet = new Set(opsForType);
    const allSelected = opsForType.every((id) => coreSet.has(id));
    if (allSelected) {
      updateConfig({
        coreOperations: config.coreOperations.filter((id) => !opsForTypeSet.has(id)),
      });
    } else {
      const merged = new Set([...config.coreOperations, ...opsForType]);
      updateConfig({ coreOperations: [...merged] });
    }
  };

  const hasScope = config.stepTypes.length > 0 || config.stepTypesIsRef;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {/* Section 1: Step type scope */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <Text size="xs" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
          Scope (step types)
        </Text>
        <Text variant="muted" style={{ fontSize: '10px' }}>
          Which categories of operations this agent can access
        </Text>
        {config.stepTypesIsRef ? (
          <div>
            <Badge variant="info" style={{ fontSize: '10px' }}>
              <Icon name="link" size="xs" /> Variable:{' '}
              {String(catalogRaw.discovery?.allowedStepTypes)}
            </Badge>
          </div>
        ) : (
          <StepTypeChips
            value={config.stepTypes}
            onChange={(next) => {
              const allowedTypes = new Set(next);
              const filteredCore = config.coreOperations.filter((opId) => {
                const op = operations.find((o) => o.operationId === opId);
                return op && allowedTypes.has(op.stepType);
              });
              updateConfig({ allowedStepTypes: next, coreOperations: filteredCore });
            }}
            compact
          />
        )}
      </div>

      {hasScope && (
        <>
          <Divider />

          {/* Section 2: Core tools — collapsible accordion */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Text size="xs" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
                  Core Tools
                </Text>
                <Badge variant="info" style={{ fontSize: '9px' }}>
                  {String(config.coreOperations.length)} selected
                </Badge>
              </div>
              <Text variant="muted" style={{ fontSize: '10px' }}>
                {String(scopeOps.length)} in scope
              </Text>
            </div>
            <Text variant="muted" style={{ fontSize: '10px' }}>
              Checked = loaded as native tools. Unchecked = available via discover.
            </Text>

            {scopeOps.length > 12 && (
              <Input
                type="search"
                placeholder="Filter operations…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
                style={{ fontSize: 'var(--font-size-xs)' }}
              />
            )}

            {/* Accordion groups — no fixed height, grows naturally */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {filteredGrouped.map(([stepType, ops]) => {
                const selectedCount = ops.filter((op) => coreSet.has(op.operationId)).length;
                const allSelected = selectedCount === ops.length;
                const someSelected = selectedCount > 0 && !allSelected;
                const isExpanded = expandedTypes.has(stepType) || !!search;
                const iconName: IconName = getStepTypeIcon(stepType);
                const color = getStepTypeColor(stepType);

                return (
                  <div
                    key={stepType}
                    style={{
                      border: '1px solid var(--color-border-subtle)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    {/* Collapsible header */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        padding: 'var(--space-2) var(--space-3)',
                        background: someSelected
                          ? 'var(--color-accent-subtle)'
                          : allSelected
                            ? 'var(--color-surface-raised)'
                            : 'var(--color-surface-0)',
                        borderBottom: isExpanded ? '1px solid var(--color-border-subtle)' : 'none',
                        borderRadius: isExpanded
                          ? 'var(--radius-md) var(--radius-md) 0 0'
                          : 'var(--radius-md)',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                      onClick={() => {
                        toggleExpanded(stepType);
                      }}
                    >
                      <Icon
                        name={isExpanded ? 'caret-down' : 'caret-right'}
                        size="xs"
                        style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}
                      />
                      <Icon name={iconName} size="sm" style={{ color, flexShrink: 0 }} />
                      <Text size="xs" style={{ fontWeight: 600, flex: 1 }}>
                        {stepType}
                      </Text>
                      <Text variant="muted" style={{ fontSize: '10px', flexShrink: 0 }}>
                        {String(selectedCount)}/{String(ops.length)}
                      </Text>
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <Checkbox
                          checked={allSelected || someSelected}
                          onChange={() => {
                            toggleAllForStepType(stepType);
                          }}
                          size="sm"
                        />
                      </div>
                    </div>

                    {/* Expanded operation list */}
                    {isExpanded && (
                      <div
                        style={{
                          padding: 'var(--space-1) var(--space-2)',
                          display: 'flex',
                          flexDirection: 'column',
                        }}
                      >
                        {ops.map((op) => {
                          const checked = coreSet.has(op.operationId);
                          return (
                            <label
                              key={op.operationId}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 'var(--space-2)',
                                padding: '4px var(--space-1)',
                                borderRadius: 'var(--radius-sm)',
                                cursor: 'pointer',
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'var(--color-surface-1)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'transparent';
                              }}
                            >
                              <Checkbox
                                checked={checked}
                                onChange={() => {
                                  toggleCoreOp(op.operationId as string);
                                }}
                                size="sm"
                              />
                              <div
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  display: 'flex',
                                  flexDirection: 'column',
                                }}
                              >
                                <Text
                                  size="xs"
                                  style={{
                                    fontWeight: checked ? 600 : 400,
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '11px',
                                  }}
                                >
                                  {op.operationId}
                                </Text>
                                <Text
                                  variant="muted"
                                  style={{
                                    fontSize: '10px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {op.description}
                                </Text>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <Divider />

          {/* Section 3: Discovery toggle */}
          <Checkbox
            checked={!!config.discoveryStepId}
            onChange={(e) => {
              updateConfig({
                discoveryStepId: e.target.checked ? 'discover' : undefined,
              });
            }}
            size="sm"
          >
            <Text size="xs">Enable discovery step</Text>
          </Checkbox>

          {/* Section 4: Advanced settings */}
          <button
            type="button"
            onClick={() => {
              setShowAdvanced((v) => !v);
            }}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              color: 'var(--color-text-muted)',
              fontSize: 'var(--font-size-xs)',
            }}
          >
            <Icon name={showAdvanced ? 'caret-down' : 'caret-right'} size="xs" />
            Advanced settings
          </button>

          {showAdvanced && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                padding: 'var(--space-2)',
                background: 'var(--color-surface-1)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <Text size="xs" style={{ fontWeight: 600 }}>
                  Format override
                </Text>
                <Select
                  value={config.format ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) {
                      updateConfig({ format: v });
                    } else {
                      const { format: _f, ...rest } = value;
                      onChange(rest);
                    }
                  }}
                  style={{ fontSize: 'var(--font-size-xs)' }}
                >
                  <option value="">Auto (recommended)</option>
                  <option value="compact">Compact (~200 tokens)</option>
                  <option value="summary">Summary (~2K tokens)</option>
                  <option value="detailed">Detailed (full schemas)</option>
                  <option value="none">None (no awareness block)</option>
                </Select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <Text size="xs" style={{ fontWeight: 600 }}>
                  Exclude operation IDs
                </Text>
                <Input
                  value={
                    Array.isArray(catalogRaw.discovery?.excludeOperationIds)
                      ? (catalogRaw.discovery.excludeOperationIds as string[]).join(', ')
                      : ''
                  }
                  onChange={(e) => {
                    const ids = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    updateConfig({ excludeOperationIds: ids.length > 0 ? ids : undefined });
                  }}
                  placeholder="e.g., api.http.batch, memory.store.delete"
                  style={{ fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
