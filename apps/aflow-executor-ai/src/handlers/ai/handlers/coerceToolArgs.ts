/**
 * A model that sends a structured argument as a JSON string gets one chance to
 * be understood before the platform rejects the call.
 *
 * Rejection is expensive out of proportion to the mistake. The refusal reads
 * "arguments invalid: /operations: must be array", which the model has been
 * observed to interpret as "the tool failed" rather than "your encoding was
 * wrong" — one live Runner answered it by re-sending its opening move, and a
 * weaker model answered it the same way until the run was failed for repeating
 * itself. The same forgiveness already exists for a stringified `submit_output`
 * result; this is that rule applied where arguments arrive.
 *
 * Only a string that parses to exactly the type the schema asks for is
 * replaced, so a genuine string argument is never reinterpreted.
 */
export function coerceStringifiedToolArgs(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): { args: Record<string, unknown>; coerced: string[] } {
  const properties = inputSchema['properties'];
  if (typeof properties !== 'object' || properties === null) return { args, coerced: [] };

  const coerced: string[] = [];
  let next: Record<string, unknown> | undefined;

  for (const [key, rawSpec] of Object.entries(properties as Record<string, unknown>)) {
    const value = args[key];
    if (typeof value !== 'string') continue;

    const expected = expectedContainerType(rawSpec);
    if (expected === undefined) continue;

    const trimmed = value.trim();
    // Cheap reject before paying for a parse of a large argument.
    if (expected === 'array' && !trimmed.startsWith('[')) continue;
    if (expected === 'object' && !trimmed.startsWith('{')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const actual = Array.isArray(parsed)
      ? 'array'
      : typeof parsed === 'object' && parsed !== null
        ? 'object'
        : 'other';
    if (actual !== expected) continue;

    next ??= { ...args };
    next[key] = parsed;
    coerced.push(key);
  }

  return next ? { args: next, coerced } : { args, coerced: [] };
}

/** The container type a property schema asks for, or undefined if it is not one. */
function expectedContainerType(spec: unknown): 'array' | 'object' | undefined {
  if (typeof spec !== 'object' || spec === null) return undefined;
  const { type } = spec as { type?: unknown };
  if (type === 'array' || type === 'object') return type;
  // A union that admits a string is deliberately ambiguous — leave it alone.
  if (Array.isArray(type)) {
    if (type.includes('string')) return undefined;
    if (type.includes('array')) return 'array';
    if (type.includes('object')) return 'object';
  }
  return undefined;
}
