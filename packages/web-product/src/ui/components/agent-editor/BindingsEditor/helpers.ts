import type { CatalogOperation } from '../../../hooks/use-operation-catalog.js';
import type { StateVariable } from '../../../lib/flow-to-graph.js';
import type { SchemaProperty } from './types.js';

// ---------------------------------------------------------------------------
// Value detection
// ---------------------------------------------------------------------------

/** Check if a value expression is a variable reference */
export function isVariableRef(value: string): boolean {
  return value.startsWith('state.') || value.startsWith('input.');
}

/** Extract the inner ref from a ${...} config value, e.g. "${state.x}" -> "state.x" */
export function extractConfigRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\$\{([^}]+)\}$/.exec(value);
  return match?.[1] ?? null;
}

/** Extract a human-friendly label for a variable reference */
export function varRefLabel(value: string, variables: StateVariable[]): string {
  const inner = extractConfigRef(value) ?? value;
  const id = inner.startsWith('input.')
    ? inner.slice(6)
    : inner.startsWith('state.')
      ? inner.slice(6)
      : inner;
  const v = variables.find((v) => v.variableId === id);
  return v?.name || id;
}

// ---------------------------------------------------------------------------
// Schema helpers for smart input rendering
// ---------------------------------------------------------------------------

/** Pull enum values from a schema property (direct enum or anyOf pattern). */
export function getEnumValues(prop: SchemaProperty): string[] | null {
  if (prop.enum && Array.isArray(prop.enum)) {
    return prop.enum.map(String);
  }
  if (prop.anyOf && Array.isArray(prop.anyOf)) {
    for (const branch of prop.anyOf) {
      if (branch.enum && Array.isArray(branch.enum)) {
        return branch.enum.map(String);
      }
    }
  }
  return null;
}

/** Whether the property supports custom values beyond the enum (anyOf pattern). */
export function allowsCustom(prop: SchemaProperty): boolean {
  return prop.anyOf != null;
}

/**
 * Parse a fixed-value expression string back to a raw value.
 * e.g., '"hello"' -> 'hello', '42' -> 42, 'true' -> true
 */
export function parseFixedValue(expr: string): {
  raw: string;
  kind: 'string' | 'number' | 'boolean' | 'unknown';
} {
  if (expr.startsWith('"') && expr.endsWith('"')) {
    return { raw: expr.slice(1, -1), kind: 'string' };
  }
  if (expr === 'true' || expr === 'false') {
    return { raw: expr, kind: 'boolean' };
  }
  if (/^-?\d+(\.\d+)?$/.test(expr)) {
    return { raw: expr, kind: 'number' };
  }
  return { raw: expr, kind: 'unknown' };
}

/**
 * Parse a literal expression string to a real typed JS value for config storage.
 * Handles: quoted strings, booleans, numbers, JSON arrays/objects.
 */
export function parseExprToTypedValue(expr: string): unknown {
  if (expr === 'true') return true;
  if (expr === 'false') return false;

  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);

  if (expr.startsWith('"') && expr.endsWith('"') && expr.length >= 2) {
    const inner = expr.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const trimmed = inner.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* not valid JSON — return as string */
      }
    }
    return inner;
  }

  const trimmed = expr.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not valid JSON */
    }
  }

  return expr;
}

/**
 * Serialize a raw value to a fixed-value expression string for config display.
 */
