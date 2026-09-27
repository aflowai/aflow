/**
 * Input validation using Zod schemas.
 */
import type { z } from 'zod';
import { zodIssueMessage } from '@aflow/schemas';
import type { ValidationResult, ValidationError, ValidationIssue } from './types.js';

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate resolved input against a Zod schema.
 * Returns a typed result with detailed error information.
 */
export function validateInput<T>(input: unknown, schema: z.ZodSchema<T>): ValidationResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  // Convert Zod errors to our format
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: issue.path,
    message: zodIssueMessage(issue),
    code: issue.code,
  }));

  const error: ValidationError = {
    code: 'VALIDATION_ERROR',
    message: formatValidationMessage(issues),
    issues,
  };

  return { success: false, error };
}

/**
 * Format validation issues into a human-readable message.
 */
function formatValidationMessage(issues: ValidationIssue[]): string {
  if (issues.length === 0) {
    return 'Validation failed';
  }

  if (issues.length === 1) {
    const issue = issues[0];
    if (!issue) {
      return 'Validation failed';
    }
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `Validation failed at ${path}: ${issue.message}`;
  }

  return `Validation failed with ${String(issues.length)} issues: ${issues
    .slice(0, 3)
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : 'root';
      return `${path}: ${i.message}`;
    })
    .join('; ')}${issues.length > 3 ? ` (+${String(issues.length - 3)} more)` : ''}`;
}

/**
 * Create a validation error from manual checks.
 */
export function createValidationError(
  message: string,
  issues: ValidationIssue[] = [],
): ValidationError {
  return {
    code: 'VALIDATION_ERROR',
    message,
    issues,
  };
}

/**
 * Create a validation issue for a specific field.
 */
export function createValidationIssue(
  path: Array<string | number>,
  message: string,
  code = 'custom',
): ValidationIssue {
  return { path, message, code };
}
