import { z } from 'zod';

/** The reserved bind-node key. */
export const TEMPLATE_BIND_KEY = '$bind';

/**
 * `{ "$concat": [part, …] }` — its parts joined into one string. Every part
 * must be present and a string: a value missing one of its parts is a
 * different value, so a part that resolved absent makes the whole node absent.
 */
export const TEMPLATE_CONCAT_KEY = '$concat';

/** `{ "$firstOf": [alternative, …] }` — the first alternative that is present; absent when none is. */
export const TEMPLATE_FIRST_OF_KEY = '$firstOf';

const TEMPLATE_OPERATOR_KEYS = [TEMPLATE_CONCAT_KEY, TEMPLATE_FIRST_OF_KEY] as const;
export type TemplateOperatorKey = (typeof TEMPLATE_OPERATOR_KEYS)[number];

/** A template node that carries an operator key: its operands where well formed, why not where not. */
export type TemplateOperatorNode =
  | { operator: TemplateOperatorKey; operands: unknown[] }
  | { operator: TemplateOperatorKey; malformed: string };

/** The operator node `value` is, or undefined when it carries no operator key. */
export function readTemplateOperatorNode(value: unknown): TemplateOperatorNode | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const operator = templateOperatorOf(rec);
  if (operator === undefined) return undefined;
  const malformed = malformedOperator(rec, operator);
  return malformed === undefined
    ? { operator, operands: rec[operator] as unknown[] }
    : { operator, malformed };
}

/** The operator a node carries, if it carries one — well-formed or not. */
function templateOperatorOf(rec: Record<string, unknown>): TemplateOperatorKey | undefined {
  return TEMPLATE_OPERATOR_KEYS.find((key) => Object.prototype.hasOwnProperty.call(rec, key));
}

/** Why an operator node is malformed, or undefined when it is well formed. */
function malformedOperator(
  rec: Record<string, unknown>,
  key: TemplateOperatorKey,
): string | undefined {
  const keys = Object.keys(rec);
  if (keys.length !== 1) {
    return `an operator node must have exactly the single key "${key}" (found keys: ${keys.sort().join(', ')})`;
  }
  const operands = rec[key];
  if (!Array.isArray(operands) || operands.length < 2) {
    return `"${key}" takes an array of at least two operands`;
  }
  return undefined;
}

export const WorkflowTaskInputTemplateSchema = z.record(z.unknown());
export type WorkflowTaskInputTemplate = z.infer<typeof WorkflowTaskInputTemplateSchema>;

/**
 * A well-formed bind node: a plain object with EXACTLY the single key
 * `$bind` whose value is a non-empty string.
 */
export function isTemplateBindNode(value: unknown): value is { $bind: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  return (
    keys.length === 1 &&
    keys[0] === TEMPLATE_BIND_KEY &&
    typeof rec[TEMPLATE_BIND_KEY] === 'string' &&
    rec[TEMPLATE_BIND_KEY].length > 0
  );
}

/** One `$bind` reference found in a template, with its location. */
export interface TemplateBindRef {
  /** The referenced binding name. */
  bindAs: string;
  /** Dotted path with `[n]` indexing; `''` when the bind node IS the root. */
  path: string;
}

/** A node that carries a `$bind` key but is not a well-formed bind node. */
export interface TemplateMalformedBind {
  path: string;
  reason: string;
}

export interface InputTemplateAnalysis {
  binds: TemplateBindRef[];
  malformed: TemplateMalformedBind[];
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/**
 * Deep-walk a template, collecting every `$bind` reference and every
 * malformed bind-node attempt (an object carrying `$bind` alongside other
 * keys, or with a non-string / empty value — an author writing `$bind`
 * anywhere almost certainly meant substitution, so we flag rather than
 * silently treat it as a literal).
 */
export function analyzeInputTemplate(template: unknown): InputTemplateAnalysis {
  const out: InputTemplateAnalysis = { binds: [], malformed: [] };
  walk(template, '', out);
  return out;
}

function walk(node: unknown, path: string, out: InputTemplateAnalysis): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((el, i) => {
      walk(el, `${path}[${String(i)}]`, out);
    });
    return;
  }
  const rec = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, TEMPLATE_BIND_KEY)) {
    if (isTemplateBindNode(rec)) {
      out.binds.push({ bindAs: rec[TEMPLATE_BIND_KEY], path });
    } else {
      const keys = Object.keys(rec).sort();
      out.malformed.push({
        path,
        reason: `${
          keys.length === 1
            ? `"${TEMPLATE_BIND_KEY}" must be a non-empty string naming a declared binding`
            : `a bind node must have exactly the single key "${TEMPLATE_BIND_KEY}" (found keys: ${keys.join(', ')})`
        }. Write exactly { "${TEMPLATE_BIND_KEY}": "<bindAs>" }`,
      });
    }
    return; // never descend into a bind node (well-formed or not).
  }
  const operator = templateOperatorOf(rec);
  if (operator !== undefined) {
    const reason = malformedOperator(rec, operator);
    if (reason !== undefined) {
      out.malformed.push({ path, reason });
      return;
    }
  }
  for (const [key, value] of Object.entries(rec)) {
    walk(value, joinPath(path, key), out);
  }
}

/**
 * Whether a template subtree contains anything substitution replaces — a
 * bind-node attempt or an operator node, well formed or not (deep). Without
 * one, the subtree is the literal it is written as.
 */
export function templateContainsSubstitution(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(templateContainsSubstitution);
  const rec = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, TEMPLATE_BIND_KEY)) return true;
  if (templateOperatorOf(rec) !== undefined) return true;
  return Object.values(rec).some(templateContainsSubstitution);
}

