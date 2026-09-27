// ============================================================================
// AST
// ============================================================================

export type RestrictedPathSegment = { kind: 'member'; name: string } | { kind: 'wildcardArray' }; // [*]

export interface CompiledRestrictedPath {
  raw: string;
  segments: RestrictedPathSegment[];
}

// Internal aliases — keep older code in this module readable.
type Segment = RestrictedPathSegment;
type CompiledPath = CompiledRestrictedPath;

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown by `compileRestrictedPath` for syntactically invalid paths.
 * Message includes the offending substring so authors can locate the issue.
 */
export class RestrictedPathSyntaxError extends Error {
  constructor(
    public readonly path: string,
    public readonly position: number,
    public readonly reason: string,
  ) {
    super(`Invalid restricted JSONPath at position ${String(position)} in "${path}": ${reason}`);
    this.name = 'RestrictedPathSyntaxError';
  }
}

/**
 * Thrown by evaluation when a path doesn't resolve in the expected way for
 * the given binding kind (e.g., `value:` finding multiple matches, `enum:`
 * resolving through a non-array, `count:` resolving to a non-array).
 */
export class RestrictedPathEvalError extends Error {
  constructor(
    public readonly code:
      'PATH_NOT_FOUND' | 'EXPECTED_ARRAY' | 'EXPECTED_SCALAR' | 'AMBIGUOUS_VALUE' | 'TYPE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'RestrictedPathEvalError';
  }
}

// ============================================================================
// Compiler
// ============================================================================

/**
 * Parse a path string into a list of segments. Throws on any syntactic
 * deviation from the locked dialect.
 *
 * Examples:
 *   $                                  → []
 *   $.workflow                         → [member workflow]
 *   $.workflow.tasks[*].taskId         → [member workflow, member tasks, wildcardArray, member taskId]
 *   $.evalSuite.taskCriteria.propertyNames.enum
 *                                      → [member evalSuite, member taskCriteria, member propertyNames, member enum]
 *   $['$ref']                          → [member $ref]
 */
