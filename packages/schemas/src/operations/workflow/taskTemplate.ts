import { z } from 'zod';

/** The reserved bind-node key. */
export const TEMPLATE_BIND_KEY = '$bind';

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
        reason:
          keys.length === 1
            ? `"${TEMPLATE_BIND_KEY}" must be a non-empty string naming a declared binding`
            : `a bind node must have exactly the single key "${TEMPLATE_BIND_KEY}" (found keys: ${keys.join(', ')})`,
      });
    }
    return; // never descend into a bind node (well-formed or not).
  }
  for (const [key, value] of Object.entries(rec)) {
    walk(value, joinPath(path, key), out);
  }
}

/** Whether a template subtree contains any bind-node attempt (deep). */
export function templateContainsBind(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(templateContainsBind);
  const rec = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, TEMPLATE_BIND_KEY)) return true;
  return Object.values(rec).some(templateContainsBind);
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

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    const substituted = substituteNode(value, joinPath(path, key), ctx);
    if (substituted !== OMIT) out[key] = substituted;
  }
  return out;
}
