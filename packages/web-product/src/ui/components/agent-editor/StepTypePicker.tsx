'use client';

import { useState } from 'react';
import { Column, Row, Text, Input, Button, Icon, Dialog, Divider } from '@aflow/design-system';
import type { StepType, OperationId } from '@aflow/schemas';
import type { CatalogOperation, CatalogStepType } from '../../hooks/use-operation-catalog.js';
import type { IconName } from '@aflow/design-system';
import { getStepTypeIcon } from '../CatalogPickers.js';

interface StepTypePickerProps {
  stepTypes: CatalogStepType[];
  operations: CatalogOperation[];
  onSelect: (stepType: StepType, operationId: OperationId, name: string) => void;
  onClose: () => void;
}

export function StepTypePicker({ stepTypes, operations, onSelect, onClose }: StepTypePickerProps) {
  const [search, setSearch] = useState('');
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const filteredTypes = stepTypes.filter(
    (st) => !search || st.displayName.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredOps = selectedType
    ? operations.filter(
        (op) =>
          op.stepType === selectedType &&
          (!search ||
            op.displayName.toLowerCase().includes(search.toLowerCase()) ||
            op.operationId.toLowerCase().includes(search.toLowerCase())),
      )
    : [];

  return (
    <Dialog open onClose={onClose} title="Add Step">
      <div
        style={{
          minWidth: 'min(400px, 100%)',
          maxWidth: 520,
          maxHeight: '70dvh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: 'var(--space-3)' }}>
          <Input
            type="search"
            placeholder="Search step types or operations..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
            autoFocus
          />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 var(--space-3) var(--space-3)' }}>
          {!selectedType ? (
            // Step type grid
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 'var(--space-2)',
              }}
            >
              {filteredTypes.map((st) => {
                const iconName: IconName = getStepTypeIcon(st.type);
                const opCount = operations.filter((o) => o.stepType === st.type).length;
                return (
                  <button
                    key={st.type}
                    onClick={() => {
                      setSelectedType(st.type);
                    }}
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      padding: 'var(--space-3)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--color-border-subtle)',
                      background: 'var(--color-surface-0)',
                      transition: 'border-color 150ms, background 150ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-interactive-default)';
                      e.currentTarget.style.background = 'var(--color-surface-1)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                      e.currentTarget.style.background = 'var(--color-surface-0)';
                    }}
                  >
                    <Column gap="2">
                      <Row gap="2" align="center">
                        <Icon name={iconName} size="md" />
                        <Text size="sm" style={{ fontWeight: 600 }}>
                          {st.displayName}
                        </Text>
                      </Row>
                      <Text variant="muted" size="xs" style={{ lineHeight: 1.4 }}>
                        {st.description}
                      </Text>
                      <Text variant="muted" size="xs">
                        {opCount} operation{opCount !== 1 ? 's' : ''}
                      </Text>
                    </Column>
                  </button>
                );
              })}
            </div>
          ) : (
            // Operation list for selected type
            <Column gap="2">
              <Row gap="2" align="center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedType(null);
                  }}
                >
                  &larr; Back
                </Button>
                <Text size="sm" style={{ fontWeight: 600 }}>
                  {stepTypes.find((st) => st.type === selectedType)?.displayName ?? selectedType}
                </Text>
              </Row>
              <Divider />
              {filteredOps.length === 0 ? (
                <Text
                  variant="muted"
                  size="sm"
                  style={{ padding: 'var(--space-4)', textAlign: 'center' }}
                >
                  No operations found
                </Text>
              ) : (
                filteredOps.map((op) => (
                  <button
                    key={op.operationId}
                    onClick={() => {
                      onSelect(op.stepType, op.operationId, op.displayName);
                    }}
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      padding: 'var(--space-3)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--color-border-subtle)',
                      background: 'var(--color-surface-0)',
                      transition: 'border-color 150ms, background 150ms',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-interactive-default)';
                      e.currentTarget.style.background = 'var(--color-surface-1)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                      e.currentTarget.style.background = 'var(--color-surface-0)';
                    }}
                  >
                    <Column gap="1">
                      <Text size="sm" style={{ fontWeight: 500 }}>
                        {op.displayName}
                      </Text>
                      <Text
                        variant="mono"
                        size="xs"
                        color="muted"
                        style={{ fontFamily: 'var(--font-mono)' }}
                      >
                        {op.operationId}
                      </Text>
                      <Text variant="muted" size="xs" style={{ lineHeight: 1.4 }}>
                        {op.description}
                      </Text>
                    </Column>
                  </button>
                ))
              )}
            </Column>
          )}
        </div>
      </div>
    </Dialog>
  );
}