export function compileRestrictedPath(path: string): CompiledPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new RestrictedPathSyntaxError(
      typeof path === 'string' ? path : String(path),
      0,
      'path must be a non-empty string',
    );
  }
  if (!path.startsWith('$')) {
    throw new RestrictedPathSyntaxError(path, 0, 'path must begin with "$"');
  }

  const segments: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      // Forbid `..` (recursive descent)
      if (path[i + 1] === '.') {
        throw new RestrictedPathSyntaxError(path, i, 'recursive descent ".." is forbidden');
      }
      // Bare member access: read identifier
      let j = i + 1;
      while (j < path.length && /[A-Za-z0-9_]/.test(path[j]!)) {
        j++;
      }
      if (j === i + 1) {
        throw new RestrictedPathSyntaxError(path, i, 'expected member name after "."');
      }
      const name = path.slice(i + 1, j);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new RestrictedPathSyntaxError(
          path,
          i + 1,
          `member name "${name}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
        );
      }
      segments.push({ kind: 'member', name });
      i = j;
      continue;
    }
    if (ch === '[') {
      // Either [*] or quoted member
      if (path[i + 1] === '*') {
        if (path[i + 2] !== ']') {
          throw new RestrictedPathSyntaxError(path, i, 'expected "]" after "[*"');
        }
        segments.push({ kind: 'wildcardArray' });
        i += 3;
        continue;
      }
      // Quoted member: ['name'] or ["name"]
      const quote = path[i + 1];
      if (quote === "'" || quote === '"') {
        let j = i + 2;
        while (j < path.length && path[j] !== quote) {
          // No escape sequences in v1 — keep the parser obvious.
          if (path[j] === '\\') {
            throw new RestrictedPathSyntaxError(
              path,
              j,
              'escape sequences are not supported inside quoted members',
            );
          }
          j++;
        }
        if (j === path.length) {
          throw new RestrictedPathSyntaxError(path, i + 1, 'unterminated quoted member');
        }
        if (path[j + 1] !== ']') {
          throw new RestrictedPathSyntaxError(path, j + 1, 'expected "]" after quoted member');
        }
        const name = path.slice(i + 2, j);
        if (name.length === 0) {
          throw new RestrictedPathSyntaxError(path, i + 1, 'quoted member name must not be empty');
        }
        segments.push({ kind: 'member', name });
        i = j + 2;
        continue;
      }
      // Numeric / slice / filter — all forbidden
      if (/[0-9-]/.test(path[i + 1] ?? '')) {
        throw new RestrictedPathSyntaxError(
          path,
          i,
          'numeric and slice access are forbidden; use [*] for iteration',
        );
      }
      if (path[i + 1] === '?') {
        throw new RestrictedPathSyntaxError(path, i, 'filter expressions are forbidden');
      }
      throw new RestrictedPathSyntaxError(
        path,
        i,
        `unrecognized bracket form starting with "${path[i + 1] ?? ''}"`,
      );
    }
    throw new RestrictedPathSyntaxError(path, i, `unexpected character "${ch ?? ''}"`);
  }

  return { raw: path, segments };
}

// ============================================================================
// Evaluator
// ============================================================================

/**
 * Walk the value tree along the compiled segments. Returns ALL matches.
 * `wildcardArray` requires the current value to be an array; non-array values
 * raise `EXPECTED_ARRAY`.
 *
 * Missing segments produce zero matches without throwing — callers
 * (`evaluateEnum`/`evaluateValue`/`evaluateCount`) decide what to do with the
 * empty result based on binding kind.
 */
function walk(value: unknown, segments: readonly Segment[]): unknown[] {
  let frontier: unknown[] = [value];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const v of frontier) {
      if (seg.kind === 'member') {
        if (v === null || v === undefined) continue;
        if (typeof v !== 'object' || Array.isArray(v)) continue;
        const o = v as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(o, seg.name)) {
          next.push(o[seg.name]);
        }
      } else {
        // wildcardArray
        if (!Array.isArray(v)) {
          throw new RestrictedPathEvalError(
            'EXPECTED_ARRAY',
            `expected array at "[*]" segment but got ${describe(v)}`,
          );
        }
        for (const item of v) next.push(item);
      }
    }
    frontier = next;
  }
  return frontier;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function evaluateEnum(value: unknown, path: CompiledPath): Array<string | number | boolean> {
  const matches = walk(value, path.segments);
  const out: Array<string | number | boolean> = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (typeof m !== 'string' && typeof m !== 'number' && typeof m !== 'boolean') {
      throw new RestrictedPathEvalError(
        'TYPE_MISMATCH',
        `enum: expects scalar values at path "${path.raw}", got ${describe(m)}`,
      );
    }
    const key = `${typeof m}:${String(m)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  out.sort((a, b) => {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return out;
}

/**
 * `value:<jsonpath>` — exactly one match required. Multiple matches throw
 * AMBIGUOUS_VALUE; zero matches throw PATH_NOT_FOUND.
 */
export function evaluateValue(
  value: unknown,
  path: CompiledPath,
): string | number | boolean | null {
  const matches = walk(value, path.segments);
  if (matches.length === 0) {
    throw new RestrictedPathEvalError('PATH_NOT_FOUND', `value: path "${path.raw}" did not match`);
  }
  if (matches.length > 1) {
    throw new RestrictedPathEvalError(
      'AMBIGUOUS_VALUE',
      `value: path "${path.raw}" matched ${String(matches.length)} times; expected one`,
    );
  }
  const m = matches[0];
  if (m !== null && typeof m !== 'string' && typeof m !== 'number' && typeof m !== 'boolean') {
    throw new RestrictedPathEvalError(
      'EXPECTED_SCALAR',
      `value: expects scalar (or null), got ${describe(m)}`,
    );
  }
  return m;
}

/**
 * `count:<jsonpath>` — the path must resolve to exactly one array; the result
 * is its length.
 */
export function evaluateCount(value: unknown, path: CompiledPath): number {
  const matches = walk(value, path.segments);
  if (matches.length === 0) {
    throw new RestrictedPathEvalError('PATH_NOT_FOUND', `count: path "${path.raw}" did not match`);
  }
  if (matches.length > 1) {
    throw new RestrictedPathEvalError(
      'AMBIGUOUS_VALUE',
      `count: path "${path.raw}" matched ${String(matches.length)} times; expected one`,
    );
  }
  const m = matches[0];
  if (!Array.isArray(m)) {
    throw new RestrictedPathEvalError(
      'EXPECTED_ARRAY',
      `count: expected array at "${path.raw}", got ${describe(m)}`,
    );
  }
  return m.length;
}
