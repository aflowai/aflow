'use client';

/**
 * StateViewer — aggregates runtimeStatePatch entries across all events
 * to build and display the latest state variable values.
 *
 * Groups variables into user-facing vs internal (ai.*, chat.*, flow.*, _*).
 * Internal variables are collapsed by default.
 */

import { useState, useMemo } from 'react';
import { Text, Column, Badge, JsonViewer, Icon } from '@aflow/design-system';
import type { SessionEvent } from '../lib/types.js';

// =============================================================================
// Types
// =============================================================================

interface StateVariable {
  key: string;
  value: unknown;
  version: number;
  updatedAtMs: number;
  updatedBy?: {
    stepExecutionId?: string | undefined;
    stepId?: string | undefined;
    actor?: string | undefined;
  };
  semanticType?: string | undefined;
  /** If the value is stored in PayloadStore (kind: 'ref'), the reference path */
  payloadRef?: string | undefined;
}

interface StateViewerProps {
  events: SessionEvent[];
}

// =============================================================================
// Helpers
// =============================================================================

const INTERNAL_PREFIXES = ['ai.', 'chat.', 'flow.', '_'];

function isInternal(key: string): boolean {
  return INTERNAL_PREFIXES.some((p) => key.startsWith(p));
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Extract display-friendly value from a state variable entry.
 * The entry could be a RuntimeStateValue with `ref` or a raw value.
 */
type StateVariableMeta = {
  [K in keyof StateVariable]?: StateVariable[K] | undefined;
};

function extractValue(entry: unknown): { displayValue: unknown; meta: StateVariableMeta } {
  if (entry == null) return { displayValue: undefined, meta: {} };

  // Check if it's a full RuntimeStateValue shape
  const typed = entry as Record<string, unknown>;
  if (typed['ref'] && typeof typed['ref'] === 'object') {
    const ref = typed['ref'] as Record<string, unknown>;
    const meta: StateVariableMeta = {
      version: (typed['version'] as number | undefined) ?? 0,
      updatedAtMs: (typed['updatedAtMs'] as number | undefined) ?? 0,
      ...(typed['updatedBy'] !== undefined
        ? { updatedBy: typed['updatedBy'] as StateVariable['updatedBy'] }
        : {}),
    };

    if (ref['kind'] === 'inline') {
      return { displayValue: ref['value'], meta };
    }
    if (ref['kind'] === 'ref') {
      const preview = ref['preview'] as Record<string, unknown> | undefined;
      // Prefer JSON preview (structured), fall back to text preview, then show ref link
      let displayValue: unknown;
      if (preview?.['json'] !== undefined) {
        displayValue = preview['json'];
      } else if (typeof preview?.['text'] === 'string') {
        displayValue = preview['text'];
      } else {
        displayValue = `[stored: ${ref['payloadRef'] as string}]`;
      }
      return {
        displayValue,
        meta: { ...meta, payloadRef: ref['payloadRef'] as string | undefined },
      };
    }
    return { displayValue: ref, meta };
  }

  // Raw value
  return { displayValue: entry, meta: {} };
}

// =============================================================================
// Component
// =============================================================================

export function StateViewer({ events }: StateViewerProps) {
  const [showInternal, setShowInternal] = useState(false);

  // Build latest state by iterating events and applying patches
  const variables = useMemo(() => {
    const stateMap = new Map<string, StateVariable>();

    for (const event of events) {
      const patch = event.data?.runtimeStatePatch;
      if (!patch?.changed) continue;

      for (const change of patch.changed) {
        const { displayValue, meta } = extractValue(change.value);
        stateMap.set(change.key, {
          key: change.key,
          value: displayValue,
          version: meta.version ?? (stateMap.get(change.key)?.version ?? 0) + 1,
          updatedAtMs: meta.updatedAtMs ?? new Date(event.timestamp).getTime(),
          ...(meta.updatedBy !== undefined ? { updatedBy: meta.updatedBy } : {}),
          semanticType: meta.semanticType,
          payloadRef: meta.payloadRef,
        });
      }
    }

    return Array.from(stateMap.values());
  }, [events]);

  const userVars = variables.filter((v) => !isInternal(v.key));
  const internalVars = variables.filter((v) => isInternal(v.key));

  if (variables.length === 0) {
    return (
      <Text variant="muted" size="sm">
        No state variables set yet.
      </Text>
    );
  }

  return (
    <Column gap="3">
      {/* User-facing variables */}
      {userVars.length > 0 && (
        <div>
          <Text
            variant="label"
            size="sm"
            style={{ marginBottom: 'var(--space-2)', display: 'block' }}
          >
            Variables ({userVars.length})
          </Text>
          <Column gap="1">
            {userVars.map((v) => (
              <StateVariableRow key={v.key} variable={v} />
            ))}
          </Column>
        </div>
      )}

      {/* Internal variables (collapsed by default) */}
      {internalVars.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => {
              setShowInternal((s) => !s);
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '0',
              marginBottom: 'var(--space-2)',
            }}
          >
            <Icon
              name={showInternal ? 'caret-down' : 'caret-right'}
              size="sm"
              color="var(--color-text-muted)"
            />
            <Text variant="muted" size="sm">
              Internal variables ({internalVars.length})
            </Text>
            <Icon name="eye-slash" size="sm" color="var(--color-text-muted)" />
          </button>
          {showInternal && (
            <Column gap="1">
              {internalVars.map((v) => (
                <StateVariableRow key={v.key} variable={v} />
              ))}
            </Column>
          )}
        </div>
      )}
    </Column>
  );
}

