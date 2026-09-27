/**
 * Types for input resolution and validation.
 */
import { z } from 'zod';
import type { ReferenceRoot, StepId } from '@aflow/schemas';

// ============================================================================
// Resolution Context
// ============================================================================

/**
 * Metadata about the resolution context.
 */
export interface ResolutionContextMetadata {
  /** Run ID */
  runId: string;

  /** Step execution ID */
  stepExecutionId: string;

  /** Attempt number */
  attempt: number;

  /** When the context was created (Unix ms) */
  createdAtMs: number;

  /** Schema version for forward compatibility */
  schemaVersion: number;
}

/**
 * Output/error data from a previous step.
 */
export interface StepData {
  /** Step output (if succeeded) */
  output?: unknown;

  /** Step error (if failed) */
  error?:
    | {
        code: string;
        message: string;
        details?: unknown;
      }
    | undefined;
}

/**
 * Resolution context provided by orchestrator.
 * Contains all data needed to resolve ${...} references.
 */
export interface ResolutionContext {
  /** Current run state snapshot */
  state: Record<string, unknown>;

  /** Map of step ID to step output/error data */
  steps: Record<string, StepData>;

  /** Metadata for auditing */
  metadata: ResolutionContextMetadata;
}

/**
 * Zod schema for ResolutionContext (for validation).
 */
export const ResolutionContextSchema = z.object({
  state: z.record(z.unknown()),
  steps: z.record(
    z.object({
      output: z.unknown().optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          details: z.unknown().optional(),
        })
        .optional(),
    }),
  ),
  metadata: z.object({
    runId: z.string(),
    stepExecutionId: z.string(),
    attempt: z.number().int().positive(),
    createdAtMs: z.number().int().positive(),
    schemaVersion: z.number().int().nonnegative(),
  }),
});

// ============================================================================
// Reference Types
// ============================================================================

/**
 * Source of a reference.
 */
export type RefSource = ReferenceRoot;

/**
 * Parsed reference from ${...} syntax.
 */
export interface ParsedRef {
  /** Original raw reference string (e.g., "state.userId") */
  raw: string;

  /** Source type */
  source: RefSource;

  /** Path segments after source (e.g., ["userId"] or ["stepA", "output", "foo"]) */
  path: string[];

  /** For step refs: the step ID */
  stepId?: StepId;

  /** For step refs: whether accessing output or error */
  accessor?: 'output' | 'error';

  /** Optional JSON Pointer (RFC 6901) for nested access within state variables (e.g., "/data/items/0") */
  pointer?: string;
}

/**
 * Result of parsing a template string or value.
 */
export type ParseResult =
  | { type: 'literal'; value: unknown }
  | { type: 'full_ref'; ref: ParsedRef }
  | {
      type: 'interpolation';
      parts: Array<{ type: 'literal'; value: string } | { type: 'ref'; ref: ParsedRef }>;
    };

// ============================================================================
// Resolution Result Types
// ============================================================================

/**
 * Successful resolution result.
 */
export interface ResolutionSuccess {
  success: true;
  value: unknown;
}

/**
 * Failed resolution result.
 */
export interface ResolutionFailure {
  success: false;
  error: ResolutionError;
}

export type ResolutionResult = ResolutionSuccess | ResolutionFailure;

/**
 * Resolution error with typed codes.
 */
export interface ResolutionError {
  code: ResolutionErrorCode;
  message: string;
  ref?: string;
  path?: string[];
}

export type ResolutionErrorCode =
  | 'INPUT_REF_NOT_FOUND'
  | 'INPUT_REF_TYPE_MISMATCH'
  | 'INPUT_REF_PATH_INVALID'
  | 'INPUT_REF_PARSE_ERROR'
  | 'INPUT_REF_DEPTH_EXCEEDED'
  | 'INPUT_REF_PROTOTYPE_POLLUTION'
  | 'STATE_REF_NOT_FOUND'
  | 'STATE_REF_POINTER_ERROR';

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Validation success result.
 */
export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

/**
 * Validation failure result.
 */
export interface ValidationFailure {
  success: false;
  error: ValidationError;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

/**
 * Validation error with field-level details.
 */
export interface ValidationError {
  code: 'VALIDATION_ERROR';
  message: string;
  issues: ValidationIssue[];
}

/**
 * Individual validation issue.
 */
export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
  code: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for input resolution.
 */
export interface ResolutionConfig {
  /** Maximum path depth for references (default: 10) */
  maxDepth: number;

  /** Maximum number of references in a single input (default: 100) */
  maxRefs: number;

  /** Maximum string length for interpolated strings (default: 1MB) */
  maxStringLength: number;
}

export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  maxDepth: 10,
  maxRefs: 100,
  maxStringLength: 1_000_000,
};
