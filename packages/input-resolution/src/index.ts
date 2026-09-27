/**
 * Input Resolution + Validation package.
 *
 * Provides:
 * - RefParser: Parse ${...} variable references
 * - InputResolver: Resolve references against a context
 * - validateInput: Validate resolved input against Zod schemas
 * - resolveAndValidate: Combined resolution + validation
 */

// Types
export type {
  ResolutionContext,
  ResolutionContextMetadata,
  StepData,
  ParsedRef,
  ParseResult,
  RefSource,
  ResolutionResult,
  ResolutionSuccess,
  ResolutionFailure,
  ResolutionError,
  ResolutionErrorCode,
  ValidationResult,
  ValidationSuccess,
  ValidationFailure,
  ValidationError,
  ValidationIssue,
  ResolutionConfig,
} from './types.js';

export { ResolutionContextSchema, DEFAULT_RESOLUTION_CONFIG } from './types.js';

// Parser
export { parseRef, parseValue, hasRefs, extractRefs } from './parser.js';

// Resolver
export { resolveRef, resolveValue, resolveTemplateObject, InputResolver } from './resolver.js';

export {
  isStateRef,
  normalizeMangledRef,
  resolveStateRef,
  resolveOutputRef,
  resolveRefsRecursive,
  applyJsonPointer,
  isResolutionError,
  StateRefError,
  TOOL_OUTPUT_INDEX_KEY,
} from './stateRefResolver.js';
export type { PayloadRetriever, RuntimeStateVariables } from './stateRefResolver.js';

// Validator
export { validateInput, createValidationError, createValidationIssue } from './validator.js';

// ============================================================================
// Combined Resolution + Validation
// ============================================================================

import type { z } from 'zod';
import type {
  ResolutionContext,
  ResolutionConfig,
  ResolutionError,
  ValidationError,
} from './types.js';
import { resolveTemplateObject } from './resolver.js';
import { validateInput } from './validator.js';

/**
 * Result of combined resolution and validation.
 */
export type ResolveAndValidateResult<T> =
  | { success: true; data: T; resolved: unknown }
  | { success: false; phase: 'resolution'; error: ResolutionError }
  | { success: false; phase: 'validation'; error: ValidationError; resolved: unknown };

/**
 * Resolve a template and validate the result against a schema.
 * This is the main entry point for input processing.
 *
 * @param template - The input template with ${...} references
 * @param context - Resolution context from orchestrator
 * @param schema - Zod schema to validate against
 * @param config - Optional resolution configuration
 * @returns Typed result with resolved and validated data
 */
export function resolveAndValidate<T>(
  template: unknown,
  context: ResolutionContext,
  schema: z.ZodSchema<T>,
  config?: Partial<ResolutionConfig>,
): ResolveAndValidateResult<T> {
  // Step 1: Resolve all references
  const resolveResult = resolveTemplateObject(template, context, {
    maxDepth: config?.maxDepth ?? 10,
    maxRefs: config?.maxRefs ?? 100,
    maxStringLength: config?.maxStringLength ?? 1_000_000,
  });

  if (!resolveResult.success) {
    return {
      success: false,
      phase: 'resolution',
      error: resolveResult.error,
    };
  }

  const resolved = resolveResult.value;

  // Step 2: Validate against schema
  const validateResult = validateInput(resolved, schema);

  if (!validateResult.success) {
    return {
      success: false,
      phase: 'validation',
      error: validateResult.error,
      resolved,
    };
  }

  return {
    success: true,
    data: validateResult.data,
    resolved,
  };
}
