'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Column } from '../layout/Column.js';
import { Row } from '../layout/Row.js';
import { Text } from '../primitives/Text.js';
import { Button } from '../primitives/Button.js';
import { Checkbox } from '../primitives/Checkbox.js';
import { Icon } from '../icons/Icon.js';

// ============================================================================
// Public types
// ============================================================================

export interface SchemaFormProps {
  /** JSON Schema describing the value. See file header for the supported subset. */
  schema: Record<string, unknown>;
  /** Current value. Controlled — host owns the state. */
  value: unknown;
  /** Called on every edit. Host re-renders with the new value. */
  onChange: (value: unknown) => void;
  /**
   * Optional: emits true when all required fields are populated AND
   * each populated field's runtime type matches the schema. False
   * otherwise. The host wires this into the submit button's `disabled`
   * prop. Default behaviour (no listener) is "the host doesn't care."
   */
  onValidityChange?: (valid: boolean) => void;
  /** Disable all controls (typically while submitting). */
  disabled?: boolean;
}

// ============================================================================
// Schema classification — single decision point for the renderer + fallback
// ============================================================================

/**
 * Internal helper types are exported for unit tests (no DOM render
 * scaffolding in this package yet — see `IndicatorButton` for the
 * same pattern). Not re-exported through `feedback/index.ts`; only
 * the SchemaForm component is public API.
 */
export type SchemaFormPrimitive = 'string' | 'number' | 'integer' | 'boolean';

export type SchemaFormClassification =
  | { kind: 'primitive'; type: SchemaFormPrimitive }
  | { kind: 'enum'; values: unknown[] }
  | { kind: 'object'; fields: SchemaFormObjectField[] }
  | { kind: 'array'; itemClass: SchemaFormClassification }
  | { kind: 'unsupported'; reason: string };

export interface SchemaFormObjectField {
  key: string;
  required: boolean;
  description: string;
  classification: SchemaFormClassification;
}

// Internal aliases (file-local readability) — the public names above
// are deliberately verbose so they're greppable from tests.
type Primitive = SchemaFormPrimitive;
type Classification = SchemaFormClassification;
type ObjectField = SchemaFormObjectField;

/**
 * Single source of truth for "is this schema renderable?" Returns the
 * exact shape the renderer needs (no further parsing downstream) or an
 * `unsupported` sentinel with the reason — surfaced to the operator so
 * the schema author can see *why* their schema dropped to the fallback.
 */
export function classify(schema: Record<string, unknown>): Classification {
  // enum trumps type — a schema with both is an enum (e.g. enum of strings).
  const enumValues = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : null;
  if (enumValues && enumValues.length > 0) {
    return { kind: 'enum', values: enumValues };
  }

  const type = typeof schema['type'] === 'string' ? schema['type'] : undefined;
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
    return { kind: 'primitive', type };
  }

  if (type === 'object') {
    const properties = schema['properties'];
    if (!isPlainObject(properties)) {
      return { kind: 'unsupported', reason: 'object schema is missing `properties`' };
    }
    if (schema['oneOf'] || schema['anyOf'] || schema['allOf']) {
      return { kind: 'unsupported', reason: 'discriminated unions are not supported' };
    }
    const requiredList = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    const required = new Set(requiredList);
    const entries = Object.entries(properties);
    if (entries.length === 0) {
      return { kind: 'unsupported', reason: 'object schema has no properties' };
    }
    const fields: ObjectField[] = entries.map(([key, raw]) => {
      const propSchema = isPlainObject(raw) ? raw : {};
      const inner = classify(propSchema);
      // Nested objects/arrays inside an object aren't supported in v1.
      // Collapse them into the unsupported bucket so the *whole* schema
      // drops to fallback — partial object rendering with a "this field
      // is too complex" cell would be more confusing than the JSON view.
      const collapsed: Classification =
        inner.kind === 'object' || inner.kind === 'array'
          ? { kind: 'unsupported', reason: `nested ${inner.kind} at \`${key}\`` }
          : inner;
      return {
        key,
        required: required.has(key),
        description: typeof propSchema['description'] === 'string' ? propSchema['description'] : '',
        classification: collapsed,
      };
    });
    const firstBad = fields.find((f) => f.classification.kind === 'unsupported');
    if (firstBad) {
      return {
        kind: 'unsupported',
        reason: (firstBad.classification as { kind: 'unsupported'; reason: string }).reason,
      };
    }
    return { kind: 'object', fields };
  }

  if (type === 'array') {
    const items = schema['items'];
    if (Array.isArray(items)) {
      return {
        kind: 'unsupported',
        reason: 'tuple-shaped arrays (`items` array) are not supported',
      };
    }
    if (!isPlainObject(items)) {
      return { kind: 'unsupported', reason: 'array schema is missing `items`' };
    }
    const itemClass = classify(items);
    if (itemClass.kind === 'object' || itemClass.kind === 'array') {
      return { kind: 'unsupported', reason: 'nested object/array inside array is not supported' };
    }
    if (itemClass.kind === 'unsupported') return itemClass;
    return { kind: 'array', itemClass };
  }

  // A schema that declares no `type` and carries no structural keyword is an
  // under-specified leaf (e.g. a property with only a `description`). Its real
  // type is unknowable, so render it as a freeform string rather than letting
  // one such field collapse an otherwise-renderable form; server validation
  // still gates the value. A declared-but-unrenderable type (e.g. `null`)
  // keeps falling back to JSON.
  if (type === undefined && !hasStructuralKeyword(schema)) {
    return { kind: 'primitive', type: 'string' };
  }
  return { kind: 'unsupported', reason: `unsupported schema type: ${type ?? '(missing)'}` };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasStructuralKeyword(schema: Record<string, unknown>): boolean {
  return (
    schema['properties'] !== undefined ||
    schema['items'] !== undefined ||
    schema['oneOf'] !== undefined ||
    schema['anyOf'] !== undefined ||
    schema['allOf'] !== undefined
  );
}

