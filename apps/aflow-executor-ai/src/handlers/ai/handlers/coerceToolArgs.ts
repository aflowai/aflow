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
 * replaced, so a genuine string argument is never reinterpreted. A string
 * encoded twice (`"\"[...]\""`) is read through both layers, and an array
 * whose items the schema wants as objects has each JSON-string item read the
 * same way.
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
    const expected = expectedContainerType(rawSpec);
    if (expected === undefined) continue;

    if (typeof value === 'string') {
      const parsed = parseAs(value, expected);
      if (parsed === undefined) continue;
      next ??= { ...args };
      next[key] = expected === 'array' ? coerceItems(parsed as unknown[], rawSpec) : parsed;
      coerced.push(key);
      continue;
    }
    if (expected === 'array' && Array.isArray(value)) {
      const items = coerceItems(value, rawSpec);
      if (items === value) continue;
      next ??= { ...args };
      next[key] = items;
      coerced.push(key);
    }
  }

  return next ? { args: next, coerced } : { args, coerced: [] };
}

/** The value a JSON string holds when it is exactly the container asked for, read through at most two encodings. */
function parseAs(value: string, expected: 'array' | 'object'): unknown {
  let text = value.trim();
  for (let layer = 0; layer < 2; layer += 1) {
    // A twice-encoded string starts with a quote. Cheap reject before paying for a parse.
    const open = expected === 'array' ? '[' : '{';
    if (!text.startsWith(open) && !text.startsWith('"')) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof parsed === 'string') {
      text = parsed.trim();
      continue;
    }
    const actual = Array.isArray(parsed)
      ? 'array'
      : typeof parsed === 'object' && parsed !== null
        ? 'object'
        : 'other';
    return actual === expected ? parsed : undefined;
  }
  return undefined;
}

/** An array whose schema wants object items, with each JSON-string item read as one. Unchanged items keep the array. */
function coerceItems(items: unknown[], spec: unknown): unknown[] {
  const itemSpec =
    typeof spec === 'object' && spec !== null ? (spec as { items?: unknown }).items : undefined;
  if (expectedContainerType(itemSpec) !== 'object') return items;
  let changed = false;
  const out = items.map((item) => {
    if (typeof item !== 'string') return item;
    const parsed = parseAs(item, 'object');
    if (parsed === undefined) return item;
    changed = true;
    return parsed;
  });
  return changed ? out : items;
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
