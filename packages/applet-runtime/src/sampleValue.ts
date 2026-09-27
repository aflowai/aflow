/**
 * Deterministic minimal-value synthesis over the declared applet schema
 * dialect — required members only, minimum lengths and bounds, first enum
 * entries, smallest string a `pattern` admits.
 *
 * The conformance gate replays every template action against a synthesized
 * input and seeds initial state from the state schema with the same
 * machinery, so a dialect construct this cannot satisfy is a construct no
 * definition can be checked through.
 */
import { APPLET_INPUT_MAX_BYTES, APPLET_JSON_MAX_DEPTH } from '@aflow/schemas';
import { isJsonRecord } from './json.js';
import { sampleStringForPattern } from './patternSample.js';
import { resolveJsonPointer } from './pointer.js';

export class UnsatisfiableSampleError extends Error {}

/**
 * A synthesized member serializes to at least ~8 bytes, so any requirement
 * above this count could never fit APPLET_INPUT_MAX_BYTES at act time anyway.
 */
const SYNTH_MAX_MEMBERS = Math.floor(APPLET_INPUT_MAX_BYTES / 8);

function numberKeyword(node: Record<string, unknown>, keyword: string): number | undefined {
  const value = node[keyword];
  return typeof value === 'number' ? value : undefined;
}

function arrayKeyword(node: Record<string, unknown>, keyword: string): unknown[] | undefined {
  const value = node[keyword];
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

function inferType(node: Record<string, unknown>): string {
  const objectKeywords = [
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'minProperties',
    'maxProperties',
  ];
  if (objectKeywords.some((keyword) => keyword in node)) return 'object';
  const arrayKeywords = ['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems'];
  if (arrayKeywords.some((keyword) => keyword in node)) return 'array';
  const stringKeywords = ['minLength', 'maxLength', 'pattern'];
  if (stringKeywords.some((keyword) => keyword in node)) return 'string';
  const numberKeywords = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ];
  if (numberKeywords.some((keyword) => keyword in node)) return 'number';
  return 'object';
}

export function mergeAppletSchemas(nodes: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  let properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const node of nodes) {
    if (node === true || node === undefined) continue;
    if (!isJsonRecord(node)) throw new UnsatisfiableSampleError();
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === 'properties' && isJsonRecord(value)) {
        properties = { ...properties, ...value };
      } else if (keyword === 'required' && Array.isArray(value)) {
        for (const name of value) {
          if (typeof name === 'string') required.add(name);
        }
      } else {
        merged[keyword] = value;
      }
    }
  }
  if (Object.keys(properties).length > 0) merged['properties'] = properties;
  if (required.size > 0) merged['required'] = [...required];
  return merged;
}

function memberSchema(node: Record<string, unknown>, name: string): unknown {
  const properties = isJsonRecord(node['properties']) ? node['properties'] : {};
  if (name in properties) return properties[name];
  const additional = node['additionalProperties'];
  if (additional === false) throw new UnsatisfiableSampleError();
  return additional ?? true;
}

/** No ceiling was named, so the window is open above. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * A number inside every bound the schema names, or nothing when the bounds
 * enclose no number at all.
 *
 * Both ends have to be read. A sample that satisfies the lower bound and
 * overshoots the upper one is not a sample — conformance validates what this
 * returns, so it reports the action's own schema as unsatisfiable and refuses
 * to publish an applet whose schema was fine.
 */
function synthesizeMinimalNumber(node: Record<string, unknown>, integer: boolean): number {
  const multipleOf = numberKeyword(node, 'multipleOf');
  // The smallest step a value may move by. A plain number has none, so it can
  // sit anywhere in the window.
  const step = multipleOf !== undefined && multipleOf > 0 ? multipleOf : integer ? 1 : 0;

  const minimum = numberKeyword(node, 'minimum');
  const exclusiveMinimum = numberKeyword(node, 'exclusiveMinimum');
  const maximum = numberKeyword(node, 'maximum');
  const exclusiveMaximum = numberKeyword(node, 'exclusiveMaximum');

  const ceiling = maximum ?? exclusiveMaximum ?? UNBOUNDED;
  const ceilingIsExclusive = maximum === undefined && exclusiveMaximum !== undefined;
  // Zero is the natural start, but a schema bounded only from above starts at
  // its ceiling instead — zero is outside a window that ends below it.
  const floor = minimum ?? exclusiveMinimum ?? Math.min(0, ceiling);

  let value = step > 0 ? Math.ceil(floor / step) * step : floor;
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
    value =
      step > 0
        ? value + step
        : ceiling === UNBOUNDED
          ? exclusiveMinimum + 1
          : (exclusiveMinimum + ceiling) / 2;
  }

  if (value > ceiling || (ceilingIsExclusive && value >= ceiling)) {
    throw new UnsatisfiableSampleError();
  }
  return value;
}

function synthesizeString(node: Record<string, unknown>): string {
  const minLength = numberKeyword(node, 'minLength') ?? 0;
  if (minLength > APPLET_INPUT_MAX_BYTES) throw new UnsatisfiableSampleError();
  const pattern = node['pattern'];
  if (typeof pattern === 'string') {
    const sample = sampleStringForPattern(pattern, minLength);
    if (sample === undefined) throw new UnsatisfiableSampleError();
    return sample;
  }
  return 'a'.repeat(minLength);
}