// =============================================================================
// Variable row
// =============================================================================

function StateVariableRow({ variable }: { variable: StateVariable }) {
  const [expanded, setExpanded] = useState(false);
  const isComplex = typeof variable.value === 'object' && variable.value !== null;

  return (
    <div
      style={{
        background: 'var(--color-bg-secondary)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-2)',
        fontSize: 'var(--font-size-sm)',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          cursor: isComplex ? 'pointer' : 'default',
        }}
        onClick={
          isComplex
            ? () => {
                setExpanded((e) => !e);
              }
            : undefined
        }
      >
        {isComplex && (
          <Icon
            name={expanded ? 'caret-down' : 'caret-right'}
            size="xs"
            color="var(--color-text-muted)"
          />
        )}

        <Text weight="medium" size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
          {variable.key}
        </Text>

        {variable.semanticType && <Badge variant="neutral">{variable.semanticType}</Badge>}

        {variable.payloadRef && <Badge variant="info">stored</Badge>}

        <span style={{ flex: 1 }} />

        {variable.updatedAtMs > 0 && (
          <Text variant="muted" size="xs">
            {formatTimestamp(variable.updatedAtMs)}
          </Text>
        )}

        <Text variant="muted" size="xs">
          v{variable.version}
        </Text>
      </div>

      {/* Value display */}
      <div style={{ marginTop: 'var(--space-1)', paddingLeft: isComplex ? '20px' : '0' }}>
        {isComplex ? (
          expanded ? (
            <JsonViewer data={variable.value} collapseDepth={2} />
          ) : (
            <Text variant="muted" size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
              {summarizeValue(variable.value)}
            </Text>
          )
        ) : (
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)', wordBreak: 'break-all' }}>
            {formatSimpleValue(variable.value)}
          </Text>
        )}
      </div>

      {/* Updated by */}
      {expanded && variable.updatedBy?.stepId && (
        <div style={{ marginTop: 'var(--space-1)', paddingLeft: '20px' }}>
          <Text variant="muted" size="xs">
            Updated by: {variable.updatedBy.stepId}
            {variable.updatedBy.actor ? ` (${variable.updatedBy.actor})` : ''}
          </Text>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Formatting helpers
// =============================================================================

function formatSimpleValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 200 ? `"${value.slice(0, 200)}..."` : `"${value}"`;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length <= 3) {
      return `{ ${keys.join(', ')} }`;
    }
    return `{ ${keys.slice(0, 3).join(', ')}, ... } (${keys.length} keys)`;
  }
  return formatSimpleValue(value);
}
