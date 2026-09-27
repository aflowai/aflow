import type { OutlineNode } from '@aflow/schemas';

export type { OutlineNode };

// ============================================================================
// Outline
// ============================================================================

export interface OutlineOptions {
  /** Levels of children to expand below the root. Default 2. */
  maxDepth?: number;
  /** Max children emitted per object/array node. Default 50. */
  maxChildren?: number;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CHILDREN = 50;

function jsonType(value: unknown): OutlineNode['type'] {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'object') return 'object';
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  // bigint / symbol / function are not valid JSON — treat as null
  return 'null';
}

/**
 * JSON.stringify, but honest about its `string | undefined` runtime (undefined
 * for undefined/function/symbol; throws on circular refs → undefined here).
 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(safeStringify(value) ?? 'null', 'utf-8');
}

/**
 * Build a bounded structural outline of a JSON value. Returns the *shape*
 * (key, type, length, bytes) to `maxDepth` levels — never the data itself.
 */
export function buildOutline(value: unknown, opts: OutlineOptions = {}): OutlineNode {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChildren = opts.maxChildren ?? DEFAULT_MAX_CHILDREN;
  return buildNode(value, undefined, maxDepth, maxChildren);
}

function buildNode(
  value: unknown,
  key: string | undefined,
  remainingDepth: number,
  maxChildren: number,
): OutlineNode {
  const type = jsonType(value);
  const node: OutlineNode = { type, bytes: byteSize(value) };
  if (key !== undefined) node.key = key;

  if (type === 'string') {
    node.length = (value as string).length;
    return node;
  }

  if (type === 'array') {
    const arr = value as unknown[];
    node.length = arr.length;
    if (arr.length === 0) return node;
    if (remainingDepth <= 0) {
      node.truncatedChildren = true;
      return node;
    }
    const limit = Math.min(arr.length, maxChildren);
    const children: OutlineNode[] = [];
    for (let i = 0; i < limit; i++) {
      children.push(buildNode(arr[i], `[${String(i)}]`, remainingDepth - 1, maxChildren));
    }
    node.children = children;
    if (limit < arr.length) node.truncatedChildren = true;
    return node;
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    node.length = keys.length;
    if (keys.length === 0) return node;
    if (remainingDepth <= 0) {
      node.truncatedChildren = true;
      return node;
    }
    const limit = Math.min(keys.length, maxChildren);
    const children: OutlineNode[] = [];
    for (let i = 0; i < limit; i++) {
      const k = keys[i]!;
      children.push(buildNode(obj[k], k, remainingDepth - 1, maxChildren));
    }
    node.children = children;
    if (limit < keys.length) node.truncatedChildren = true;
    return node;
  }

  // number | boolean | null — scalar, no length/children
  return node;
}

// ============================================================================
// Path drilling
// ============================================================================

export type PathSegment = string | number;

/**
 * Parse a dotted/bracket path subset into segments.
 *
 * Supported: object keys (`a.b`), numeric array indices (`a[3]` or `a.3`),
 * and bracket-quoted keys (`a["weird.key"]`). An optional leading `$`/`.`
 * is ignored. This is intentionally NOT full JSONPath — no wildcards,
 * filters, slices, or recursion. It drills; it does not query.
 *
 * Throws on malformed input (unclosed bracket, non-integer index).
 */
export function parseDottedPath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const n = path.length;
  let i = 0;
  if (path[i] === '$') i++;

  while (i < n) {
    const ch = path[i];
    if (ch === '.') {
      i++;
      continue;
    }
    if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) {
        throw new Error(`Unclosed '[' in jsonPath at position ${String(i)}`);
      }
      const inner = path.slice(i + 1, close).trim();
      if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        segments.push(inner.slice(1, -1));
      } else {
        const idx = Number(inner);
        if (!Number.isInteger(idx) || idx < 0) {
          throw new Error(`Invalid array index '${inner}' in jsonPath`);
        }
        segments.push(idx);
      }
      i = close + 1;
      continue;
    }
    // Bare key — read until the next '.' or '['.
    let j = i;
    while (j < n && path[j] !== '.' && path[j] !== '[') j++;
    const key = path.slice(i, j);
    if (key.length > 0) segments.push(key);
    i = j;
  }

  return segments;
}

export interface SelectResult {
  found: boolean;
  value: unknown;
}

/**
 * Drill into a JSON value with a dotted/bracket path. An empty path (or `$`)
 * returns the root. Returns `{ found: false }` when any segment is missing or
 * the shape does not match (e.g. indexing a non-array).
 *
 * Forgiving on array access: both `arr[0]` and `arr.0` resolve to index 0.
 */
export function selectJsonPath(root: unknown, path: string): SelectResult {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '$') return { found: true, value: root };

  const segments = parseDottedPath(trimmed);
  let current: unknown = root;

  for (const seg of segments) {
    if (current === null || current === undefined) return { found: false, value: undefined };

    if (Array.isArray(current)) {
      const idx = typeof seg === 'number' ? seg : Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[idx];
      continue;
    }

    if (typeof current === 'object') {
      const obj = current as Record<string, unknown>;
      const k = String(seg);
      // Own-property only — never resolve inherited members (constructor,
      // toString, __proto__). Otherwise a path could select a Object.prototype
      // function, which a content read would JSON.stringify to undefined → crash.
      if (!Object.prototype.hasOwnProperty.call(obj, k)) {
        return { found: false, value: undefined };
      }
      current = obj[k];
      continue;
    }

    // Scalar reached before the path ended.
    return { found: false, value: undefined };
  }

  return { found: true, value: current };
}

// ============================================================================
// Array windowing
// ============================================================================

export interface WindowResult {
  items: unknown[];
  totalItems: number;
  hasMore: boolean;
}

/** Window an array into `[start, start+count)` with `hasMore`/`totalItems`. */
export function windowArray(value: unknown[], start: number, count: number): WindowResult {
  const totalItems = value.length;
  const items = value.slice(start, start + count);
  return {
    items,
    totalItems,
    hasMore: start + count < totalItems,
  };
}