// ============================================================================
// Validity — checks required fields are populated and types match
// ============================================================================

export function isValid(classification: Classification, value: unknown): boolean {
  switch (classification.kind) {
    case 'primitive':
      return matchesPrimitive(classification.type, value);
    case 'enum':
      return classification.values.includes(value);
    case 'object': {
      if (!isPlainObject(value)) return false;
      for (const field of classification.fields) {
        const fv = value[field.key];
        const populated = fv !== undefined && fv !== '' && fv !== null;
        if (field.required && !populated) return false;
        if (populated && !isValid(field.classification, fv)) return false;
      }
      return true;
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      return value.every((item) => isValid(classification.itemClass, item));
    }
    case 'unsupported':
      // Fallback path runs raw JSON. The textarea calls onChange only
      // when JSON.parse succeeds (or text is empty), so `value` is
      // never a raw mid-parse string from this code path — see
      // `UnsupportedFallback`. Treat any defined parsed value as
      // valid; empty (undefined) and raw strings are NOT valid (the
      // schema isn't a string schema — those classify as `primitive`).
      // Server-side validation gates the parsed payload.
      if (value === undefined) return false;
      if (typeof value === 'string') return false;
      return true;
  }
}

function matchesPrimitive(type: Primitive, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string' && value.length > 0;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

// ============================================================================
// Component
// ============================================================================

export function SchemaForm({
  schema,
  value,
  onChange,
  onValidityChange,
  disabled = false,
}: SchemaFormProps): ReactElement {
  const classification = useMemo(() => classify(schema), [schema]);

  // Emit validity on every value/classification change. The host
  // wires the boolean into its submit button.
  useEffect(() => {
    if (onValidityChange) onValidityChange(isValid(classification, value));
  }, [classification, value, onValidityChange]);

  if (classification.kind === 'unsupported') {
    return (
      <UnsupportedFallback
        reason={classification.reason}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  return (
    <ValueEditor
      classification={classification}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

// ============================================================================
// Renderers — one per classification kind. All controlled.
// ============================================================================

interface EditorProps {
  classification: Classification;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}

function ValueEditor({ classification, value, onChange, disabled }: EditorProps): ReactElement {
  switch (classification.kind) {
    case 'primitive':
      return (
        <PrimitiveEditor
          type={classification.type}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'enum':
      return (
        <EnumEditor
          values={classification.values}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'object':
      return (
        <ObjectEditor
          fields={classification.fields}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'array':
      return (
        <ArrayEditor
          itemClass={classification.itemClass}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'unsupported':
      // Unreachable — classify() short-circuits at the top of SchemaForm.
      return <></>;
  }
}

function PrimitiveEditor({
  type,
  value,
  onChange,
  disabled,
}: {
  type: Primitive;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}): ReactElement {
  if (type === 'boolean') {
    return (
      <Checkbox
        checked={value === true}
        disabled={disabled}
        size="sm"
        label={value === true ? 'Yes' : 'No'}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
    );
  }
  if (type === 'number' || type === 'integer') {
    return (
      <input
        type="number"
        step={type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' ? value : ''}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            onChange(undefined);
            return;
          }
          const n = type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
        style={inputStyle}
      />
    );
  }
  // string
  return (
    <input
      type="text"
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      style={inputStyle}
    />
  );
}

function EnumEditor({
  values,
  value,
  onChange,
  disabled,
}: {
  values: unknown[];
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <select
      value={values.indexOf(value)}
      disabled={disabled}
      onChange={(e) => {
        const idx = parseInt(e.target.value, 10);
        onChange(idx >= 0 && idx < values.length ? values[idx] : undefined);
      }}
      style={inputStyle}
    >
      <option value={-1}>{value === undefined ? 'Select…' : '(clear)'}</option>
      {values.map((v, idx) => (
        <option key={String(idx)} value={idx}>
          {typeof v === 'string' ? v : JSON.stringify(v)}
        </option>
      ))}
    </select>
  );
}

function ObjectEditor({
  fields,
  value,
  onChange,
  disabled,
}: {
  fields: ObjectField[];
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}): ReactElement {
  const obj = isPlainObject(value) ? value : {};
  return (
    <Column gap="sm">
      {fields.map((field) => (
        <Column key={field.key} gap="xs">
          <Row gap="xs" align="center" wrap>
            <Text size="xs" weight="medium">
              {field.key}
              {field.required && (
                <span aria-label="required" style={{ color: 'var(--color-danger-default)' }}>
                  {' '}
                  *
                </span>
              )}
            </Text>
            {field.description && (
              <Text size="xs" variant="muted">
                — {field.description}
              </Text>
            )}
          </Row>
          <ValueEditor
            classification={field.classification}
            value={obj[field.key]}
            onChange={(v) => {
              const next = { ...obj };
              if (v === undefined) delete next[field.key];
              else next[field.key] = v;
              onChange(next);
            }}
            disabled={disabled}
          />
        </Column>
      ))}
    </Column>
  );
}

function ArrayEditor({
  itemClass,
  value,
  onChange,
  disabled,
}: {
  itemClass: Classification;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}): ReactElement {
  // Narrow to unknown[] explicitly — `Array.isArray` on an unknown
  // narrows to `any[]` in TS, which makes spreads/filters trip
  // `no-unsafe-assignment`.
  const arr: unknown[] = Array.isArray(value) ? (value as unknown[]) : [];
  return (
    <Column gap="sm">
      {arr.map((item, idx) => (
        <Row key={String(idx)} gap="sm" align="center">
          <div style={{ flex: 1 }}>
            <ValueEditor
              classification={itemClass}
              value={item}
              onChange={(v) => {
                const next: unknown[] = [...arr];
                next[idx] = v;
                onChange(next);
              }}
              disabled={disabled}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange(arr.filter((_, i) => i !== idx));
            }}
            leftIcon={<Icon name="x" size="sm" />}
            aria-label={`Remove row ${String(idx + 1)}`}
          >
            Remove
          </Button>
        </Row>
      ))}
      <Row>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => {
            const next: unknown[] = [...arr, defaultFor(itemClass)];
            onChange(next);
          }}
          leftIcon={<Icon name="plus" size="sm" />}
        >
          Add row
        </Button>
      </Row>
    </Column>
  );
}

/**
 * Fallback — raw JSON textarea + a hint explaining why the schema
 * dropped here. The operator can still respond; they just lose the
 * structured affordance. Validation runs server-side regardless, so
 * this is the worst-case path, not a dead end.
 *
 * Submit-gating contract: the textarea owns its own draft text in
 * local state. `onChange` is called with a parsed value only when
 * JSON.parse succeeds (or with `undefined` when the textarea is
 * cleared). Mid-parse drafts stay local and the host's submit button
 * remains disabled via `isValid`'s `unsupported` branch (which
 * rejects `undefined` and string `value`s). This trades a tighter
 * client-side block for one 400-after-click, which is the better UX
 * the inline review-comment originally promised but the previous
 * implementation didn't deliver.
 */
function UnsupportedFallback({
  reason,
  value,
  onChange,
  disabled,
}: {
  reason: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}): ReactElement {
  // Local draft text — only flushes to `onChange` when it parses.
  // Initial seed comes from the parsed value if the parent already
  // had one (e.g. snapshot rehydrate).
  const [draft, setDraft] = useState<string>(() =>
    value === undefined ? '' : JSON.stringify(value, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <Column gap="xs">
      <Text size="xs" variant="muted">
        Schema not renderable as a form ({reason}). Edit the JSON directly; server-side validation
        still applies once you submit.
      </Text>
      <textarea
        value={draft}
        disabled={disabled}
        rows={8}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() === '') {
            setParseError(null);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            setParseError(null);
            onChange(parsed);
          } catch (err) {
            // Don't push the unparsed string up — keeps `value` clean
            // and lets `isValid` (which rejects `string`) gate the
            // submit button until JSON parses again. Surface the
            // parse error locally so the operator sees *why* submit
            // is blocked instead of guessing.
            setParseError(err instanceof Error ? err.message : 'JSON parse error');
            onChange(undefined);
          }
        }}
        style={textareaStyle}
        aria-label="Raw JSON value"
        aria-invalid={parseError !== null}
      />
      {parseError && (
        <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
          JSON parse error — {parseError}
        </Text>
      )}
    </Column>
  );
}

// ============================================================================
// Defaults — used when adding a new array row
// ============================================================================

function defaultFor(classification: Classification): unknown {
  switch (classification.kind) {
    case 'primitive':
      switch (classification.type) {
        case 'string':
          return '';
        case 'number':
        case 'integer':
          return undefined;
        case 'boolean':
          return false;
      }
      return undefined;
    case 'enum':
      return undefined;
    case 'object':
      return {};
    case 'array':
      return [];
    case 'unsupported':
      return undefined;
  }
}

// ============================================================================
// Styles
// ============================================================================

const inputStyle: CSSProperties = {
  width: '100%',
  padding: 'var(--space-2, 8px)',
  borderRadius: 'var(--radius-sm, 4px)',
  border: '1px solid var(--color-border-subtle, #d4d4d8)',
  background: 'var(--color-surface-1, #fff)',
  color: 'var(--color-text-primary, #111)',
  fontFamily: 'inherit',
  fontSize: '0.875rem',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
};
