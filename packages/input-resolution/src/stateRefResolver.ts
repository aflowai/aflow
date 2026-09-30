import type { ResolutionError } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal interface for retrieving payloads.
 * Avoids importing the full PayloadStore.
 */
export interface PayloadRetriever {
  retrieve(ref: string): Promise<unknown>;
}

/**
 * Runtime state variable entry as stored in Redis hot state.
 */
export interface StateVariableEntry {
  ref?: {
    kind: string;
    value?: unknown;
    payloadRef?: string;
  };
}

/**
 * Runtime state variables map.
 */
export interface RuntimeStateVariables {
  variables: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const FORBIDDEN_POINTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ============================================================================
// JSON Pointer (RFC 6901)
// ============================================================================

/**
 * Unescape JSON Pointer segment per RFC 6901:
 *   ~1 → /
 *   ~0 → ~
 * Order matters: ~1 first, then ~0.
 */
function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

// ============================================================================

const PAYLOAD_REF_PATTERN = /^(gs:\/\/|inline:)/;

async function derefPayloadRef(ref: string, payloadStore: PayloadRetriever): Promise<unknown> {
  // PayloadStore stores raw data directly (no envelope wrapping).
  return payloadStore.retrieve(ref);
}

export async function applyJsonPointer(
  value: unknown,
  pointer: string,
  variableId: string,
  payloadStore?: PayloadRetriever,
): Promise<unknown> {
  if (pointer === '' || pointer === '/') {
    return value;
  }

  // Pointer must start with /
  if (!pointer.startsWith('/')) {
    return {
      code: 'STATE_REF_POINTER_ERROR' as const,
      message: `Invalid JSON Pointer '${pointer}': must start with '/'`,
      ref: `state.${variableId}`,
    };
  }

  const segments = pointer.slice(1).split('/').map(unescapePointerSegment);

  let current: unknown = value;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const remaining = segments.slice(i + 1);

    // Prototype pollution protection
    if (FORBIDDEN_POINTER_KEYS.has(segment)) {
      return {
        code: 'INPUT_REF_PROTOTYPE_POLLUTION' as const,
        message: `Forbidden key in pointer: ${segment}`,
        ref: `state.${variableId}${pointer}`,
      };
    }

    if (current === null || current === undefined) {
      return {
        code: 'STATE_REF_POINTER_ERROR' as const,
        message: `JSON Pointer '${pointer}' could not be resolved in variable '${variableId}': value is ${String(current)} at segment '${segment}'`,
        ref: `state.${variableId}`,
      };
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) {
        return {
          code: 'STATE_REF_POINTER_ERROR' as const,
          message: `JSON Pointer '${pointer}' could not be resolved in variable '${variableId}': '${segment}' is not a valid array index`,
          ref: `state.${variableId}`,
        };
      }
      if (index >= current.length) {
        return {
          code: 'STATE_REF_POINTER_ERROR' as const,
          message: `JSON Pointer '${pointer}' could not be resolved in variable '${variableId}': index ${String(index)} out of bounds (length ${String(current.length)})`,
          ref: `state.${variableId}`,
        };
      }
      current = current[index];
      continue;
    }

    if (typeof current !== 'object') {
      return {
        code: 'STATE_REF_POINTER_ERROR' as const,
        message: `JSON Pointer '${pointer}' could not be resolved in variable '${variableId}': cannot traverse ${typeof current}`,
        ref: `state.${variableId}`,
      };
    }

    const obj = current as Record<string, unknown>;

    // 1. Check <field>Ref sibling (e.g., body → bodyRef, content → contentRef)
    if (payloadStore) {
      const siblingRef = obj[`${segment}Ref`];
      if (typeof siblingRef === 'string' && PAYLOAD_REF_PATTERN.test(siblingRef)) {
        try {
          const full = await derefPayloadRef(siblingRef, payloadStore);
          if (remaining.length === 0) return full;
          return await applyJsonPointer(full, '/' + remaining.join('/'), variableId, payloadStore);
        } catch {
          /* fall through to inline value */
        }
      }
    }

