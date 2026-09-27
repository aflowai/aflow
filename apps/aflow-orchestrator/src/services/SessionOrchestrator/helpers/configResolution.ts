import type { SessionHotState } from '@aflow/redis';

// ============================================================================
// Config Value Resolution — ${...} syntax
// ============================================================================

/** Regex for a single full reference: entire value is "${...}" */
const FULL_REF_RE = /^\$\{([^}]+)\}$/;
/** Regex for embedded references in a string */
const EMBEDDED_REF_RE = /\$\{([^}]+)\}/g;

/**
 * Protect backtick-wrapped code sections from ${...} resolution.
 * Replaces fenced code blocks (```...```) and inline code (`...`) with
 * placeholders, returning the extracted sections for later restoration.
 *
 * This allows system prompts to contain examples like:
 *   Reference state with `${state.variableName}`
 * without the resolver treating them as real references.
 */
function protectCodeSections(value: string): { cleaned: string; sections: string[] } {
  const sections: string[] = [];
  // Fenced code blocks first (``` ... ```), then inline code (` ... `)
  const cleaned = value
    .replace(/```[\s\S]*?```/g, (match) => {
      sections.push(match);
      return `\x00CODE${String(sections.length - 1)}\x00`;
    })
    .replace(/`[^`]+`/g, (match) => {
      sections.push(match);
      return `\x00CODE${String(sections.length - 1)}\x00`;
    });
  return { cleaned, sections };
}

/** Restore protected code sections from placeholders. */
function restoreCodeSections(value: string, sections: string[]): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x00CODE(\d+)\x00/g, (_, idx: string) => sections[parseInt(idx, 10)] ?? '');
}

/**
 * Resolve a bare reference expression (the content inside ${...}).
 * Supported forms:
 *   - "input.<field>"      → rawInput[field]
 *   - "state.<variableId>" → runtimeState variable value (inline or payloadRef)
 */
export function resolveRef(
  ref: string,
  rawInput: Record<string, unknown>,
  runtimeState?: SessionHotState['runtimeState'],
): unknown {
  if (ref.startsWith('input.')) {
    return rawInput[ref.slice(6)];
  }

  if (ref.startsWith('state.') && runtimeState?.variables) {
    const varId = ref.slice(6);
    const varEntry = runtimeState.variables[varId] as
      | {
          ref?: { kind: string; value?: unknown; payloadRef?: string };
        }
      | undefined;
    if (varEntry?.ref?.kind === 'inline') {
      return varEntry.ref.value;
    }
    if (varEntry?.ref?.kind === 'ref' && varEntry.ref.payloadRef) {
      return varEntry.ref.payloadRef;
    }
  }

  // Unknown ref — return undefined (not found)
  return undefined;
}

/**
 * Resolve a single config value that may contain ${...} references.
 *
 * - Full ref  `"${state.x}"`              → typed value (object, array, etc.)
 * - Interpolation `"Hello ${state.name}"`  → concatenated string
 * - Code-protected `` "`${state.x}`" ``   → literal text (not resolved)
 * - Non-string values                      → passed through unchanged
 */
export function resolveConfigValue(
  value: unknown,
  rawInput: Record<string, unknown>,
  runtimeState?: SessionHotState['runtimeState'],
): unknown {
  if (typeof value !== 'string') return value;

  // Full reference — resolve to typed value
  const fullMatch = FULL_REF_RE.exec(value);
  if (fullMatch?.[1]) {
    const resolved = resolveRef(fullMatch[1].trim(), rawInput, runtimeState);
    return resolved; // may be undefined if not found
  }

  // String interpolation — resolve embedded ${...} references
  if (value.includes('${')) {
    // Protect backtick-wrapped code sections before resolving
    const { cleaned, sections } = protectCodeSections(value);
    const resolved = cleaned.replace(EMBEDDED_REF_RE, (_, inner: string) => {
      const result = resolveRef(inner.trim(), rawInput, runtimeState);
      if (result === undefined || result === null) return '';
      return typeof result === 'object'
        ? JSON.stringify(result)
        : String(result as string | number | boolean | bigint | symbol);
    });
    return restoreCodeSections(resolved, sections);
  }

  // Plain string — return as-is
  return value;
}

/**
 * Recursively resolve all ${...} references in a config object/array.
 * Walks through nested objects and arrays, resolving string values.
 */
export function resolveConfigRecursive(
  value: unknown,
  rawInput: Record<string, unknown>,
  runtimeState?: SessionHotState['runtimeState'],
  depth = 0,
): unknown {
  if (depth > 10) return value; // Safety limit

  if (typeof value === 'string') {
    return resolveConfigValue(value, rawInput, runtimeState);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigRecursive(item, rawInput, runtimeState, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveConfigRecursive(val, rawInput, runtimeState, depth + 1);
    }
    return result;
  }

  // numbers, booleans, null pass through
  return value;
}

/**
 * Collect the rawInput keys consumed by ${input.*} references anywhere in a
 * config value. Mirrors resolveConfigRecursive's traversal: nested objects and
 * arrays are walked, backtick-wrapped code sections are ignored, both full and
 * embedded references count.
 */
export function collectBoundInputKeys(value: unknown, depth = 0): Set<string> {
  const keys = new Set<string>();
  if (depth > 10) return keys;

  if (typeof value === 'string') {
    if (!value.includes('${')) return keys;
    const { cleaned } = protectCodeSections(value);
    EMBEDDED_REF_RE.lastIndex = 0;
    for (const match of cleaned.matchAll(EMBEDDED_REF_RE)) {
      const inner = match[1]?.trim();
      if (inner?.startsWith('input.')) {
        keys.add(inner.slice(6));
      }
    }
    return keys;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const key of collectBoundInputKeys(item, depth + 1)) keys.add(key);
    }
    return keys;
  }

  if (value !== null && typeof value === 'object') {
    for (const val of Object.values(value as Record<string, unknown>)) {
      for (const key of collectBoundInputKeys(val, depth + 1)) keys.add(key);
    }
  }

  return keys;
}

/**
 * Check if any string values in a config object contain ${...} references.
 * Ignores references inside backtick-wrapped code sections.
 */
export function configHasRefs(config: Record<string, unknown>): boolean {
  for (const val of Object.values(config)) {
    if (typeof val === 'string' && val.includes('${')) {
      const { cleaned } = protectCodeSections(val);
      if (EMBEDDED_REF_RE.test(cleaned)) {
        EMBEDDED_REF_RE.lastIndex = 0; // Reset global regex
        return true;
      }
    }
    if (val !== null && typeof val === 'object') {
      if (configHasRefs(val as Record<string, unknown>)) return true;
    }
  }
  return false;
}

// ============================================================================
// Dry-run resolution — gating support
// ============================================================================

/** Result of resolving config with unresolved-ref tracking. */
export interface ResolutionResult {
  /** The resolved value (same as resolveConfigRecursive output) */
  resolved: unknown;
  /** State variable IDs that could not be resolved (${state.X} where X is missing) */
  unresolvedStateRefs: string[];
}

/**
 * Resolve a bare reference with tracking of unresolved state refs.
 * Same logic as resolveRef but collects missing ${state.X} variable IDs.
 */
function resolveRefWithReport(
  ref: string,
  rawInput: Record<string, unknown>,
  runtimeState: SessionHotState['runtimeState'] | undefined,
  unresolved: Set<string>,
): unknown {
  if (ref.startsWith('input.')) {
    return rawInput[ref.slice(6)];
  }

  if (ref.startsWith('state.')) {
    const varId = ref.slice(6);
    if (runtimeState?.variables) {
      const varEntry = runtimeState.variables[varId] as
        | {
            ref?: { kind: string; value?: unknown; payloadRef?: string };
          }
        | undefined;
      if (varEntry?.ref?.kind === 'inline' && varEntry.ref.value !== undefined) {
        return varEntry.ref.value;
      }
      if (varEntry?.ref?.kind === 'ref' && varEntry.ref.payloadRef) {
        return varEntry.ref.payloadRef;
      }
    }
    // State variable is missing or has undefined value
    unresolved.add(varId);
    return undefined;
  }

  return undefined;
}

/**
 * Resolve a single config value with tracking of unresolved state refs.
 * Backtick-wrapped code sections are protected from resolution.
 */
function resolveConfigValueWithReport(
  value: unknown,
  rawInput: Record<string, unknown>,
  runtimeState: SessionHotState['runtimeState'] | undefined,
  unresolved: Set<string>,
): unknown {
  if (typeof value !== 'string') return value;

  const fullMatch = FULL_REF_RE.exec(value);
  if (fullMatch?.[1]) {
    return resolveRefWithReport(fullMatch[1].trim(), rawInput, runtimeState, unresolved);
  }

  if (value.includes('${')) {
    const { cleaned, sections } = protectCodeSections(value);
    const resolved = cleaned.replace(EMBEDDED_REF_RE, (_, inner: string) => {
      const result = resolveRefWithReport(inner.trim(), rawInput, runtimeState, unresolved);
      if (result === undefined || result === null) return '';
      return typeof result === 'object'
        ? JSON.stringify(result)
        : String(result as string | number | boolean | bigint | symbol);
    });
    return restoreCodeSections(resolved, sections);
  }

  return value;
}

/**
 * Recursively resolve all ${...} references in a config, collecting unresolved
 * ${state.X} variable IDs. This is a "dry-run" mode of the resolver — same
 * code path as resolveConfigRecursive, ensuring gating and resolution never diverge.
 *
 * Use this before scheduling a step to check if all required state variables
 * are available. If unresolvedStateRefs is non-empty, the step should not execute.
 */
export function resolveConfigRecursiveWithReport(
  value: unknown,
  rawInput: Record<string, unknown>,
  runtimeState?: SessionHotState['runtimeState'],
): ResolutionResult {
  const unresolved = new Set<string>();

  function walk(v: unknown, depth: number): unknown {
    if (depth > 10) return v;

    if (typeof v === 'string') {
      return resolveConfigValueWithReport(v, rawInput, runtimeState, unresolved);
    }

    if (Array.isArray(v)) {
      return v.map((item) => walk(item, depth + 1));
    }

    if (v !== null && typeof v === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        result[key] = walk(val, depth + 1);
      }
      return result;
    }

    return v;
  }

  const resolved = walk(value, 0);
  return { resolved, unresolvedStateRefs: [...unresolved] };
}
