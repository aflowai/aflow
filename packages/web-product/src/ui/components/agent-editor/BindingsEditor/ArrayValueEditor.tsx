'use client';

import { useCallback } from 'react';
import { Column, Text, Select, Input, Button, Row, Icon } from '@aflow/design-system';
import type { SchemaProperty } from './types.js';
import { getItemsSchema, getEnumValues } from './helpers.js';
import { ObjectValueEditor } from './ObjectValueEditor.js';

interface ArrayValueEditorProps {
  schemaProp: SchemaProperty;
  value: unknown[];
  onChange: (value: unknown) => void;
}

export function ArrayValueEditor({ schemaProp, value, onChange }: ArrayValueEditorProps) {
  const arr = value;
  const itemsSchema = getItemsSchema(schemaProp);
  const itemType = itemsSchema?.type ?? 'string';
  const itemEnum = itemsSchema ? getEnumValues(itemsSchema) : null;

  const handleChange = useCallback(
    (next: unknown[]) => {
      if (next.length === 0) {
        onChange('');
      } else {
        onChange(next);
      }
    },
    [onChange],
  );

  const addEntry = () => {
    const defaultValue =
      itemType === 'number' || itemType === 'integer'
        ? 0
        : itemType === 'boolean'
          ? false
          : (itemEnum?.[0] ?? '');
    handleChange([...arr, defaultValue]);
  };

  const removeEntry = (index: number) => {
    handleChange(arr.filter((_, i) => i !== index));
  };

  const updateEntry = (index: number, val: unknown) => {
    const next = [...arr];
    next[index] = val;
    handleChange(next);
  };

  return (
    <Column gap="2">
      {arr.map((item, i) => (
        <ArrayEntryRow
          key={i}
          index={i}
          item={item}
          itemType={itemType}
          itemEnum={itemEnum}
          itemsSchema={itemsSchema}
          onUpdate={(val) => {
            updateEntry(i, val);
          }}
          onRemove={() => {
            removeEntry(i);
          }}
        />
      ))}
      <Button
        variant="secondary"
        size="sm"
        onClick={addEntry}
        leftIcon={<Icon name="plus" size="xs" />}
      >
        Add item
      </Button>
    </Column>
  );
}

interface ArrayEntryRowProps {
  index: number;
  item: unknown;
  itemType: string;
  itemEnum: string[] | null;
  itemsSchema: SchemaProperty | undefined;
  onUpdate: (val: unknown) => void;
  onRemove: () => void;
}

function ArrayEntryRow({
  index,
  item,
  itemType,
  itemEnum,
  itemsSchema,
  onUpdate,
  onRemove,
}: ArrayEntryRowProps) {
  const strVal =
    item === undefined || item === null
      ? ''
      : typeof item === 'object' && item !== null
        ? JSON.stringify(item)
        : String((item ?? '') as string | number | boolean);

  const rowStyle = {
    display: 'flex',
    gap: 'var(--space-2)',
    alignItems: 'center',
    padding: 'var(--space-1) var(--space-2)',
    background: 'var(--color-surface-1)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border-subtle)',
  } as const;

  const removeButtonStyle = {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 2,
  } as const;

  if (itemEnum?.length) {
    return (
      <div style={rowStyle}>
        <Text size="xs" style={{ fontWeight: 600, minWidth: 24 }}>
          #{index + 1}
        </Text>
        <Select
          value={strVal}
          onChange={(e) => {
            onUpdate(e.target.value);
          }}
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
        >
          <option value="">—</option>
          {itemEnum.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
        <button onClick={onRemove} aria-label="Remove" style={removeButtonStyle}>
          <Icon name="x" size="xs" />
        </button>
      </div>
    );
  }

  if (itemType === 'boolean') {
    return (
      <div style={rowStyle}>
        <Text size="xs" style={{ fontWeight: 600, minWidth: 24 }}>
          #{index + 1}
        </Text>
        <Select
          value={strVal}
          onChange={(e) => {
            onUpdate(e.target.value === 'true');
          }}
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </Select>
        <button onClick={onRemove} aria-label="Remove" style={removeButtonStyle}>
          <Icon name="x" size="xs" />
        </button>
      </div>
    );
  }

  if (itemType === 'number' || itemType === 'integer') {
    return (
      <div style={rowStyle}>
        <Text size="xs" style={{ fontWeight: 600, minWidth: 24 }}>
          #{index + 1}
        </Text>
        <Input
          type="number"
          value={typeof item === 'number' ? item : strVal}
          onChange={(e) => {
            onUpdate(e.target.value ? Number(e.target.value) : 0);
          }}
          placeholder="0"
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
        />
        <button onClick={onRemove} aria-label="Remove" style={removeButtonStyle}>
          <Icon name="x" size="xs" />
        </button>
      </div>
    );
  }

  if (itemType === 'object' && itemsSchema?.properties) {
    return (
      <div
        style={{
          padding: 'var(--space-2)',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        <Row justify="between" align="center" style={{ marginBottom: 'var(--space-1)' }}>
          <Text size="xs" style={{ fontWeight: 600 }}>
            #{index + 1}
          </Text>
          <button onClick={onRemove} aria-label="Remove" style={removeButtonStyle}>
            <Icon name="x" size="xs" />
          </button>
        </Row>
        <ObjectValueEditor
          schemaProp={itemsSchema}
          value={
            typeof item === 'object' && item !== null && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : {}
          }
          variables={[]}
          onChangeObject={(next) => {
            onUpdate(Object.keys(next).length > 0 ? next : {});
          }}
        />
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      <Text size="xs" style={{ fontWeight: 600, minWidth: 24 }}>
        #{index + 1}
      </Text>
      <Input
        value={strVal}
        onChange={(e) => {
          onUpdate(e.target.value);
        }}
        placeholder="Item value"
        style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
      />
      <button onClick={onRemove} aria-label="Remove" style={removeButtonStyle}>
        <Icon name="x" size="xs" />
      </button>
    </div>
  );
}