    // 2. Check generic dataRef fallback (compute stores {data, stderr} under dataRef)
    if (!(segment in obj) || obj[segment] === undefined) {
      if (payloadStore) {
        const genericRef = obj['dataRef'];
        if (typeof genericRef === 'string' && PAYLOAD_REF_PATTERN.test(genericRef)) {
          try {
            const full = await derefPayloadRef(genericRef, payloadStore);
            if (
              full != null &&
              typeof full === 'object' &&
              segment in (full as Record<string, unknown>)
            ) {
              const val = (full as Record<string, unknown>)[segment];
              if (remaining.length === 0) return val;
              return await applyJsonPointer(
                val,
                '/' + remaining.join('/'),
                variableId,
                payloadStore,
              );
            }
          } catch {
            /* fall through */
          }
        }
      }
      return {
        code: 'STATE_REF_POINTER_ERROR' as const,
        message: `JSON Pointer '${pointer}' could not be resolved in variable '${variableId}': key '${segment}' not found`,
        ref: `state.${variableId}`,
      };
    }

    // 3. Direct value — also check if the VALUE itself is a PayloadRef string
    //    (used by outputFiles where the value is "gs://..." directly)
    const val = obj[segment];
    if (payloadStore && typeof val === 'string' && PAYLOAD_REF_PATTERN.test(val)) {
      try {
        const full = await derefPayloadRef(val, payloadStore);
        if (remaining.length === 0) return full;
        return await applyJsonPointer(full, '/' + remaining.join('/'), variableId, payloadStore);
      } catch {
        /* fall through to raw value */
      }
    }

    current = val;
  }

  return current;
}

// ============================================================================
// $ref Object Detection
// ============================================================================

/**
 * Check if a value is a platform ref object: `{ "$ref": "state.xxx" }` or `{ "$ref": "output.xxx" }`.
 * Must have exactly one key `$ref` with a string value starting with `state.` or `output.`.
 */
export function isStateRef(value: unknown): value is { $ref: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== '$ref') {
    return false;
  }
  const refVal = (value as Record<string, unknown>)['$ref'];
  return (
    typeof refVal === 'string' && (refVal.startsWith('state.') || refVal.startsWith('output.'))
  );
}

/**
 * Detect a `$ref` object whose key the model wrapped in stray punctuation —
 * Gemini flash in particular emits `'"$ref"'`, `'«$ref»'`, or `` '`$ref`' ``
 * (backticks) instead of a clean `'$ref'`. Strips every non-`[\w$]` wrapper char
 * and, if what remains is exactly `$ref` and the value is a real `state.`/`output.`
 * ref string, returns the canonical `{ $ref }` object; otherwise returns `null`.
 *
 * Handles the clean `$ref` case too, so callers can use it as a single detector.
 * The trailing {@link isStateRef} guard means ordinary single-key data objects
 * (e.g. `{ price: '...' }`) never match. Shared by {@link resolveRefsRecursive}
 * (to repair the key before resolution) and by output-validation error reporting
 * (to explain that an unresolved ref reached the schema check).
 */
export function normalizeMangledRef(value: unknown): { $ref: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) {
    return null;
  }
  const key = keys[0]!;
  if (key !== '$ref' && key.replace(/[^\w$]/g, '') !== '$ref') {
    return null;
  }
  const candidate = { $ref: (value as Record<string, unknown>)[key] };
  return isStateRef(candidate) ? candidate : null;
}

/**
 * Parse a `$ref` string into variable ID and optional JSON Pointer.
 *
 * Examples:
 *   "state.result"            → { variableId: "result", pointer: undefined }
 *   "state.result/data/items" → { variableId: "result", pointer: "/data/items" }
 */
