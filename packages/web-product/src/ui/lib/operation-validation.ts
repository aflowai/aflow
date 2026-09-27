import { getOperation } from '@aflow/schemas';

/**
 * Validate step config against the operation's inputZod schema.
 * Returns null if valid, or a Record<fieldPath, errorMessage> if invalid.
 *
 * Handles `${...}` variable references: fields mapped via refs are excluded
 * from validation (resolved at runtime), and missing-field errors are suppressed
 * for fields that are present in config with a `${...}` value or are internal.
 */
export function validateStepConfig(
  operationId: string,
  config: Record<string, unknown>,
): Record<string, string> | null {
  const op = getOperation(operationId);
  if (!op?.inputZod || op.skipInputValidation) return null;

  const configKeys = new Set(Object.keys(config));
  const internalFields = new Set(op.internalFields?.input ?? []);

  // Build static subset: only fields whose values don't contain ${...} refs
  const staticConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (containsRef(value)) continue;
    staticConfig[key] = value;
  }

  const result = op.inputZod.safeParse(staticConfig);
  if (result.success) return null;

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    // Skip missing-field errors for fields mapped via ${...} or internal
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      const fieldName = issue.path[0];
      if (typeof fieldName === 'string') {
        if (configKeys.has(fieldName) && !(fieldName in staticConfig)) continue;
        if (internalFields.has(fieldName)) continue;
      }
    }

    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!(key in errors)) {
      errors[key] = issue.message;
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

/** Strip backtick-wrapped code sections from a string. */
function stripCodeSections(value: string): string {
  return value.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
}

/** Recursively check if a value contains `${...}` reference patterns (outside code sections). */
function containsRef(value: unknown): boolean {
  if (typeof value === 'string') return /\$\{[^}]+\}/.test(stripCodeSections(value));
  if (Array.isArray(value)) return value.some(containsRef);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsRef);
  }
  return false;
}
