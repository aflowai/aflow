/**
 * A model calling a tool often JSON-stringifies a nested object argument,
 * sending `"{\"type\":…}"` where an object was meant, and the refusal it gets
 * back costs a turn on a mistake it will make again. The string form is parsed
 * back before validation; anything else, and a string that is not JSON, falls
 * through to the ordinary "Expected object" error.
 */
export const coerceJsonObjectArg = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