function parseStateRefString(ref: string): { variableId: string; pointer?: string } {
  const afterState = ref.slice(6); // Remove "state."
  const slashIndex = afterState.indexOf('/');
  if (slashIndex === -1) {
    return { variableId: afterState };
  }
  return {
    variableId: afterState.slice(0, slashIndex),
    pointer: '/' + afterState.slice(slashIndex + 1),
  };
}

// ============================================================================
// State Ref Resolution
// ============================================================================

/**
 * Resolve a state variable reference string (e.g., "state.result" or "state.result/data/0").
 * Retrieves the variable value from runtime state (inline or PayloadStore-backed)
 * and optionally applies a JSON Pointer.
 */
export async function resolveStateRef(
  ref: string,
  runtimeState: RuntimeStateVariables | undefined,
  payloadStore: PayloadRetriever,
): Promise<unknown> {
  const { variableId, pointer } = parseStateRefString(ref);

  if (!runtimeState?.variables) {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `State variable '${variableId}' not found (no runtime state)`,
      ref,
    };
  }

  const varEntry = runtimeState.variables[variableId] as StateVariableEntry | undefined;
  if (!varEntry?.ref) {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `State variable '${variableId}' not found`,
      ref,
    };
  }

  // Retrieve the value
  let value: unknown;
  if (varEntry.ref.kind === 'inline') {
    value = varEntry.ref.value;
  } else if (varEntry.ref.kind === 'ref' && varEntry.ref.payloadRef) {
    value = await payloadStore.retrieve(varEntry.ref.payloadRef);
  } else {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `State variable '${variableId}' has no value`,
      ref,
    };
  }

  // Apply JSON Pointer if present
  if (pointer) {
    return await applyJsonPointer(value, pointer, variableId, payloadStore);
  }

  return value;
}

// ============================================================================
// Output Ref Resolution (per-tool-call)
// ============================================================================

/** Runtime state key for the tool output index */
export const TOOL_OUTPUT_INDEX_KEY = '_tool_outputs';

/**
 * Parse an `output.*` ref string into toolCallId and optional JSON Pointer.
 *
 * Examples:
 *   "output.call_abc123"            → { toolCallId: "call_abc123", pointer: undefined }
 *   "output.call_abc123/data/items" → { toolCallId: "call_abc123", pointer: "/data/items" }
 */
function parseOutputRefString(ref: string): { toolCallId: string; pointer?: string } {
  const afterOutput = ref.slice(7); // Remove "output."
  const slashIndex = afterOutput.indexOf('/');
  if (slashIndex === -1) {
    return { toolCallId: afterOutput };
  }
  return {
    toolCallId: afterOutput.slice(0, slashIndex),
    pointer: '/' + afterOutput.slice(slashIndex + 1),
  };
}

/**
 * Resolve an output ref: `output.<toolCallId>` or `output.<toolCallId>/pointer`.
 * Looks up the toolCallId in the `_tool_outputs` index variable, retrieves the
 * PayloadStore ref, and optionally applies a JSON Pointer.
 */