/**
 * Thrown by {@link substituteTemplateBinds} on a structural template
 * violation the author-time rules should have caught (unknown `$bind`,
 * malformed bind node, absent root). Callers wrap it into their own typed
 * error (e.g. `TaskInputResolutionError`) — fail loud, never silently bind.
 */
export class TemplateSubstitutionError extends Error {
  constructor(
    /** Dotted template path of the offending node; `''` = root. */
    public readonly path: string,
    /** The referenced binding name, when one exists. */
    public readonly bindAs: string | undefined,
    detail: string,
  ) {
    super(detail);
    this.name = 'TemplateSubstitutionError';
  }
}

/** Sentinel for "omit this node" — mirrors flat assembly's omitted ABSENT keys. */
const OMIT = Symbol('substituteTemplateBinds.omit');

interface SubstituteCtx {
  /** Resolved values: `{ ...task.inputs, ...resolvedBindings }` (ABSENT bindings omitted). */
  resolved: Record<string, unknown>;
  /** Every declared name: `inputBindings` keys ∪ literal `inputs` keys. */
  declared: ReadonlySet<string>;
}

/**
 * Deep-substitute every bind node in `template` from `resolved`.
 *
 * Semantics (mirrors the flat path's ABSENT contract):
 *   - A bind node naming a DECLARED binding that resolved absent (skipped /
 *     blocked upstream, first-run `system_feedback`, `undefined` sub-path)
 *     is OMITTED — the object property or array element disappears.
 *   - A bind node naming an UNDECLARED name throws (author-time rules flag
 *     this as `template_unknown_bind`; at runtime it is a hard error, never
 *     a silent omission — "declared but absent" is the only legal absence).
 *   - A malformed bind node (extra keys / non-string value) throws.
 *   - The substituted root must remain a JSON object (op inputs are
 *     objects); a root bind node that resolves absent or non-object throws.
 *   - `$concat` and `$firstOf` nodes compute one value from their operands,
 *     each operand substituted by these same rules.
 */
export function substituteTemplateBinds(
  template: WorkflowTaskInputTemplate,
  resolved: Record<string, unknown>,
  declared: ReadonlySet<string>,
): Record<string, unknown> {
  const result = substituteNode(template, '', { resolved, declared });
  if (result === OMIT) {
    throw new TemplateSubstitutionError(
      '',
      undefined,
      'the template root resolved to an absent binding — the op input would be empty',
    );
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new TemplateSubstitutionError(
      '',
      undefined,
      'the substituted template root must be a JSON object (op inputs are objects)',
    );
  }
  return result as Record<string, unknown>;
}

function substituteNode(node: unknown, path: string, ctx: SubstituteCtx): unknown {
  if (node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    const out: unknown[] = [];
    node.forEach((el, i) => {
      const substituted = substituteNode(el, `${path}[${String(i)}]`, ctx);
      if (substituted !== OMIT) out.push(substituted);
    });
    return out;
  }

  const rec = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, TEMPLATE_BIND_KEY)) {
    if (!isTemplateBindNode(rec)) {
      throw new TemplateSubstitutionError(
        path,
        undefined,
        `malformed bind node at "${path || '(root)'}" — a bind node must be exactly { "${TEMPLATE_BIND_KEY}": "<name>" }`,
      );
    }
    const bindAs = rec[TEMPLATE_BIND_KEY];
    if (!ctx.declared.has(bindAs)) {
      throw new TemplateSubstitutionError(
        path,
        bindAs,
        `"${TEMPLATE_BIND_KEY}": "${bindAs}" at "${path || '(root)'}" names no declared inputBindings entry or literal inputs key`,
      );
    }
    if (
      !Object.prototype.hasOwnProperty.call(ctx.resolved, bindAs) ||
      ctx.resolved[bindAs] === undefined
    ) {
      return OMIT;
    }
    return ctx.resolved[bindAs];
  }

  const operator = templateOperatorOf(rec);
  if (operator !== undefined) return substituteOperator(rec, operator, path, ctx);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    const substituted = substituteNode(value, joinPath(path, key), ctx);
    if (substituted !== OMIT) out[key] = substituted;
  }
  return out;
}

function substituteOperator(
  rec: Record<string, unknown>,
  operator: TemplateOperatorKey,
  path: string,
  ctx: SubstituteCtx,
): unknown {
  const reason = malformedOperator(rec, operator);
  if (reason !== undefined) {
    throw new TemplateSubstitutionError(
      path,
      undefined,
      `malformed operator node at "${path || '(root)'}" — ${reason}`,
    );
  }
  const operandsPath = joinPath(path, operator);
  const operands = (rec[operator] as unknown[]).map((operand, i) =>
    substituteNode(operand, `${operandsPath}[${String(i)}]`, ctx),
  );

  if (operator === TEMPLATE_FIRST_OF_KEY) {
    const present = operands.findIndex((operand) => operand !== OMIT);
    return present === -1 ? OMIT : operands[present];
  }

  if (operands.includes(OMIT)) return OMIT;
  const parts: string[] = [];
  for (const [i, operand] of operands.entries()) {
    if (typeof operand !== 'string') {
      throw new TemplateSubstitutionError(
        `${operandsPath}[${String(i)}]`,
        undefined,
        `"${TEMPLATE_CONCAT_KEY}" at "${path || '(root)'}" joins strings, and operand ${String(i)} resolved to ${operand === null ? 'null' : typeof operand}`,
      );
    }
    parts.push(operand);
  }
  return parts.join('');
}
