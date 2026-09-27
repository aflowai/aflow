import type { OutputPathSegment } from './outputPath.js';

/**
 * Where an output path stops matching a JSON Schema, if it does.
 *
 * `missing` is returned only when the schema closes the door: a key absent
 * from `properties` under `additionalProperties: false`, or an index into
 * something that is not an array. Anything the schema leaves open — no
 * properties, open additional properties, an untyped node — reads as `open`,
 * because a path the schema does not constrain is not a path it forbids.
 */
export type SchemaPathResult =
  { kind: 'found' } | { kind: 'open' } | { kind: 'missing'; at: string; available: string[] };

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function branches(schema: Schema): Schema[] | undefined {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list)) return list.map(asSchema).filter((s): s is Schema => !!s);
  }
  return undefined;
}

function describe(segments: readonly OutputPathSegment[]): string {
  return segments
    .map((s, i) => (s.kind === 'index' ? `[${String(s.index)}]` : i === 0 ? s.key : `.${s.key}`))
    .join('');
}

export function resolveSchemaPath(
  schema: Schema,
  segments: readonly OutputPathSegment[],
  consumed: readonly OutputPathSegment[] = [],
): SchemaPathResult {
  if (segments.length === 0) return { kind: 'found' };

  const alternatives = branches(schema);
  if (alternatives !== undefined) {
    const results = alternatives.map((branch) => resolveSchemaPath(branch, segments, consumed));
    if (results.some((r) => r.kind === 'found')) return { kind: 'found' };
    if (results.length === 0 || results.some((r) => r.kind === 'open')) return { kind: 'open' };
    const available = [
      ...new Set(results.flatMap((r) => (r.kind === 'missing' ? r.available : []))),
    ].sort();
    const first = results[0] as Extract<SchemaPathResult, { kind: 'missing' }>;
    return { kind: 'missing', at: first.at, available };
  }

  const [segment, ...rest] = segments as [OutputPathSegment, ...OutputPathSegment[]];
  const here = [...consumed, segment];

  if (segment.kind === 'index') {
    const items = schema['items'];
    if (Array.isArray(items)) {
      const item = asSchema(items[segment.index]);
      return item ? resolveSchemaPath(item, rest, here) : { kind: 'open' };
    }
    const item = asSchema(items);
    if (item) return resolveSchemaPath(item, rest, here);
    if (schema['type'] !== undefined && schema['type'] !== 'array') {
      return { kind: 'missing', at: describe(here), available: [] };
    }
    return { kind: 'open' };
  }

  const properties = asSchema(schema['properties']);
  const property = properties ? asSchema(properties[segment.key]) : undefined;
  if (property) return resolveSchemaPath(property, rest, here);

  const additional = schema['additionalProperties'];
  const additionalSchema = asSchema(additional);
  if (additionalSchema) return resolveSchemaPath(additionalSchema, rest, here);
  if (additional === false) {
    return {
      kind: 'missing',
      at: describe(here),
      available: properties ? Object.keys(properties).sort() : [],
    };
  }
  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    return { kind: 'missing', at: describe(here), available: [] };
  }
  return { kind: 'open' };
}
