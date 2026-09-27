'use client';

import { useState } from 'react';
import { Text, Column, Button, Row, Checkbox } from '@aflow/design-system';

type SchemaProp =
  | {
      type: 'string';
      title?: string;
      description?: string;
      enum?: string[];
      default?: string;
      format?: string;
      minLength?: number;
      maxLength?: number;
    }
  | {
      type: 'number' | 'integer';
      title?: string;
      description?: string;
      default?: number;
      minimum?: number;
      maximum?: number;
    }
  | { type: 'boolean'; title?: string; description?: string; default?: boolean }
  | {
      type: 'array';
      title?: string;
      description?: string;
      items?: { type: 'string'; enum?: string[] };
      default?: string[];
    };

interface JsonSchemaLike {
  type?: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  // Index signature satisfies the `s is JsonSchemaLike` guard against
  // `Record<string, unknown>` — the SDK passes through arbitrary extra
  // JSON-Schema keywords (title, description, $schema, etc.) and we
  // want the type predicate to remain assignable to the input shape.
  [k: string]: unknown;
}

export type ElicitationContent = Record<string, string | number | boolean | string[]>;

/**
 * Internal form state — allows `undefined` so an empty text/number input
 * can drop the field entirely instead of holding an empty-string sentinel
 * that would lie about the runtime type. Required-field validation
 * treats undefined the same as empty string / empty array.
 */
type FormState = Record<string, string | number | boolean | string[] | undefined>;

interface Props {
  schema: Record<string, unknown>;
  busy: boolean;
  onAccept: (content: ElicitationContent) => void;
  onDecline: () => void;
  onCancel: () => void;
}

function isObjectSchema(s: Record<string, unknown>): s is JsonSchemaLike {
  return s['type'] === 'object' || typeof s['properties'] === 'object';
}

function normProp(raw: unknown): SchemaProp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const t = o['type'];
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'array') {
    return o as unknown as SchemaProp;
  }
  return null;
}

export function McpElicitationForm({ schema, busy, onAccept, onDecline, onCancel }: Props) {
  // Note: per the card's component contract, `<McpElicitationCard>` is
  // remounted via `key={entry.elicitationId}` at the page level, so this
  // state never inherits values from a different elicitation. If a future
  // refactor changes that keying, add a useEffect to reset on schema
  // identity change.
  const [values, setValues] = useState<FormState>(() => initialValues(schema));
  const [error, setError] = useState<string | null>(null);

  if (!isObjectSchema(schema)) {
    return (
      <Text size="sm" variant="muted">
        Unsupported elicitation schema — the server did not send a flat object schema.
      </Text>
    );
  }

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(properties)
    .map(([name, raw]) => [name, normProp(raw)] as const)
    .filter((pair): pair is [string, SchemaProp] => pair[1] !== null);

  const submit = (): void => {
    // Client-side preflight — only check required fields. Type
    // validation runs server-side via AJV; replicating it here would
    // diverge over time.
    for (const [name] of fields) {
      if (required.has(name) && !hasValue(values[name])) {
        setError(`Required: ${name}`);
        return;
      }
    }
    setError(null);
    // Strip empty / undefined optional fields so the server's AJV pass
    // doesn't reject blank inputs against numeric/boolean property types.
    // After `hasValue` filtering, the value is guaranteed non-undefined
    // and assignable to `ElicitationContent`.
    const cleaned: ElicitationContent = {};
    for (const [name] of fields) {
      const v = values[name];
      if (hasValue(v)) cleaned[name] = v;
    }
    onAccept(cleaned);
  };

  const updateField = (name: string, v: string | number | boolean | string[] | undefined): void => {
    setValues((prev) => {
      const next: FormState = { ...prev };
      if (v === undefined) {
        delete next[name];
      } else {
        next[name] = v;
      }
      return next;
    });
  };

  return (
    <Column gap="3">
      {fields.map(([name, prop]) => {
        const label = (prop as { title?: string }).title ?? name;
        const description = (prop as { description?: string }).description;
        const isRequired = required.has(name);
        return (
          <Column key={name} gap="1">
            <Text size="sm" weight="medium">
              {label}
              {isRequired ? ' *' : ''}
            </Text>
            {description ? (
              <Text size="xs" variant="muted">
                {description}
              </Text>
            ) : null}
            <FieldInput
              prop={prop}
              value={values[name]}
              onChange={(v) => {
                updateField(name, v);
              }}
            />
          </Column>
        );
      })}
      {error ? (
        <Text size="sm" tone="danger">
          {error}
        </Text>
      ) : null}
      <Row gap="2" wrap>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {busy ? 'Submitting…' : 'Submit'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDecline}>
          Decline
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </Row>
    </Column>
  );
}

