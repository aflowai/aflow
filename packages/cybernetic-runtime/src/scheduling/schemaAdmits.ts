/**
 * What a JSON Schema position admits, read without compiling it: the questions
 * graph validation asks of an operation's input schema at a template position.
 * A construct these cannot read admits the value, so validation never refuses
 * on a schema it does not understand.
 */

export const STRING_SCHEMA: Record<string, unknown> = { type: 'string' };

/** Whether a JSON Schema property admits `null`. */
export function schemaAcceptsNull(prop: Record<string, unknown>): boolean {
  const ty = prop['type'];
  if (ty === 'null') return true;
  if (Array.isArray(ty) && ty.includes('null')) return true;
  if (prop['nullable'] === true) return true; // OpenAPI-style
  const en = prop['enum'];
  if (Array.isArray(en) && en.includes(null)) return true;
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branches = prop[combinator];
    if (Array.isArray(branches)) {
      if (branches.some((b) => isRecord(b) && schemaAcceptsNull(b))) return true;
    }
  }
  return false;
}

/** Whether a JSON Schema property is typed exactly/only as `t`. */
export function schemaTypeIs(prop: Record<string, unknown>, t: string): boolean {
  const ty = prop['type'];
  if (typeof ty === 'string') return ty === t;
  if (Array.isArray(ty)) return ty.length > 0 && ty.every((x) => x === t);
  return false;
}

/** Whether a position's schema can admit a value of one of `types`. */
function schemaAdmitsType(schema: Record<string, unknown>, types: readonly string[]): boolean {
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches)) {
      return branches.some((branch) => !isRecord(branch) || schemaAdmitsType(branch, types));
    }
  }
  const ty = schema['type'];
  if (typeof ty === 'string') return types.includes(ty);
  if (Array.isArray(ty)) return ty.some((t) => typeof t === 'string' && types.includes(t));
  if (isRecord(schema['properties']) && Object.keys(schema['properties']).length > 0) return false;
  return true;
}

/** Whether a position's schema can admit some string. */
export function schemaAdmitsString(schema: Record<string, unknown>): boolean {
  return schemaAdmitsType(schema, ['string']);
}

/** Whether a position's schema can admit some integer. */
export function schemaAdmitsInteger(schema: Record<string, unknown>): boolean {
  return schemaAdmitsType(schema, ['integer', 'number']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
