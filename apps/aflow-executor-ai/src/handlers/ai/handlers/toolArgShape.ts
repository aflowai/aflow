/**
 * The shape a refused argument should have, written out from the tool's own
 * schema, so a repair turn shows the model the value to send rather than
 * describing it. "Send it as a real JSON array" was not enough for one model:
 * it re-sent the same quoted string and the run died on the second refusal.
 */

const ENCODING_REASON =
  /(\/[^\s:]+): must be (?:an? )?(array|object|string|number|boolean|integer)/i;

const MAX_PROPERTIES = 4;
const MAX_DEPTH = 3;

function skeleton(spec: unknown, depth: number): unknown {
  if (typeof spec !== 'object' || spec === null) return '<value>';
  const node = spec as Record<string, unknown>;
  const type = Array.isArray(node['type'])
    ? (node['type'] as unknown[]).find((t) => t !== 'null')
    : node['type'];
  if (Array.isArray(node['enum']) && node['enum'].length > 0) return node['enum'][0];
  if (type === 'array') return depth >= MAX_DEPTH ? [] : [skeleton(node['items'], depth + 1)];
  if (type === 'object' || (type === undefined && typeof node['properties'] === 'object')) {
    if (depth >= MAX_DEPTH) return {};
    const properties = (node['properties'] ?? {}) as Record<string, unknown>;
    const required = Array.isArray(node['required'])
      ? (node['required'] as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];
    const keys = (required.length > 0 ? required : Object.keys(properties)).slice(
      0,
      MAX_PROPERTIES,
    );
    return Object.fromEntries(keys.map((key) => [key, skeleton(properties[key], depth + 1)]));
  }
  if (type === 'string') return '<string>';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return '<value>';
}

/**
 * For a refusal naming an argument of the wrong type, the argument as it
 * should be sent, built from `inputSchema`: `"operations": [{"op": "add", ...}]`.
 * Undefined where the refusal names no typed argument the schema declares.
 */
export function expectedArgumentShape(
  reason: string,
  inputSchema: Record<string, unknown> | undefined,
): string | undefined {
  const match = ENCODING_REASON.exec(reason);
  if (!match || inputSchema === undefined) return undefined;
  const argument = match[1]!.split('/').find((segment) => segment.length > 0);
  if (argument === undefined) return undefined;
  const properties = inputSchema['properties'];
  if (typeof properties !== 'object' || properties === null) return undefined;
  const spec = (properties as Record<string, unknown>)[argument];
  if (spec === undefined) return undefined;
  return `${JSON.stringify(argument)}: ${JSON.stringify(skeleton(spec, 0))}`;
}