function FieldInput({
  prop,
  value,
  onChange,
}: {
  prop: SchemaProp;
  value: string | number | boolean | string[] | undefined;
  /** `undefined` clears the field — parent drops the key from form state. */
  onChange: (v: string | number | boolean | string[] | undefined) => void;
}) {
  const base: React.CSSProperties = {
    padding: 'var(--space-2) var(--space-3)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-default)',
    background: 'var(--color-surface-1)',
    fontSize: 'var(--font-size-sm)',
    width: '100%',
  };

  if (prop.type === 'string' && prop.enum) {
    return (
      <select
        style={base}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">— select —</option>
        {prop.enum.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (prop.type === 'boolean') {
    return (
      <Checkbox
        checked={value === true}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
    );
  }

  if (prop.type === 'number' || prop.type === 'integer') {
    return (
      <input
        style={base}
        type="number"
        step={prop.type === 'integer' ? 1 : 'any'}
        // Browser-native bounds hints from the schema. AJV is still the
        // authority server-side; these just give the user a faster
        // signal before submit.
        {...(prop.minimum !== undefined ? { min: prop.minimum } : {})}
        {...(prop.maximum !== undefined ? { max: prop.maximum } : {})}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') {
            // Drop the field rather than holding an empty-string sentinel
            // that would lie about the runtime type. submit() treats
            // undefined the same as empty for required-field validation.
            onChange(undefined);
            return;
          }
          const n = prop.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
          if (!Number.isNaN(n)) onChange(n);
        }}
      />
    );
  }

  if (prop.type === 'array') {
    // Multi-string array: simple comma-separated input. MCP enum-array
    // arrives as `items: { type: 'string', enum: [...] }` — handled
    // identically; the server's AJV pass enforces the enum constraint.
    const arr = Array.isArray(value) ? value : [];
    return (
      <input
        style={base}
        type="text"
        placeholder="comma-separated values"
        value={arr.join(', ')}
        onChange={(e) => {
          const v = e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          onChange(v);
        }}
      />
    );
  }

  // String / string-with-format (date/email/uri/date-time). HTML5 input
  // type honors the format hint where browser support exists.
  const inputType =
    prop.type === 'string' && prop.format === 'email'
      ? 'email'
      : prop.type === 'string' && prop.format === 'uri'
        ? 'url'
        : prop.type === 'string' && prop.format === 'date'
          ? 'date'
          : prop.type === 'string' && prop.format === 'date-time'
            ? 'datetime-local'
            : 'text';
  const stringProp = prop.type === 'string' ? prop : undefined;
  return (
    <input
      style={base}
      type={inputType}
      {...(stringProp?.minLength !== undefined ? { minLength: stringProp.minLength } : {})}
      {...(stringProp?.maxLength !== undefined ? { maxLength: stringProp.maxLength } : {})}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => {
        const raw = e.target.value;
        // Drop empty strings so optional fields aren't sent as `""`
        // (the server's AJV would reject against numeric/enum types
        // for fields that share a value — defensive).
        onChange(raw === '' ? undefined : raw);
      }}
    />
  );
}

function initialValues(schema: Record<string, unknown>): FormState {
  const out: FormState = {};
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  for (const [name, raw] of Object.entries(properties)) {
    const prop = normProp(raw);
    if (!prop) continue;
    if ('default' in prop && prop.default !== undefined) {
      // The discriminated union narrows `default` to the right value
      // type for each branch.
      out[name] = prop.default;
    }
  }
  return out;
}

// Type predicate so a guarded `if (hasValue(v))` narrows `v` from the
// FormState union to the non-undefined branches — lets `cleaned[name] = v`
// type-check against `ElicitationContent[string]` without an assertion.
function hasValue(
  v: string | number | boolean | string[] | undefined,
): v is string | number | boolean | string[] {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.length === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