export function toFixedExpr(raw: string, fieldType: string): string {
  if (fieldType === 'boolean') return raw === 'true' ? 'true' : 'false';
  if (fieldType === 'number' || fieldType === 'integer') return raw;
  if (fieldType === 'object' || fieldType === 'array') {
    return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** For array schema: get the items schema */
export function getItemsSchema(prop: SchemaProperty): SchemaProperty | undefined {
  const items = prop.items;
  if (!items) return undefined;
  return Array.isArray(items) ? items[0] : items;
}

export function inferValueType(v: unknown): 'string' | 'number' | 'boolean' | 'variable' {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string' && extractConfigRef(v) != null) return 'variable';
  return 'string';
}

// ---------------------------------------------------------------------------
// Schema extraction and field helpers
// ---------------------------------------------------------------------------

/** Convert camelCase/snake_case field names to human-readable labels */
export function humanizeField(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\s/, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function extractFields(schema?: Record<string, unknown>): Array<[string, SchemaProperty]> {
  if (!schema) return [];
  const typed = schema as { type?: string; properties?: Record<string, SchemaProperty> };
  if (typed.type !== 'object' || !typed.properties) return [];
  return Object.entries(typed.properties).map(([key, prop]) => {
    const resolvedType = prop.type ?? prop.anyOf?.find((b) => b.type)?.type;
    return [key, { ...prop, type: resolvedType ?? prop.type }] as [string, SchemaProperty];
  });
}

export function getRequiredFields(schema?: Record<string, unknown>): string[] {
  if (!schema) return [];
  const typed = schema as { required?: string[] };
  return typed.required ?? [];
}

export function fieldTooltip(prop: SchemaProperty): string {
  if (prop.description) return prop.description;
  const parts: string[] = [];
  parts.push(prop.type ?? 'unknown');
  if (prop.enum) parts.push(`one of: ${prop.enum.map(String).join(', ')}`);
  if (prop.minimum != null) parts.push(`min: ${prop.minimum}`);
  if (prop.maximum != null) parts.push(`max: ${prop.maximum}`);
  if (prop.minLength != null) parts.push(`minLen: ${prop.minLength}`);
  if (prop.maxLength != null) parts.push(`maxLen: ${prop.maxLength}`);
  if (prop.default !== undefined) parts.push(`default: ${JSON.stringify(prop.default)}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Dynamic enum hints for special operations
// ---------------------------------------------------------------------------

/** Derive the qualified groupId from a catalog operation. */
export function deriveGroupId(op: CatalogOperation): string {
  const parts = op.operationId.split('.');
  if (parts.length >= 3) return `${parts[0]}.${parts[1]}`;
  return op.stepType;
}

/**
 * For specific operations, inject enum values into schema properties so that
 * generic array/string rendering produces dropdown selectors automatically.
 */
export function applyDynamicEnums(
  operationId: string,
  field: string,
  prop: SchemaProperty,
  catalog: CatalogOperation[],
): SchemaProperty {
  const itemsSchema = prop.items && !Array.isArray(prop.items) ? prop.items : undefined;

  if (operationId === 'catalog.tool.list') {
    if (field === 'groupIds' && itemsSchema && !getEnumValues(itemsSchema)) {
      const groupIds = [...new Set(catalog.map(deriveGroupId))].sort();
      return { ...prop, items: { ...itemsSchema, enum: groupIds } };
    }
    if (field === 'operationIds' && itemsSchema && !getEnumValues(itemsSchema)) {
      const opIds = catalog.map((o) => o.operationId).sort();
      return { ...prop, items: { ...itemsSchema, enum: opIds } };
    }
  }
  if (operationId === 'agent.control.run_step') {
    if (field === 'operationId' && !prop.enum && !prop.anyOf) {
      const opIds = catalog.map((o) => o.operationId).sort();
      return { ...prop, anyOf: [{ enum: opIds }, { type: 'string' }] };
    }
  }

  // ai.agent.turn → catalog object: enrich coreOperations + discovery sub-object with enums
  if (
    operationId === 'ai.agent.turn' &&
    field === 'catalog' &&
    prop.type === 'object' &&
    prop.properties
  ) {
    const stepTypes = [...new Set(catalog.map((o) => o.stepType))].sort();
    const opIds = catalog.map((o) => o.operationId).sort();
    const groupIds = [...new Set(catalog.map(deriveGroupId))].sort();
    const enriched = { ...prop, properties: { ...prop.properties } };

    const coreProp = enriched.properties['coreOperations'];
    if (coreProp?.type === 'array') {
      const coreItems = coreProp.items && !Array.isArray(coreProp.items) ? coreProp.items : {};
      enriched.properties = {
        ...enriched.properties,
        coreOperations: { ...coreProp, items: { ...coreItems, enum: opIds } },
      };
    }

    // Enrich the nested discovery object properties
    const discProp = enriched.properties['discovery'];
    if (discProp?.type === 'object' && discProp.properties) {
      const discEnriched = { ...discProp, properties: { ...discProp.properties } };

      const stProp = discEnriched.properties['allowedStepTypes'];
      if (stProp?.type === 'array') {
        const stItems = stProp.items && !Array.isArray(stProp.items) ? stProp.items : {};
        discEnriched.properties = {
          ...discEnriched.properties,
          allowedStepTypes: { ...stProp, items: { ...stItems, enum: stepTypes } },
        };
      }

      const exclProp = discEnriched.properties['excludeOperationIds'];
      if (exclProp?.type === 'array') {
        const exclItems = exclProp.items && !Array.isArray(exclProp.items) ? exclProp.items : {};
        discEnriched.properties = {
          ...discEnriched.properties,
          excludeOperationIds: { ...exclProp, items: { ...exclItems, enum: opIds } },
        };
      }

      const exclGroupProp = discEnriched.properties['excludeGroupIds'];
      if (exclGroupProp?.type === 'array') {
        const grpItems =
          exclGroupProp.items && !Array.isArray(exclGroupProp.items) ? exclGroupProp.items : {};
        discEnriched.properties = {
          ...discEnriched.properties,
          excludeGroupIds: { ...exclGroupProp, items: { ...grpItems, enum: groupIds } },
        };
      }

      enriched.properties = { ...enriched.properties, discovery: discEnriched };
    }

    return enriched;
  }

  return prop;
}
