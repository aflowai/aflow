import jsonata from 'jsonata';

/**
 * Evaluate a JSONata filter expression against a data payload.
 * Returns true if the expression evaluates to a truthy value.
 */
export async function evaluateFilter(expression: string, data: unknown): Promise<boolean> {
  try {
    const expr = jsonata(expression);
    const result: unknown = await expr.evaluate(data);
    return Boolean(result);
  } catch {
    // Invalid expression or evaluation error → treat as non-matching
    return false;
  }
}

/**
 * Apply a JSONata input mapping to transform webhook payload into flow input.
 *
 * Each key in the mapping is a field name in the output, and each value is a
 * JSONata expression evaluated against the input data.
 *
 * Example mapping:
 *   { "title": "$.pull_request.title", "action": "$.action" }
 *
 * Returns the mapped object, or the raw data if mapping fails.
 */
export async function applyMapping(
  mapping: Record<string, string>,
  data: unknown,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const [key, expression] of Object.entries(mapping)) {
    try {
      const expr = jsonata(expression);
      result[key] = await expr.evaluate(data);
    } catch {
      // If a single field mapping fails, set it to null and continue
      result[key] = null;
    }
  }

  return result;
}