/** A filler key must satisfy `propertyNames` or the object it pads is invalid. */
function fillerKey(node: Record<string, unknown>, ordinal: number): string {
  const propertyNames = node['propertyNames'];
  if (isJsonRecord(propertyNames)) {
    const pattern = propertyNames['pattern'];
    const minLength = numberKeyword(propertyNames, 'minLength') ?? 0;
    if (typeof pattern === 'string') {
      const sample = sampleStringForPattern(pattern, Math.max(minLength, ordinal + 1));
      if (sample === undefined) throw new UnsatisfiableSampleError();
      return sample;
    }
  }
  return `key${String(ordinal)}`;
}

function synthesizeNode(node: unknown, root: unknown, depth: number): unknown {
  if (depth > APPLET_JSON_MAX_DEPTH) throw new UnsatisfiableSampleError();
  if (node === true) return {};
  if (node === false || !isJsonRecord(node)) throw new UnsatisfiableSampleError();

  if ('const' in node && node['const'] !== undefined) return structuredClone(node['const']);
  const enumValues = node['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) return structuredClone(enumValues[0]);

  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (!ref.startsWith('#')) throw new UnsatisfiableSampleError();
    const resolved = resolveJsonPointer(root, ref.slice(1));
    if (!resolved.found) throw new UnsatisfiableSampleError();
    return synthesizeNode(resolved.value, root, depth + 1);
  }

  const allOf = arrayKeyword(node, 'allOf');
  const anyOf = arrayKeyword(node, 'anyOf');
  const oneOf = arrayKeyword(node, 'oneOf');
  if (allOf !== undefined || anyOf !== undefined || oneOf !== undefined) {
    const rest: Record<string, unknown> = { ...node };
    delete rest['allOf'];
    delete rest['anyOf'];
    delete rest['oneOf'];
    const parts: unknown[] = [rest, ...(allOf ?? [])];
    const firstBranch = anyOf !== undefined ? anyOf[0] : oneOf?.[0];
    if (firstBranch !== undefined) parts.push(firstBranch);
    return synthesizeNode(mergeAppletSchemas(parts), root, depth + 1);
  }

  const rawType = node['type'];
  const type =
    typeof rawType === 'string'
      ? rawType
      : Array.isArray(rawType) && typeof rawType[0] === 'string'
        ? rawType[0]
        : inferType(node);

  switch (type) {
    case 'object': {
      const result: Record<string, unknown> = {};
      const required = Array.isArray(node['required'])
        ? node['required'].filter((name): name is string => typeof name === 'string')
        : [];
      if (required.length > SYNTH_MAX_MEMBERS) throw new UnsatisfiableSampleError();
      for (const name of required) {
        result[name] = synthesizeNode(memberSchema(node, name), root, depth + 1);
      }
      const minProperties = numberKeyword(node, 'minProperties') ?? 0;
      if (minProperties > SYNTH_MAX_MEMBERS) throw new UnsatisfiableSampleError();
      if (Object.keys(result).length < minProperties) {
        const properties = isJsonRecord(node['properties']) ? node['properties'] : {};
        for (const name of Object.keys(properties)) {
          if (Object.keys(result).length >= minProperties) break;
          if (name in result) continue;
          result[name] = synthesizeNode(properties[name], root, depth + 1);
        }
        let filler = 0;
        while (Object.keys(result).length < minProperties) {
          const additional = node['additionalProperties'];
          if (additional === false) throw new UnsatisfiableSampleError();
          const key = fillerKey(node, filler);
          if (key in result) throw new UnsatisfiableSampleError();
          result[key] = synthesizeNode(additional ?? true, root, depth + 1);
          filler++;
        }
      }
      return result;
    }
    case 'array': {
      const minItems = numberKeyword(node, 'minItems') ?? 0;
      if (minItems > SYNTH_MAX_MEMBERS) throw new UnsatisfiableSampleError();
      const prefixItems = arrayKeyword(node, 'prefixItems') ?? [];
      const result: unknown[] = [];
      for (let i = 0; i < minItems; i++) {
        const sub = prefixItems[i] ?? node['items'] ?? true;
        let element = synthesizeNode(sub, root, depth + 1);
        if (node['uniqueItems'] === true && i > 0) {
          if (typeof element === 'number') element = element + i;
          else if (typeof element === 'string') element = `${element}${String(i)}`;
        }
        result.push(element);
      }
      return result;
    }
    case 'string':
      return synthesizeString(node);
    case 'integer':
      return synthesizeMinimalNumber(node, true);
    case 'number':
      return synthesizeMinimalNumber(node, false);
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      throw new UnsatisfiableSampleError();
  }
}

/**
 * Smallest value the schema node admits, resolving `$ref` against `root`.
 * Throws UnsatisfiableSampleError when the dialect subset defeats synthesis;
 * the result is NOT guaranteed valid — validate it before use.
 */
export function synthesizeMinimalAppletValue(node: unknown, root: unknown): unknown {
  return synthesizeNode(node, root, 0);
}

/**
 * Deterministically synthesize the smallest input a schema admits. Returns
 * undefined when the dialect subset defeats synthesis; the result is NOT
 * guaranteed valid — validate it against the schema before use.
 */
export function synthesizeMinimalAppletInput(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let sample: unknown;
  try {
    sample = synthesizeNode(inputSchema, inputSchema, 0);
  } catch (err) {
    if (err instanceof UnsatisfiableSampleError) return undefined;
    throw err;
  }
  return isJsonRecord(sample) ? sample : undefined;
}
