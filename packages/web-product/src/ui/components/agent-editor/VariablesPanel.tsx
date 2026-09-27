'use client';

import { useState } from 'react';
import {
  Column,
  Row,
  Text,
  Heading,
  Button,
  IconButton,
  Badge,
  Input,
  Select,
  Textarea,
  Icon,
  Divider,
  Dialog,
  Field,
  Label,
  Checkbox,
} from '@aflow/design-system';
import type { StateVariable } from '../../lib/flow-to-graph.js';

// ---------------------------------------------------------------------------
// Semantic type options (with friendly labels)
// ---------------------------------------------------------------------------

const SEMANTIC_TYPES: Array<{ value: string; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'code', label: 'Code' },
  { value: 'json', label: 'JSON / Object' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'list', label: 'List' },
  { value: 'keyvalue', label: 'Key-Value pairs' },
  { value: 'url', label: 'URL' },
  { value: 'html', label: 'HTML' },
  { value: 'datetime', label: 'Date / Time' },
  { value: 'image', label: 'Image' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'file', label: 'File' },
  { value: 'table', label: 'Table' },
  { value: 'chart', label: 'Chart' },
  { value: 'progress', label: 'Progress' },
  { value: 'status', label: 'Status' },
  { value: 'custom', label: 'Custom' },
];

function typeLabel(value: string): string {
  return SEMANTIC_TYPES.find((t) => t.value === value)?.label ?? value;
}

/** Derive the JSON Schema typeSchema from a semanticType. */
function semanticTypeToSchema(
  semanticType: string,
  enumValues?: string[],
): Record<string, unknown> {
  const base = (() => {
    switch (semanticType) {
      case 'number':
        return { type: 'number' as const };
      case 'boolean':
        return { type: 'boolean' as const };
      case 'json':
      case 'keyvalue':
        return { type: 'object' as const };
      case 'list':
      case 'table':
        return { type: 'array' as const };
      default:
        return { type: 'string' as const };
    }
  })();
  if (enumValues && enumValues.length > 0 && base.type === 'string') {
    return { ...base, enum: enumValues };
  }
  return base;
}

/** Extract enum values from a typeSchema if present. */
function extractEnumFromSchema(typeSchema: Record<string, unknown>): string[] {
  const e = typeSchema['enum'];
  return Array.isArray(e) ? e.map(String) : [];
}

// ---------------------------------------------------------------------------
// Object property types
// ---------------------------------------------------------------------------

const PROPERTY_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'] as const;

interface ObjectProperty {
  key: string;
  type: string;
  description: string;
  required: boolean;
}

/** Extract properties from a typeSchema if it's an object with defined properties. */
function extractObjectProperties(typeSchema: Record<string, unknown>): ObjectProperty[] {
  if (typeSchema['type'] !== 'object') return [];
  const props = typeSchema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props) return [];
  const requiredSet = new Set(
    Array.isArray(typeSchema['required']) ? (typeSchema['required'] as string[]) : [],
  );
  return Object.entries(props).map(([key, schema]) => ({
    key,
    type: typeof schema['type'] === 'string' ? schema['type'] : 'string',
    description: typeof schema['description'] === 'string' ? schema['description'] : '',
    required: requiredSet.has(key),
  }));
}

