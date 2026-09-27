/**
 * Reference parser for ${...} syntax.
 * Handles both full replacement and string interpolation.
 */
import type { StepId } from '@aflow/schemas';
import type { ParsedRef, ParseResult, RefSource, ResolutionError } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for matching ${...} references.
 * Captures the content between ${ and }.
 */
const REF_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Pattern for matching a single full reference (entire string is one ref).
 */
const FULL_REF_PATTERN = /^\$\{([^}]+)\}$/;

/**
 * Forbidden keys for prototype pollution protection.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ============================================================================
// Parser Functions
// ============================================================================

/**
 * Check if a path segment is forbidden (prototype pollution).
 */
function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

/**
 * Parse a raw reference string (content inside ${...}).
 * Examples:
 *   - "state.userId" → { source: "state", path: ["userId"] }
 *   - "steps.stepA.output.foo" → { source: "steps", stepId: "stepA", accessor: "output", path: ["foo"] }
 */
export function parseRef(raw: string): ParsedRef | ResolutionError {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return {
      code: 'INPUT_REF_PARSE_ERROR',
      message: 'Empty reference',
      ref: raw,
    };
  }

  const segments = trimmed.split('.');

  if (segments.length === 0 || segments[0] === undefined) {
    return {
      code: 'INPUT_REF_PARSE_ERROR',
      message: 'Invalid reference format',
      ref: raw,
    };
  }

  // Check for forbidden keys
  for (const segment of segments) {
    if (isForbiddenKey(segment)) {
      return {
        code: 'INPUT_REF_PROTOTYPE_POLLUTION',
        message: `Forbidden key in reference: ${segment}`,
        ref: raw,
        path: segments,
      };
    }
  }

  const source = segments[0];

  if (source === 'state') {
    // state.foo.bar.baz → path is everything after "state"
    // state.result/data/items/0 → variable "result", pointer "/data/items/0"
    const path = segments.slice(1);

    if (path.length === 0) {
      return {
        code: 'INPUT_REF_PARSE_ERROR',
        message: 'State reference must specify a path (e.g., state.userId)',
        ref: raw,
      };
    }

    // Check if the first path segment contains a `/` — indicates JSON Pointer
    const firstSegment = path[0]!;
    const slashIndex = firstSegment.indexOf('/');
    if (slashIndex !== -1) {
      // "result/data/items/0" → varId = "result", pointer = "/data/items/0"
      const varId = firstSegment.slice(0, slashIndex);
      const pointer = '/' + firstSegment.slice(slashIndex + 1);

      // Re-join remaining dot-segments as additional pointer segments
      // (e.g., state.result/data.more → not supported, dots are in path only before /)
      if (path.length > 1) {
        return {
          code: 'INPUT_REF_PARSE_ERROR',
          message:
            'State reference with JSON Pointer must not have dot-separated segments after the pointer (use / for nested access)',
          ref: raw,
        };
      }

      return {
        raw: trimmed,
        source: 'state' as RefSource,
        path: [varId],
        pointer,
      };
    }

    return {
      raw: trimmed,
      source: 'state' as RefSource,
      path,
    };
  }

  if (source === 'steps') {
    // steps.stepA.output.foo → stepId=stepA, accessor=output, path=[foo]
    if (segments.length < 3) {
      return {
        code: 'INPUT_REF_PARSE_ERROR',
        message: 'Step reference must specify stepId and accessor (e.g., steps.stepA.output.field)',
        ref: raw,
      };
    }

    const stepId = segments[1] as StepId;
    const accessor = segments[2];

    if (accessor !== 'output' && accessor !== 'error') {
      return {
        code: 'INPUT_REF_PARSE_ERROR',
        message: `Invalid step accessor: ${String(accessor)}. Must be 'output' or 'error'`,
        ref: raw,
      };
    }

    const path = segments.slice(3);

    return {
      raw: trimmed,
      source: 'steps' as RefSource,
      path,
      stepId,
      accessor,
    };
  }

  return {
    code: 'INPUT_REF_PARSE_ERROR',
    message: `Unknown reference source: ${source}. Must be 'state' or 'steps'`,
    ref: raw,
  };
}

/**
 * Parse a value that may contain ${...} references.
 * Returns a ParseResult indicating literal, full ref, or interpolation.
 */
export function parseValue(value: unknown): ParseResult | ResolutionError {
  // Non-string values are always literals
  if (typeof value !== 'string') {
    return { type: 'literal', value };
  }

  // Check for full reference (entire string is one ref)
  const fullMatch = FULL_REF_PATTERN.exec(value);
  if (fullMatch) {
    const refContent = fullMatch[1];
    if (refContent === undefined) {
      return {
        code: 'INPUT_REF_PARSE_ERROR',
        message: 'Empty reference',
        ref: value,
      };
    }

    const parsed = parseRef(refContent);
    if ('code' in parsed) {
      return parsed; // Error
    }
    return { type: 'full_ref', ref: parsed };
  }

  // Check for any references at all
  const hasRefs = REF_PATTERN.test(value);
  if (!hasRefs) {
    return { type: 'literal', value };
  }

  // String interpolation - parse all refs and literals
  const parts: Array<{ type: 'literal'; value: string } | { type: 'ref'; ref: ParsedRef }> = [];
  let lastIndex = 0;

  // Reset regex state
  REF_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = REF_PATTERN.exec(value)) !== null) {
    // Add literal part before this match
    if (match.index > lastIndex) {
      parts.push({
        type: 'literal',
        value: value.slice(lastIndex, match.index),
      });
    }

    // Parse the reference
    const refContent = match[1];
    if (refContent === undefined) {
      return {
        code: 'INPUT_REF_PARSE_ERROR',
        message: 'Empty reference in interpolation',
        ref: value,
      };
    }

    const parsed = parseRef(refContent);
    if ('code' in parsed) {
      return parsed; // Error
    }

    parts.push({ type: 'ref', ref: parsed });
    lastIndex = match.index + match[0].length;
  }

  // Add trailing literal if any
  if (lastIndex < value.length) {
    parts.push({
      type: 'literal',
      value: value.slice(lastIndex),
    });
  }

  return { type: 'interpolation', parts };
}

/**
 * Check if a value contains any references.
 */
export function hasRefs(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  // Reset lastIndex before testing (global regex retains state)
  REF_PATTERN.lastIndex = 0;
  return REF_PATTERN.test(value);
}

/**
 * Extract all references from a value.
 */
export function extractRefs(value: unknown): ParsedRef[] {
  const result = parseValue(value);
  if ('code' in result) {
    return []; // Error - no refs
  }

  switch (result.type) {
    case 'literal':
      return [];
    case 'full_ref':
      return [result.ref];
    case 'interpolation':
      return result.parts
        .filter((p): p is { type: 'ref'; ref: ParsedRef } => p.type === 'ref')
        .map((p) => p.ref);
  }
}
