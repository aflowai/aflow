'use client';

import { Column, Row, Text, Select, Badge, Tooltip, Icon } from '@aflow/design-system';
import type { StateVariable } from '../../../lib/flow-to-graph.js';
import { humanizeField } from './helpers.js';

interface OutputBindingRowProps {
  field: string;
  description?: string | undefined;
  fieldType?: string | undefined;
  value: string;
  variables: StateVariable[];
  onChange: (value: string) => void;
}

export function OutputBindingRow({
  field,
  description,
  fieldType,
  value,
  variables,
  onChange,
}: OutputBindingRowProps) {
  const isSet = Boolean(value);

  return (
    <div
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: isSet
          ? '1px solid var(--color-border-default)'
          : '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-raised)',
        opacity: isSet ? 1 : 0.85,
        transition: 'border-color 0.15s, background 0.15s, opacity 0.15s',
      }}
    >
      <Column gap="2">
        <Row justify="between" align="center">
          <Row gap="2" align="center">
            <Text size="sm" style={{ fontWeight: 700, color: 'var(--color-content-primary)' }}>
              {humanizeField(field)}
            </Text>
            {fieldType && (
              <Badge variant="neutral" style={{ fontSize: '9px' }}>
                {fieldType}
              </Badge>
            )}
            {description && (
              <Tooltip content={description} side="top">
                <Icon
                  name="info"
                  size="xs"
                  style={{ color: 'var(--color-content-muted)', cursor: 'help', flexShrink: 0 }}
                />
              </Tooltip>
            )}
          </Row>
          {isSet && (
            <Icon
              name="check-circle"
              size="sm"
              weight="fill"
              style={{ color: 'var(--color-success-default)' }}
            />
          )}
        </Row>
        <Row gap="2" align="center">
          <Text variant="muted" size="xs" style={{ whiteSpace: 'nowrap', minWidth: 64 }}>
            saves to
          </Text>
          {variables.length > 0 ? (
            <Select
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
              }}
              style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
            >
              <option value="">-- don&apos;t save --</option>
              {variables.map((v) => (
                <option key={v.variableId} value={`state.${v.variableId}`}>
                  {v.name || v.variableId}
                </option>
              ))}
            </Select>
          ) : (
            <Text variant="muted" size="xs" style={{ fontStyle: 'italic' }}>
              Add a variable first
            </Text>
          )}
        </Row>
      </Column>
    </div>
  );
}