export async function resolveOutputRef(
  ref: string,
  runtimeState: RuntimeStateVariables | undefined,
  payloadStore: PayloadRetriever,
): Promise<unknown> {
  const { toolCallId, pointer } = parseOutputRefString(ref);

  if (!runtimeState?.variables) {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `Tool output '${toolCallId}' not found (no runtime state)`,
      ref,
    };
  }

  // Read the output index from runtime state
  const indexEntry = runtimeState.variables[TOOL_OUTPUT_INDEX_KEY] as
    StateVariableEntry | undefined;
  let index: Record<string, unknown> | undefined;
  if (indexEntry?.ref?.kind === 'inline' && typeof indexEntry.ref.value === 'object') {
    index = indexEntry.ref.value as Record<string, unknown>;
  }

  if (!index) {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `Tool output '${toolCallId}' not found (no output index)`,
      ref,
    };
  }

  const rawEntry = index[toolCallId];
  if (!rawEntry) {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `Tool output '${toolCallId}' not found in output index`,
      ref,
    };
  }

  let payloadRef: string | undefined;
  if (typeof rawEntry === 'string') {
    payloadRef = rawEntry;
  } else if (typeof rawEntry === 'object' && rawEntry !== null) {
    const obj = rawEntry as Record<string, unknown>;
    if ('ref' in obj && typeof obj['ref'] === 'string') {
      payloadRef = obj['ref'];
    }
  }
  if (!payloadRef) {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `Tool output '${toolCallId}' not found in output index`,
      ref,
    };
  }

  // Retrieve from PayloadStore
  let value: unknown;
  try {
    value = await payloadStore.retrieve(payloadRef);
  } catch {
    return {
      code: 'STATE_REF_NOT_FOUND' as const,
      message: `Failed to retrieve tool output '${toolCallId}' from payload store`,
      ref,
    };
  }

  // Apply JSON Pointer if present
  if (pointer) {
    return await applyJsonPointer(value, pointer, `output.${toolCallId}`, payloadStore);
  }

  return value;
}

// ============================================================================
// Recursive Ref Resolution
// ============================================================================

export function isResolutionError(value: unknown): value is ResolutionError {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'message' in value &&
    typeof (value as Record<string, unknown>)['code'] === 'string' &&
    typeof (value as Record<string, unknown>)['message'] === 'string'
  );
}

/** Pattern for matching ${state.*} references, with optional JSON Pointer. */
const STATE_REF_STRING_FULL = /^\$\{(state\.[^}]+)\}$/;
const STATE_REF_STRING_EMBEDDED = /\$\{(state\.[^}]+)\}/g;

/**
 * Recursively resolve all `{ "$ref": "state.xxx" }` objects and `${state.xxx}` strings
 * in a value tree. Single pass, no re-entry — resolved values are treated as opaque data.
 *
 * @param value - The value to walk (object, array, or primitive)
 * @param runtimeState - Runtime state variables
 * @param payloadStore - For retrieving PayloadStore-backed variables
 * @returns The resolved value, or throws on resolution errors
 */
export async function resolveRefsRecursive(
  value: unknown,
  runtimeState: RuntimeStateVariables | undefined,
  payloadStore: PayloadRetriever,
): Promise<unknown> {
  return walkAndResolve(value, runtimeState, payloadStore, 0);
}

const MAX_WALK_DEPTH = 20;

const MAX_STRING_REF_DEPTH = 3;

function containsRef(value: unknown, depth: number): boolean {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== 'object') return false;
  if (normalizeMangledRef(value)) return true;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.some((child) => containsRef(child, depth + 1));
}

