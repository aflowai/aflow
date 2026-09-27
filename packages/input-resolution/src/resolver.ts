/**
 * Input resolver for resolving ${...} references against a context.
 */
import { parseValue } from './parser.js';
import type { ResolutionContext, ParsedRef, ResolutionResult, ResolutionConfig } from './types.js';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Safely get a value at a path from an object.
 * Returns undefined if path doesn't exist.
 */
function getAtPath(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;

  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    // Type assertion safe because we checked typeof === "object"
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

// ============================================================================
// Reference Resolution
// ============================================================================

/**
 * Resolve a single parsed reference against a context.
 */
export function resolveRef(ref: ParsedRef, context: ResolutionContext): ResolutionResult {
  switch (ref.source) {
    case 'state': {
      const value = getAtPath(context.state, ref.path);

      if (value === undefined) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_NOT_FOUND',
            message: `State variable not found: ${ref.raw}`,
            ref: ref.raw,
            path: ref.path,
          },
        };
      }

      return { success: true, value };
    }

    case 'steps': {
      const stepId = ref.stepId;
      if (!stepId) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_PARSE_ERROR',
            message: `Missing step ID in reference: ${ref.raw}`,
            ref: ref.raw,
          },
        };
      }

      const stepData = context.steps[stepId];
      if (!stepData) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_NOT_FOUND',
            message: `Step not found in context: ${stepId}`,
            ref: ref.raw,
            path: [stepId],
          },
        };
      }

      const accessor = ref.accessor;
      if (!accessor) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_PARSE_ERROR',
            message: `Missing accessor (output/error) in reference: ${ref.raw}`,
            ref: ref.raw,
          },
        };
      }

      const sourceData = accessor === 'output' ? stepData.output : stepData.error;

      if (sourceData === undefined) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_NOT_FOUND',
            message: `Step ${accessor} not available: ${ref.raw}`,
            ref: ref.raw,
            path: [stepId, accessor],
          },
        };
      }

      // If no further path, return the whole output/error
      if (ref.path.length === 0) {
        return { success: true, value: sourceData };
      }

      const value = getAtPath(sourceData, ref.path);

      if (value === undefined) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_NOT_FOUND',
            message: `Path not found in step ${accessor}: ${ref.raw}`,
            ref: ref.raw,
            path: ref.path,
          },
        };
      }

      return { success: true, value };
    }
  }
}

// ============================================================================
// Value Resolution
// ============================================================================

/**
 * Resolve a single value that may contain references.
 */
export function resolveValue(
  value: unknown,
  context: ResolutionContext,
  config: ResolutionConfig,
): ResolutionResult {
  const parsed = parseValue(value);

  // Parse error
  if ('code' in parsed) {
    return { success: false, error: parsed };
  }

  switch (parsed.type) {
    case 'literal':
      return { success: true, value: parsed.value };

    case 'full_ref': {
      return resolveRef(parsed.ref, context);
    }

    case 'interpolation': {
      // Resolve all parts and concatenate as string
      const resolvedParts: string[] = [];

      for (const part of parsed.parts) {
        if (part.type === 'literal') {
          resolvedParts.push(part.value);
        } else {
          const result = resolveRef(part.ref, context);
          if (!result.success) {
            return result;
          }
          // Coerce to string for interpolation
          resolvedParts.push(String(result.value));
        }
      }

      const interpolated = resolvedParts.join('');

      // Check max string length
      if (interpolated.length > config.maxStringLength) {
        return {
          success: false,
          error: {
            code: 'INPUT_REF_DEPTH_EXCEEDED',
            message: `Interpolated string exceeds maximum length: ${String(interpolated.length)} > ${String(config.maxStringLength)}`,
          },
        };
      }

      return { success: true, value: interpolated };
    }
  }
}

// ============================================================================
// Object/Template Resolution
// ============================================================================

/**
 * State for tracking resolution limits.
 */
interface ResolutionState {
  refCount: number;
  depth: number;
}

/**
 * Recursively resolve all references in an object/array/value.
 */
function resolveRecursive(
  value: unknown,
  context: ResolutionContext,
  config: ResolutionConfig,
  state: ResolutionState,
): ResolutionResult {
  // Check depth limit
  if (state.depth > config.maxDepth) {
    return {
      success: false,
      error: {
        code: 'INPUT_REF_DEPTH_EXCEEDED',
        message: `Maximum resolution depth exceeded: ${String(state.depth)} > ${String(config.maxDepth)}`,
      },
    };
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const item of value) {
      const result = resolveRecursive(item, context, config, {
        ...state,
        depth: state.depth + 1,
      });
      if (!result.success) {
        return result;
      }
      resolved.push(result.value);
    }
    return { success: true, value: resolved };
  }

  // Handle objects (but not null)
  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const result = resolveRecursive(val, context, config, {
        ...state,
        depth: state.depth + 1,
      });
      if (!result.success) {
        return result;
      }
      resolved[key] = result.value;
    }
    return { success: true, value: resolved };
  }

  // Handle primitives (may contain refs if string)
  if (typeof value === 'string') {
    state.refCount++;
    if (state.refCount > config.maxRefs) {
      return {
        success: false,
        error: {
          code: 'INPUT_REF_DEPTH_EXCEEDED',
          message: `Maximum reference count exceeded: ${String(state.refCount)} > ${String(config.maxRefs)}`,
        },
      };
    }
  }

  return resolveValue(value, context, config);
}

/**
 * Resolve all references in an input template object.
 * This is the main entry point for template resolution.
 */
export function resolveTemplateObject(
  template: unknown,
  context: ResolutionContext,
  config: ResolutionConfig = {
    maxDepth: 10,
    maxRefs: 100,
    maxStringLength: 1_000_000,
  },
): ResolutionResult {
  const state: ResolutionState = { refCount: 0, depth: 0 };
  return resolveRecursive(template, context, config, state);
}

// ============================================================================
// InputResolver Class (for stateful use)
// ============================================================================

/**
 * InputResolver class for resolving templates with a fixed context.
 */
export class InputResolver {
  private readonly context: ResolutionContext;
  private readonly config: ResolutionConfig;

  constructor(context: ResolutionContext, config: Partial<ResolutionConfig> = {}) {
    this.context = context;
    this.config = {
      maxDepth: config.maxDepth ?? 10,
      maxRefs: config.maxRefs ?? 100,
      maxStringLength: config.maxStringLength ?? 1_000_000,
    };
  }

  /**
   * Resolve a single reference.
   */
  resolveRef(ref: ParsedRef): ResolutionResult {
    return resolveRef(ref, this.context);
  }

  /**
   * Resolve a value that may contain references.
   */
  resolveValue(value: unknown): ResolutionResult {
    return resolveValue(value, this.context, this.config);
  }

  /**
   * Resolve all references in a template object.
   */
  resolve(template: unknown): ResolutionResult {
    return resolveTemplateObject(template, this.context, this.config);
  }
}
