'use client';

import { useCallback, useState } from 'react';
import { Column, Row, Text, Select, Input, Button, Tooltip, Icon } from '@aflow/design-system';
import type { StateVariable } from '../../../lib/flow-to-graph.js';
import type { SchemaProperty } from './types.js';
import {
  extractConfigRef,
  varRefLabel,
  fieldTooltip,
  getEnumValues,
  humanizeField,
  inferValueType,
} from './helpers.js';
import { ArrayValueEditor } from './ArrayValueEditor.js';

interface ObjectValueEditorProps {
  schemaProp: SchemaProperty;
  value: Record<string, unknown>;
  variables: StateVariable[];
  onChangeObject: (obj: Record<string, unknown>) => void;
}

export function ObjectValueEditor({
  schemaProp,
  value,
  variables,
  onChangeObject,
}: ObjectValueEditorProps) {
  const obj = value;
  const hasSchema = schemaProp.properties && Object.keys(schemaProp.properties).length > 0;

  const [varPickerKeys, setVarPickerKeys] = useState<Set<string>>(new Set());

  const toggleVarPicker = useCallback((key: string) => {
    setVarPickerKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const hasVars = variables.length > 0;
  const inputVarOptions = variables.filter((v) => v.lifecycle.isInput);

  if (hasSchema) {
    const props = schemaProp.properties ?? {};
    return (
      <Column gap="2">
        {Object.entries(props).map(([key, prop]) => {
          const subSchema = prop;
          const subType = subSchema.type ?? 'string';
          const subVal = obj[key];
          const subStr =
            subVal === undefined || subVal === null
              ? ''
              : typeof subVal === 'object' && subVal !== null
                ? JSON.stringify(subVal)
                : String((subVal ?? '') as string | number | boolean);

          const isSubLinked = typeof subVal === 'string' && extractConfigRef(subVal) != null;
          const showingPicker = varPickerKeys.has(key);

          const updateSub = (v: unknown) => {
            if (v === undefined || v === '') {
              const { [key]: _omit, ...rest } = obj;
              onChangeObject(rest);
            } else {
              onChangeObject({
                ...obj,
                [key]:
                  subType === 'number' || subType === 'integer'
                    ? Number(v)
                    : subType === 'boolean'
                      ? v === 'true'
                      : v,
              });
            }
          };

          const renderSubLinkButton = () => {
            if (!hasVars) return null;
            return (
              <Tooltip content="Use a variable" side="top">
                <button
                  onClick={() => {
                    if (isSubLinked) {
                      updateSub(undefined);
                    } else {
                      toggleVarPicker(key);
                    }
                  }}
                  style={{
                    background: 'none',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    color: isSubLinked ? 'var(--color-info-default)' : 'var(--color-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '3px',
                    flexShrink: 0,
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = 'var(--color-info-default)';
                    e.currentTarget.style.borderColor = 'var(--color-info-default)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = isSubLinked
                      ? 'var(--color-info-default)'
                      : 'var(--color-text-muted)';
                    e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                  }}
                >
                  <Icon name="link" size="xs" weight="bold" />
                </button>
              </Tooltip>
            );
          };

          const renderSubLinkedChip = () => {
            const label = varRefLabel(subStr, variables);
            const prefix = subStr.includes('input.') ? 'input' : 'var';
            return (
              <Row gap="2" align="center" style={{ flex: 1 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 'var(--space-1)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--color-info-muted)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 500,
                    color: 'var(--color-info-default)',
                  }}
                >
                  <Icon name="link" size="xs" weight="bold" />
                  {prefix}: {label}
                </span>
                <Tooltip content="Unlink variable" side="top">
                  <button
                    onClick={() => {
                      updateSub(undefined);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--color-text-muted)',
                      display: 'flex',
                      padding: 2,
                    }}
                  >
                    <Icon name="x" size="xs" />
                  </button>
                </Tooltip>
              </Row>
            );
          };

          const renderSubVarPicker = () => (
            <Row gap="2" align="center" style={{ flex: 1 }}>
              <Select
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    updateSub(`\${${e.target.value}}`);
                    toggleVarPicker(key);
                  }
                }}
                style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
                autoFocus
              >
                <option value="">— pick a variable —</option>
                {inputVarOptions.length > 0 && (
                  <optgroup label="Flow inputs">
                    {inputVarOptions.map((v) => (
                      <option key={`in-${v.variableId}`} value={`input.${v.variableId}`}>
                        {v.name || v.variableId}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Variables">
                  {variables.map((v) => (
                    <option key={v.variableId} value={`state.${v.variableId}`}>
                      {v.name || v.variableId}
                    </option>
                  ))}
                </optgroup>
              </Select>
              <button
                onClick={() => {
                  toggleVarPicker(key);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--color-text-muted)',
                  display: 'flex',
                  padding: 2,
                }}
              >
                <Icon name="x" size="xs" />
              </button>
            </Row>
          );

          return (
            <div
              key={key}
              style={{
                padding: 'var(--space-1) var(--space-2)',
                background: 'var(--color-surface-1)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              <Row gap="2" align="center" style={{ marginBottom: 'var(--space-1)' }}>
                <Text size="xs" style={{ fontWeight: 600, minWidth: 80 }}>
                  {humanizeField(key)}
                </Text>
                <Tooltip content={fieldTooltip(subSchema)} side="top" delayMs={200}>
                  <button
                    type="button"
                    aria-label="Info"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'help',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    <Icon name="info" size="xs" />
                  </button>
                </Tooltip>
              </Row>
              {isSubLinked ? (
                <Row gap="2" align="center">
                  {renderSubLinkedChip()}
                </Row>
              ) : showingPicker ? (
                renderSubVarPicker()
              ) : (
                <Row gap="2" align="center">
                  {subType === 'boolean' ? (
                    <Select
                      value={typeof subVal === 'boolean' ? String(subVal) : ''}
                      onChange={(e) => {
                        updateSub(e.target.value || undefined);
                      }}
                      style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
                    >
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    (() => {
                      const subEnum = getEnumValues(subSchema);
                      if (subEnum?.length) {
                        return (
                          <Select
                            value={
                              subVal !== undefined && subVal !== null
                                ? typeof subVal === 'object'
                                  ? JSON.stringify(subVal)
                                  : String(subVal as string | number | boolean)
                                : ''
                            }
                            onChange={(e) => {
                              updateSub(e.target.value || undefined);
                            }}
                            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
                          >
                            <option value="">—</option>
                            {subEnum.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </Select>
                        );
                      }
                      if (subType === 'number' || subType === 'integer') {
                        return (
                          <Input
                            type="number"
                            value={typeof subVal === 'number' ? subVal : subStr}
                            onChange={(e) => {
                              updateSub(e.target.value);
                            }}
                            placeholder="0"
                            style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
                          />
                        );
                      }
                      if (subType === 'object' && subSchema.properties) {
                        return (
                          <ObjectValueEditor
                            schemaProp={subSchema}
                            value={
                              typeof subVal === 'object' &&
                              subVal !== null &&
                              !Array.isArray(subVal)
                                ? (subVal as Record<string, unknown>)
                                : {}
                            }
                            variables={variables}
                            onChangeObject={(next) => {
                              updateSub(Object.keys(next).length > 0 ? next : undefined);
                            }}
                          />
                        );
                      }
                      if (subType === 'array') {
                        const arrVal = Array.isArray(subVal) ? (subVal as unknown[]) : [];
                        return (
                          <ArrayValueEditor
                            schemaProp={subSchema}
                            value={arrVal}
                            onChange={(next) => {
                              updateSub(
                                Array.isArray(next) && (next as unknown[]).length > 0
                                  ? next
                                  : undefined,
                              );
                            }}
                          />
                        );
                      }
                      if (subType === 'object') {
                        return (
                          <Input
                            value={subStr}
                            onChange={(e) => {
                              try {
                                const parsed = JSON.parse(e.target.value || '{}') as unknown;
                                updateSub(
                                  typeof parsed === 'object' && parsed !== null
                                    ? parsed
                                    : undefined,
                                );
                              } catch {
                                updateSub(e.target.value);
                              }
                            }}
                            placeholder="{}"
                            style={{
                              flex: 1,
                              fontSize: 'var(--font-size-xs)',
                              fontFamily: 'var(--font-mono)',
                            }}
                          />
                        );
                      }
                      return (
                        <Input
                          value={subStr}
                          onChange={(e) => {
                            updateSub(e.target.value);
                          }}
                          placeholder={`${humanizeField(key)}…`}
                          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
                        />
                      );
                    })()
                  )}
                  {renderSubLinkButton()}
                </Row>
              )}
            </div>
          );
        })}
      </Column>
    );
  }

  // Free-form: key/value pairs
  const entries = Object.entries(obj);
  const [newKey, setNewKey] = useState('');

  const addEntry = () => {
    if (!newKey.trim()) return;
    const k = newKey.trim();
    if (k in obj) return;
    onChangeObject({ ...obj, [k]: '' });
    setNewKey('');
  };

  const removeEntry = (k: string) => {
    const { [k]: _omit, ...rest } = obj;
    onChangeObject(rest);
  };

  const updateEntry = (k: string, val: unknown) => {
    onChangeObject({ ...obj, [k]: val });
  };

  return (
    <Column gap="2">
      {entries.map(([k, v]) => (
        <ObjectEntryRow
          key={k}
          entryKey={k}
          entryValue={v}
          variables={variables}
          onUpdate={(val) => {
            updateEntry(k, val);
          }}
          onRemove={() => {
            removeEntry(k);
          }}
        />
      ))}
      <Row gap="2" align="center">
        <Input
          value={newKey}
          onChange={(e) => {
            setNewKey(e.target.value);
          }}
          placeholder="Key name"
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addEntry();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={addEntry}
          leftIcon={<Icon name="plus" size="xs" />}
          disabled={!newKey.trim()}
        >
          Add
        </Button>
      </Row>
    </Column>
  );
}

interface ObjectEntryRowProps {
  entryKey: string;
  entryValue: unknown;
  variables: StateVariable[];
  onUpdate: (val: unknown) => void;
  onRemove: () => void;
}

function ObjectEntryRow({
  entryKey,
  entryValue,
  variables,
  onUpdate,
  onRemove,
}: ObjectEntryRowProps) {
  const type = inferValueType(entryValue);
  const strVal =
    entryValue === undefined || entryValue === null
      ? ''
      : typeof entryValue === 'object' && entryValue !== null
        ? JSON.stringify(entryValue)
        : String((entryValue ?? '') as string | number | boolean);

  const [showVarPicker, setShowVarPicker] = useState(false);
  const hasVars = variables.length > 0;
  const inputVarOptions = variables.filter((v) => v.lifecycle.isInput);

  if (type === 'variable' && !showVarPicker) {
    const label = varRefLabel(strVal, variables);
    const prefix = strVal.includes('input.') ? 'input' : 'var';
    return (
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'center',
          padding: 'var(--space-1) var(--space-2)',
          background: 'var(--color-info-muted)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-info-subtle)',
        }}
      >
        <Text size="xs" style={{ fontWeight: 600, minWidth: 60 }}>
          {entryKey}
        </Text>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: '2px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-info-muted)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 500,
            color: 'var(--color-info-default)',
            flex: 1,
          }}
        >
          <Icon name="link" size="xs" weight="bold" />
          {prefix}: {label}
        </span>
        <Tooltip content="Unlink variable" side="top">
          <button
            onClick={() => {
              onUpdate('');
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-text-muted)',
              display: 'flex',
              padding: 2,
            }}
          >
            <Icon name="x" size="xs" />
          </button>
        </Tooltip>
        <button
          onClick={onRemove}
          aria-label="Remove"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            padding: 2,
          }}
        >
          <Icon name="x" size="xs" />
        </button>
      </div>
    );
  }

  if (showVarPicker) {
    return (
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'center',
          padding: 'var(--space-1) var(--space-2)',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        <Text size="xs" style={{ fontWeight: 600, minWidth: 60 }}>
          {entryKey}
        </Text>
        <Select
          value=""
          onChange={(e) => {
            if (e.target.value) {
              onUpdate(`\${${e.target.value}}`);
              setShowVarPicker(false);
            }
          }}
          style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
          autoFocus
        >
          <option value="">— pick a variable —</option>
          {inputVarOptions.length > 0 && (
            <optgroup label="Flow inputs">
              {inputVarOptions.map((v) => (
                <option key={`in-${v.variableId}`} value={`input.${v.variableId}`}>
                  {v.name || v.variableId}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Variables">
            {variables.map((v) => (
              <option key={v.variableId} value={`state.${v.variableId}`}>
                {v.name || v.variableId}
              </option>
            ))}
          </optgroup>
        </Select>
        <button
          onClick={() => {
            setShowVarPicker(false);
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-text-muted)',
            display: 'flex',
            padding: 2,
          }}
        >
          <Icon name="x" size="xs" />
        </button>
      </div>
    );
  }

  const valueInput =
    type === 'boolean' ? (
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
    ) : (
      <Input
        value={strVal}
        onChange={(e) => {
          const v = e.target.value;
          const converted = type === 'number' ? (v ? Number(v) : 0) : v;
          onUpdate(converted);
        }}
        type={type === 'number' ? 'number' : 'text'}
        placeholder="Value"
        style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
      />
    );

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-2)',
        alignItems: 'center',
        padding: 'var(--space-1) var(--space-2)',
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      <Text size="xs" style={{ fontWeight: 600, minWidth: 60 }}>
        {entryKey}
      </Text>
      <Select
        value={type}
        onChange={(e) => {
          const t = e.target.value as 'string' | 'number' | 'boolean' | 'variable';
          if (t === 'variable') {
            setShowVarPicker(true);
            return;
          }
          const converted =
            t === 'number'
              ? strVal
                ? Number(strVal)
                : 0
              : t === 'boolean'
                ? strVal === 'true'
                : strVal;
          onUpdate(converted);
        }}
        style={{ width: 80, fontSize: 'var(--font-size-xs)', flexShrink: 0 }}
      >
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
        {hasVars && <option value="variable">variable</option>}
      </Select>
      {valueInput}
      <button
        onClick={onRemove}
        aria-label="Remove"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          padding: 2,
        }}
      >
        <Icon name="x" size="xs" />
      </button>
    </div>
  );
}