async function walkAndResolve(
  value: unknown,
  runtimeState: RuntimeStateVariables | undefined,
  payloadStore: PayloadRetriever,
  depth: number,
): Promise<unknown> {
  if (depth > MAX_WALK_DEPTH) {
    return value; // Safety limit — don't recurse infinitely
  }

  // Repair $ref keys the model mangled with stray punctuation ('"$ref"', «$ref»,
  // `$ref`) so they resolve like a clean ref. normalizeMangledRef only rewrites
  // genuine state./output. refs, so ordinary single-key data objects fall through.
  const maybeRef = normalizeMangledRef(value);
  if (maybeRef) {
    value = maybeRef;
  }

  // Check for $ref object BEFORE recursing into its properties
  // ($ref objects are resolved at ANY depth — that's their design purpose)
  if (isStateRef(value)) {
    const refString = value.$ref;
    const resolved = refString.startsWith('output.')
      ? await resolveOutputRef(refString, runtimeState, payloadStore)
      : await resolveStateRef(refString, runtimeState, payloadStore);
    if (isResolutionError(resolved)) {
      throw new StateRefError(resolved);
    }
    // Do NOT recurse into the resolved value (no re-entry)
    return resolved;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const results: unknown[] = [];
    for (const item of value) {
      results.push(await walkAndResolve(item, runtimeState, payloadStore, depth + 1));
    }
    return results;
  }

  // Handle objects
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = await walkAndResolve(val, runtimeState, payloadStore, depth + 1);
    }
    return result;
  }

  // Handle strings — only resolve ${state.xxx} patterns at shallow depths.
  // Deep strings are treated as opaque data (may contain ${...} patterns that
  // belong to a data payload, not to the current run's state).
  if (typeof value === 'string') {
    // Defensive: detect stringified $ref objects (e.g. '{ "$ref": "state.result" }')
    // Some models (Gemini) stringify the $ref object instead of nesting it as JSON.
    // This is resolved at ANY depth (same as $ref objects).
    if (value.includes('"$ref"') && (value.includes('state.') || value.includes('output.'))) {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isStateRef(parsed)) {
            const refString = (parsed as { $ref: string }).$ref;
            const resolved = refString.startsWith('output.')
              ? await resolveOutputRef(refString, runtimeState, payloadStore)
              : await resolveStateRef(refString, runtimeState, payloadStore);
            if (isResolutionError(resolved)) {
              throw new StateRefError(resolved);
            }
            return resolved;
          }
          // A stringified argument holding a reference below its top level
          // (`'{"patch": {"$ref": "output.x/patch"}}'`) is the object the
          // model meant: left a string, the reference never resolves and the
          // whole argument reaches validation as text.
          if (containsRef(parsed, 0)) {
            return await walkAndResolve(parsed, runtimeState, payloadStore, depth);
          }
        } catch (e) {
          if (e instanceof StateRefError) throw e;
          // Not valid JSON or not a ref — fall through to normal string handling
        }
      }
    }

    // ${state.xxx} string patterns — only at shallow depth
    if (depth < MAX_STRING_REF_DEPTH) {
      // Full ref — preserve type
      const fullMatch = STATE_REF_STRING_FULL.exec(value);
      if (fullMatch?.[1]) {
        const resolved = await resolveStateRef(fullMatch[1], runtimeState, payloadStore);
        if (isResolutionError(resolved)) {
          throw new StateRefError(resolved);
        }
        return resolved;
      }

      // Interpolation — resolve embedded refs, stringify
      if (value.includes('${state.')) {
        STATE_REF_STRING_EMBEDDED.lastIndex = 0;
        const parts: string[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = STATE_REF_STRING_EMBEDDED.exec(value)) !== null) {
          // Add literal part before this match
          if (match.index > lastIndex) {
            parts.push(value.slice(lastIndex, match.index));
          }

          const refContent = match[1]!;
          const resolved = await resolveStateRef(refContent, runtimeState, payloadStore);
          if (isResolutionError(resolved)) {
            throw new StateRefError(resolved);
          }

          // Stringify for interpolation
          if (typeof resolved === 'string') {
            parts.push(resolved);
          } else if (resolved === null || resolved === undefined) {
            parts.push('');
          } else if (typeof resolved === 'object') {
            parts.push(JSON.stringify(resolved));
          } else {
            parts.push(String(resolved as number | boolean | bigint | symbol));
          }

          lastIndex = match.index + match[0].length;
        }

        // Add trailing literal
        if (lastIndex < value.length) {
          parts.push(value.slice(lastIndex));
        }

        return parts.join('');
      }
    }
  }

  // Primitives pass through (including deep strings with ${...} patterns)
  return value;
}

// ============================================================================
// Error class
// ============================================================================

/**
 * Error thrown when a state ref cannot be resolved.
 * Contains the structured ResolutionError for the caller to handle.
 */
export class StateRefError extends Error {
  readonly resolutionError: ResolutionError;

  constructor(error: ResolutionError) {
    super(error.message);
    this.name = 'StateRefError';
    this.resolutionError = error;
  }
}