/** Build a typeSchema from object properties. */
function objectPropertiesToSchema(properties: ObjectProperty[]): Record<string, unknown> {
  if (properties.length === 0) return { type: 'object' as const };
  const props: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const p of properties) {
    const fieldSchema: Record<string, unknown> = { type: p.type };
    if (p.description) fieldSchema['description'] = p.description;
    props[p.key] = fieldSchema;
    if (p.required) required.push(p.key);
  }
  return {
    type: 'object' as const,
    properties: props,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VariablesPanelProps {
  variables: StateVariable[];
  steps: Array<{
    stepId: string;
    name?: string | undefined;
    config?: Record<string, unknown> | undefined;
    outputMapping?: Record<string, string> | undefined;
  }>;
  onAdd: (variable: StateVariable) => void;
  onRemove: (variableId: string) => void;
  onUpdate: (variableId: string, patch: Partial<StateVariable>) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VariablesPanel({
  variables,
  steps,
  onAdd,
  onRemove,
  onUpdate,
}: VariablesPanelProps) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingVar, setEditingVar] = useState<string | null>(null);

  const usedByMap = buildUsedByMap(variables, steps);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: 'var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <Row justify="between" align="center">
          <Heading level={6}>Variables</Heading>
          <IconButton
            icon={<Icon name="plus" size="sm" />}
            size="sm"
            variant="ghost"
            aria-label="Add variable"
            onClick={() => {
              setShowAddDialog(true);
            }}
          />
        </Row>
      </div>

      {/* Variable list */}
      <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-2)' }}>
        {variables.length === 0 ? (
          <Column style={{ padding: 'var(--space-3)', textAlign: 'center' }}>
            <Text variant="muted" size="sm">
              No variables yet
            </Text>
            <Text variant="muted" size="xs">
              Variables carry data between steps. Add one to connect your steps together.
            </Text>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setShowAddDialog(true);
              }}
            >
              + Add variable
            </Button>
          </Column>
        ) : (
          <Column gap="1">
            {variables.map((v) => (
              <VariableItem
                key={v.variableId}
                variable={v}
                usedBy={usedByMap.get(v.variableId) ?? []}
                isEditing={editingVar === v.variableId}
                onEdit={() => {
                  setEditingVar(editingVar === v.variableId ? null : v.variableId);
                }}
                onUpdate={(patch) => {
                  onUpdate(v.variableId, patch);
                }}
                onRemove={() => {
                  onRemove(v.variableId);
                }}
              />
            ))}
          </Column>
        )}
      </div>

      {/* Input contract preview */}
      <InputContractPreview variables={variables} />

      {/* Add dialog */}
      {showAddDialog && (
        <AddVariableDialog
          onAdd={(variable) => {
            onAdd(variable);
            setShowAddDialog(false);
          }}
          onClose={() => {
            setShowAddDialog(false);
          }}
          existingIds={new Set(variables.map((v) => v.variableId))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variable item
// ---------------------------------------------------------------------------

function VariableItem({
  variable,
  usedBy,
  isEditing,
  onEdit,
  onUpdate,
  onRemove,
}: {
  variable: StateVariable;
  usedBy: string[];
  isEditing: boolean;
  onEdit: () => void;
  onUpdate: (patch: Partial<StateVariable>) => void;
  onRemove: () => void;
}) {
  const directionLabel =
    variable.lifecycle.isInput && variable.lifecycle.isOutput
      ? 'input & output'
      : variable.lifecycle.isInput
        ? 'input'
        : variable.lifecycle.isOutput
          ? 'output'
          : 'internal';

  const directionColor = variable.lifecycle.isInput
    ? 'var(--color-info-default)'
    : variable.lifecycle.isOutput
      ? 'var(--color-success-default)'
      : 'var(--color-text-muted)';

  return (
    <div
      style={{
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        background: isEditing ? 'var(--color-surface-1)' : 'transparent',
        transition: 'background 150ms',
        cursor: 'pointer',
      }}
      onClick={onEdit}
    >
      <Column gap="1">
        {/* Title + icons in one row, title truncates */}
        <Row justify="between" align="center" gap="2" style={{ minWidth: 0 }}>
          <Text
            size="sm"
            title={variable.name || variable.variableId}
            style={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {variable.name || variable.variableId}
          </Text>
          <Row gap="1" style={{ flexShrink: 0 }}>
            <IconButton
              icon={<Icon name="pencil" size="xs" />}
              size="sm"
              variant="ghost"
              aria-label="Edit"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            />
            <IconButton
              icon={<Icon name="trash" size="xs" />}
              size="sm"
              variant="ghost"
              aria-label="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            />
          </Row>
        </Row>
        {/* Badges and meta below */}
        <Row gap="2" align="center" style={{ flexWrap: 'wrap' }}>
          <Badge variant="neutral" style={{ fontSize: '9px' }}>
            {typeLabel(variable.semanticType)}
          </Badge>
          <span style={{ fontSize: '10px', color: directionColor, fontWeight: 500 }}>
            {directionLabel}
          </span>
          {variable.lifecycle.isInput && variable.inputRole === 'primary' && (
            <Badge variant="info" style={{ fontSize: '9px' }}>
              primary
            </Badge>
          )}
          {variable.required && (
            <span style={{ fontSize: '10px', color: 'var(--color-danger-default)' }}>required</span>
          )}
          {variable.defaultValue !== undefined && (
            <span
              style={{
                fontSize: '10px',
                color: 'var(--color-content-muted)',
                fontStyle: 'italic',
              }}
            >
              default:{' '}
              {typeof variable.defaultValue === 'string'
                ? variable.defaultValue
                : JSON.stringify(variable.defaultValue)}
            </span>
          )}
        </Row>
        {usedBy.length > 0 && (
          <Text variant="muted" size="xs">
            Used by: {usedBy.join(', ')}
          </Text>
        )}
      </Column>

      {/* Inline edit */}
      {isEditing && <VariableEditForm variable={variable} onUpdate={onUpdate} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variable edit form (extracted for clarity)
// ---------------------------------------------------------------------------

function VariableEditForm({
  variable,
  onUpdate,
}: {
  variable: StateVariable;
  onUpdate: (patch: Partial<StateVariable>) => void;
}) {
  const existingEnums = extractEnumFromSchema(variable.typeSchema);
  const showEnumField =
    variable.semanticType === 'text' ||
    variable.semanticType === 'url' ||
    variable.semanticType === 'custom' ||
    existingEnums.length > 0;
  const isJsonType =
    variable.semanticType === 'json' ||
    variable.semanticType === 'keyvalue' ||
    variable.semanticType === 'list' ||
    variable.semanticType === 'table';

  const handleSemanticTypeChange = (newType: string) => {
    const enumVals = newType === variable.semanticType ? existingEnums : [];
    onUpdate({
      semanticType: newType as StateVariable['semanticType'],
      typeSchema: semanticTypeToSchema(newType, enumVals),
    });
  };

  const [enumDraft, setEnumDraft] = useState<string | null>(null);
  const commitEnumDraft = (raw: string) => {
    const vals = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    onUpdate({
      typeSchema: semanticTypeToSchema(variable.semanticType, vals),
    });
    setEnumDraft(null);
  };

  const defaultValueStr =
    variable.defaultValue === undefined
      ? ''
      : typeof variable.defaultValue === 'string'
        ? variable.defaultValue
        : JSON.stringify(variable.defaultValue);

  const handleDefaultValueChange = (raw: string) => {
    if (raw === '') {
      onUpdate({ defaultValue: undefined });
      return;
    }
    const schemaType = variable.typeSchema['type'];
    if (schemaType === 'number') {
      const n = parseFloat(raw);
      onUpdate({ defaultValue: isNaN(n) ? raw : n });
    } else if (schemaType === 'integer') {
      const n = parseInt(raw, 10);
      onUpdate({ defaultValue: isNaN(n) ? raw : n });
    } else if (schemaType === 'boolean') {
      onUpdate({ defaultValue: raw === 'true' });
    } else if (schemaType === 'object' || schemaType === 'array') {
      try {
        onUpdate({ defaultValue: JSON.parse(raw) });
      } catch {
        onUpdate({ defaultValue: raw });
      }
    } else {
      onUpdate({ defaultValue: raw });
    }
  };

  return (
    <div
      style={{
        marginTop: 'var(--space-2)',
        paddingTop: 'var(--space-2)',
        borderTop: '1px solid var(--color-border-subtle)',
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <Column gap="2">
        <Field>
          <Label>Display name</Label>
          <Input
            value={variable.name}
            onChange={(e) => {
              onUpdate({ name: e.target.value });
            }}
          />
        </Field>
        <Field>
          <Label>Description</Label>
          <Textarea
            value={variable.description ?? ''}
            onChange={(e) => {
              onUpdate({ description: e.target.value });
            }}
            rows={2}
            placeholder="What this variable holds"
          />
        </Field>
        <Field>
          <Label>Type</Label>
          <Select
            value={variable.semanticType}
            onChange={(e) => {
              handleSemanticTypeChange(e.target.value);
            }}
          >
            {SEMANTIC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          {/* Type schema preview badge */}
          <Text
            size="xs"
            variant="muted"
            style={{
              fontFamily: 'var(--font-mono)',
              marginTop: 'var(--space-1)',
            }}
          >
            Schema: {JSON.stringify(variable.typeSchema)}
          </Text>
        </Field>

        {/* Enum values — for string-like types */}
        {showEnumField && (
          <Field>
            <Label>
              Allowed values{' '}
              <Text as="span" size="xs" variant="muted">
                (comma-separated)
              </Text>
            </Label>
            <Input
              value={enumDraft ?? existingEnums.join(', ')}
              onChange={(e) => {
                setEnumDraft(e.target.value);
              }}
              onBlur={(e) => {
                commitEnumDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitEnumDraft((e.target as HTMLInputElement).value);
                }
              }}
              placeholder="e.g. haiku, sonnet, gpt, deepseek-v3"
            />
          </Field>
        )}

        {/* Object shape editor — for object/json/keyvalue types */}
        {isJsonType && (
          <ObjectPropertiesEditor
            properties={extractObjectProperties(variable.typeSchema)}
            onChange={(props) => {
              onUpdate({ typeSchema: objectPropertiesToSchema(props) });
            }}
          />
        )}

        {/* Default value */}
        <Field>
          <Label>Default value</Label>
          {isJsonType ? (
            <Textarea
              value={defaultValueStr}
              onChange={(e) => {
                handleDefaultValueChange(e.target.value);
              }}
              rows={2}
              placeholder="Default value (JSON)"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
            />
          ) : variable.typeSchema['type'] === 'boolean' ? (
            <Select
              value={
                variable.defaultValue === undefined
                  ? ''
                  : String(variable.defaultValue as string | number | boolean)
              }
              onChange={(e) => {
                if (e.target.value === '') {
                  onUpdate({ defaultValue: undefined });
                } else {
                  onUpdate({ defaultValue: e.target.value === 'true' });
                }
              }}
            >
              <option value="">— No default —</option>
              <option value="true">Yes (true)</option>
              <option value="false">No (false)</option>
            </Select>
          ) : (
            <Input
              value={defaultValueStr}
              onChange={(e) => {
                handleDefaultValueChange(e.target.value);
              }}
              placeholder="No default"
              type={
                variable.typeSchema['type'] === 'number' ||
                variable.typeSchema['type'] === 'integer'
                  ? 'number'
                  : 'text'
              }
            />
          )}
        </Field>

        <Divider />

        <Text size="xs" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
          Direction
        </Text>
        <Row gap="3" style={{ flexWrap: 'wrap' }}>
          <Checkbox
            checked={variable.lifecycle.isInput}
            onChange={(e) => {
              if (e.target.checked) {
                onUpdate({ lifecycle: { ...variable.lifecycle, isInput: true } });
              } else {
                onUpdate({
                  lifecycle: { ...variable.lifecycle, isInput: false },
                  inputRole: undefined,
                });
              }
            }}
          >
            Provided by user
          </Checkbox>
          {variable.lifecycle.isInput && (
            <Select
              value={variable.inputRole ?? 'config'}
              onChange={(e) => {
                const role = e.target.value as 'primary' | 'config';
                onUpdate({ inputRole: role });
              }}
              style={{ fontSize: 'var(--font-size-xs)', width: 'auto', minWidth: 120 }}
            >
              <option value="primary">Primary input</option>
              <option value="config">Config override</option>
            </Select>
          )}
          <Checkbox
            checked={variable.lifecycle.isOutput}
            onChange={(e) => {
              onUpdate({ lifecycle: { ...variable.lifecycle, isOutput: e.target.checked } });
            }}
          >
            Returned as result
          </Checkbox>
        </Row>
        <Checkbox
          checked={variable.required}
          onChange={(e) => {
            onUpdate({ required: e.target.checked });
          }}
        >
          Required (flow won&apos;t start without it)
        </Checkbox>
      </Column>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input contract preview
// ---------------------------------------------------------------------------

function InputContractPreview({ variables }: { variables: StateVariable[] }) {
  const inputVars = variables.filter((v) => v.lifecycle.isInput);
  if (inputVars.length === 0) return null;

  const primary =
    inputVars.find((v) => v.inputRole === 'primary') ??
    inputVars.find(
      (v) => v.required && (v.semanticType === 'text' || v.semanticType === 'markdown'),
    ) ??
    (inputVars.length === 1 ? inputVars[0] : undefined);

  const configs = inputVars.filter((v) => v !== primary);

  return (
    <div
      style={{
        padding: 'var(--space-3)',
        borderTop: '1px solid var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface-sunken)',
      }}
    >
      <Text
        size="xs"
        style={{
          fontWeight: 600,
          color: 'var(--color-content-secondary)',
          marginBottom: 'var(--space-2)',
        }}
      >
        Chat Input Preview
      </Text>
      <Column gap="1">
        {primary ? (
          <Row gap="2" align="center">
            <Badge variant="info" style={{ fontSize: '9px' }}>
              primary
            </Badge>
            <Text size="xs">{primary.name || primary.variableId}</Text>
            <Text size="xs" variant="muted">
              ({typeLabel(primary.semanticType)}
              {primary.required ? ', required' : ''})
            </Text>
          </Row>
        ) : (
          <Text size="xs" variant="muted" style={{ fontStyle: 'italic' }}>
            No primary input — user sends text via textarea
          </Text>
        )}
        {configs.length > 0 && (
          <Row gap="2" align="center" style={{ flexWrap: 'wrap' }}>
            <Badge variant="neutral" style={{ fontSize: '9px' }}>
              config
            </Badge>
            <Text size="xs">{configs.map((c) => c.name || c.variableId).join(', ')}</Text>
          </Row>
        )}
      </Column>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add variable dialog
// ---------------------------------------------------------------------------

function AddVariableDialog({
  onAdd,
  onClose,
  existingIds,
}: {
  onAdd: (variable: StateVariable) => void;
  onClose: () => void;
  existingIds: Set<string>;
}) {
  const [variableId, setVariableId] = useState('');
  const [name, setName] = useState('');
  const [semanticType, setSemanticType] = useState('text');
  const [isInput, setIsInput] = useState(false);
  const [isOutput, setIsOutput] = useState(false);

  const idError =
    variableId &&
    (existingIds.has(variableId)
      ? 'Already exists'
      : !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variableId)
        ? 'Use letters, numbers, underscores only'
        : null);
  const canAdd = variableId && name && !idError;

  // Auto-generate ID from name
  const handleNameChange = (newName: string) => {
    setName(newName);
    if (!variableId || variableId === nameToId(name)) {
      setVariableId(nameToId(newName));
    }
  };

  const handleAdd = () => {
    if (!canAdd) return;
    onAdd({
      variableId,
      name,
      semanticType: semanticType as StateVariable['semanticType'],
      typeSchema: semanticTypeToSchema(semanticType),
      lifecycle: { isInput, isOutput, persistOnPause: true, updateCount: 0 },
      required: false,
      sensitive: false,
      immutable: false,
      tags: [],
    });
  };

  return (
    <Dialog open onClose={onClose} title="Add Variable">
      <Column gap="3" style={{ padding: 'var(--space-4)', minWidth: 'min(340px, 100%)' }}>
        <Text variant="muted" size="xs">
          Variables carry data between steps. An input variable is provided by the user. An output
          variable is returned when the flow finishes.
        </Text>
        <Field>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => {
              handleNameChange(e.target.value);
            }}
            placeholder="e.g. User Message"
            autoFocus
          />
        </Field>
        <Field>
          <Label>ID</Label>
          <Input
            value={variableId}
            onChange={(e) => {
              setVariableId(e.target.value);
            }}
            placeholder="e.g. user_message"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}
          />
          {idError && (
            <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
              {idError}
            </Text>
          )}
        </Field>
        <Field>
          <Label>Type</Label>
          <Select
            value={semanticType}
            onChange={(e) => {
              setSemanticType(e.target.value);
            }}
          >
            {SEMANTIC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Divider />
        <Text size="xs" style={{ fontWeight: 600, color: 'var(--color-text-muted)' }}>
          Direction
        </Text>
        <Row gap="3">
          <Checkbox
            checked={isInput}
            onChange={(e) => {
              setIsInput(e.target.checked);
            }}
          >
            Provided by user
          </Checkbox>
          <Checkbox
            checked={isOutput}
            onChange={(e) => {
              setIsOutput(e.target.checked);
            }}
          >
            Returned as result
          </Checkbox>
        </Row>
        <Divider />
        <Row justify="end" gap="2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleAdd} disabled={!canAdd}>
            Add Variable
          </Button>
        </Row>
      </Column>
    </Dialog>
  );
}

/** Convert a display name to a variable ID */
function nameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 64);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUsedByMap(
  variables: StateVariable[] | undefined | null,
  steps: Array<{
    stepId: string;
    name?: string | undefined;
    config?: Record<string, unknown> | undefined;
    outputMapping?: Record<string, string> | undefined;
  }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const v of variables ?? []) {
    map.set(v.variableId, []);
  }

  for (const step of steps) {
    const refs = new Set<string>();
    scanConfigForVarRefs(step.config ?? {}, refs);
    for (const expr of Object.values(step.outputMapping ?? {})) {
      const match = /state\.([a-zA-Z_][a-zA-Z0-9_]*)/.exec(expr);
      if (match?.[1]) refs.add(match[1]);
    }
    for (const varId of refs) {
      const list = map.get(varId);
      if (list) list.push(step.name ?? step.stepId);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Object properties editor
// ---------------------------------------------------------------------------

function ObjectPropertiesEditor({
  properties,
  onChange,
}: {
  properties: ObjectProperty[];
  onChange: (properties: ObjectProperty[]) => void;
}) {
  const handleAdd = () => {
    onChange([...properties, { key: '', type: 'string', description: '', required: false }]);
  };

  const handleRemove = (index: number) => {
    onChange(properties.filter((_, i) => i !== index));
  };

  const handleUpdate = (index: number, patch: Partial<ObjectProperty>) => {
    onChange(properties.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  return (
    <Field>
      <Label>
        Object shape{' '}
        <Text as="span" size="xs" variant="muted">
          (define expected fields)
        </Text>
      </Label>
      <Column gap="2">
        {properties.map((prop, i) => (
          <div
            key={i}
            style={{
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border-subtle)',
              background: 'var(--color-surface-0)',
            }}
          >
            <Column gap="1">
              <Row gap="2" align="center">
                <Input
                  value={prop.key}
                  onChange={(e) => {
                    handleUpdate(i, { key: e.target.value });
                  }}
                  placeholder="field name"
                  style={{ flex: 2, fontSize: 'var(--font-size-xs)' }}
                />
                <Select
                  value={prop.type}
                  onChange={(e) => {
                    handleUpdate(i, { type: e.target.value });
                  }}
                  style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}
                >
                  {PROPERTY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                <Checkbox
                  size="sm"
                  checked={prop.required}
                  onChange={(e) => {
                    handleUpdate(i, { required: e.target.checked });
                  }}
                >
                  req
                </Checkbox>
                <IconButton
                  icon={<Icon name="trash" size="xs" />}
                  size="sm"
                  variant="ghost"
                  aria-label="Remove field"
                  onClick={() => {
                    handleRemove(i);
                  }}
                />
              </Row>
              <Input
                value={prop.description}
                onChange={(e) => {
                  handleUpdate(i, { description: e.target.value });
                }}
                placeholder="description"
                style={{ fontSize: 'var(--font-size-xs)' }}
              />
            </Column>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={handleAdd} style={{ alignSelf: 'start' }}>
          + Add field
        </Button>
      </Column>
    </Field>
  );
}

function scanConfigForVarRefs(obj: Record<string, unknown>, refs: Set<string>): void {
  for (const val of Object.values(obj)) {
    if (typeof val === 'string') {
      const matches = val.matchAll(/\$\{(?:state|input)\.([a-zA-Z_][a-zA-Z0-9_]*)\}/g);
      for (const m of matches) {
        if (m[1]) refs.add(m[1]);
      }
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      scanConfigForVarRefs(val as Record<string, unknown>, refs);
    }
  }
}
