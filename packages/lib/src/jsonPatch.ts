/**
 * Shared RFC 6902 JSON Patch utilities.
 *
 * Thin wrapper around `fast-json-patch` that:
 *   - Validates the ops array (correct shape + spec compliance) before applying.
 *   - Applies all ops against a deep-cloned copy of the document.
 *   - Normalizes error messages to a single `JsonPatchError` type so callers
 *     can distinguish "patch is malformed" from "patch ran but post-validation
 *     rejected the result".
 *
 * This lives in `@aflow/lib` so every caller (memory executor's
 * `memory.store.patch`, the orchestrator's `workflow.manage.patch`, and any
 * future op using JSON Patch semantics) goes through the same, spec-correct
 * implementation.
 */
import jsonpatch, { type Operation as FastOperation } from 'fast-json-patch';

/** RFC 6902 operation literal. */
export type JsonPatchOp = 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';

/**
 * Individual RFC 6902 operation.
 *
 * `value` and `from` are typed as `| undefined` (rather than just optional) so
 * that Zod-parsed payloads — which emit `undefined` for absent optional fields
 * under `exactOptionalPropertyTypes` — can be passed through without a cast.
 */
export interface JsonPatchOperation {
  op: JsonPatchOp;
  path: string;
  value?: unknown;
  from?: string | undefined;
}

/** Error thrown for both validation and application failures. */
export class JsonPatchError extends Error {
  readonly kind: 'invalid_op' | 'apply_failed';
  readonly opIndex?: number;
  readonly opPath?: string;

  constructor(kind: JsonPatchError['kind'], message: string, opIndex?: number, opPath?: string) {
    super(message);
    this.name = 'JsonPatchError';
    this.kind = kind;
    if (opIndex !== undefined) this.opIndex = opIndex;
    if (opPath !== undefined) this.opPath = opPath;
  }
}

/**
 * Apply an RFC 6902 patch to `doc`, returning the patched document.
 *
 * The input `doc` is NOT mutated — a structured clone is patched. If any op
 * is malformed or fails to apply, the original doc is returned unchanged
 * and a `JsonPatchError` is thrown.
 *
 * All six RFC 6902 ops are supported (`add`, `remove`, `replace`, `move`,
 * `copy`, `test`). Path escapes (`~0` → `~`, `~1` → `/`), array index
 * targeting, and the `-` "append-to-end" token are handled correctly because
 * we delegate to `fast-json-patch`.
 */
export function applyJsonPatch<T = unknown>(doc: T, operations: readonly JsonPatchOperation[]): T {
  // Defensive copy — `fast-json-patch` would clone too, but we want to be
  // explicit about the contract: original input is never touched.
  const clone = structuredClone(doc);

  // Strip `undefined` fields from each op; `fast-json-patch` treats missing
  // and undefined differently and Zod may pass undefined for optional fields.
  const normalized = operations.map((raw) => {
    const out: Record<string, unknown> = {
      op: raw.op,
      path: raw.path,
    };
    if (raw.value !== undefined) out['value'] = raw.value;
    if (raw.from !== undefined) out['from'] = raw.from;
    return out as unknown as FastOperation;
  });

  // Validate first so we can give a precise error message pointing at the
  // bad op. `validate` returns `undefined` on success, an error object on
  // a spec-level problem, or throws for a malformed ops array.
  try {
    const validationError = jsonpatch.validate(normalized, clone as object) as unknown;
    if (validationError) {
      const { message, index, path } = extractErrorFields(validationError);
      throw new JsonPatchError('invalid_op', message, index, path);
    }
  } catch (err) {
    if (err instanceof JsonPatchError) throw err;
    throw new JsonPatchError('invalid_op', err instanceof Error ? err.message : String(err));
  }

  try {
    const result = jsonpatch.applyPatch(clone, normalized, /* validate */ false);
    return result.newDocument;
  } catch (err) {
    // fast-json-patch throws its own error types (PatchError with operation/index)
    // — re-wrap for a consistent surface.
    const { message, index, path } = extractErrorFields(err);
    throw new JsonPatchError('apply_failed', message, index, path);
  }
}

/**
 * `fast-json-patch` serializes the whole document into its message under a
 * `tree:` heading, so a failed op against a large document reports the document
 * rather than the failure. The caller already gets the op index and path, which
 * is what names the problem; the document is what the caller was holding when
 * it asked.
 */
function withoutDocumentDump(message: string): string {
  const dump = message.indexOf('\ntree:');
  return dump === -1 ? message : message.slice(0, dump).trimEnd();
}

function extractErrorFields(err: unknown): {
  message: string;
  index: number | undefined;
  path: string | undefined;
} {
  if (err === null || typeof err !== 'object') {
    return { message: String(err), index: undefined, path: undefined };
  }
  const rec = err as Record<string, unknown>;
  const message =
    typeof rec['message'] === 'string'
      ? withoutDocumentDump(rec['message'])
      : 'patch application failed';
  const index = typeof rec['index'] === 'number' ? rec['index'] : undefined;
  let path: string | undefined;
  const op = rec['operation'];
  if (
    op !== null &&
    typeof op === 'object' &&
    typeof (op as { path?: unknown }).path === 'string'
  ) {
    path = (op as { path: string }).path;
  }
  return { message, index, path };
}

/**
 * Read one location, by the same RFC 6901 rules `applyJsonPatch` writes by.
 *
 * A hand-rolled walk drifts from the library in ways an author cannot see: a
 * `Number()` coercion reads `/01` as index 1 though that token is not a valid
 * index, and a pointer missing its leading slash is silently misread rather
 * than refused. A read that disagrees with the write sends a repair at a
 * location the patch will not accept.
 *
 * Returns `undefined` when the pointer does not resolve.
 */
export function readJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  try {
    return jsonpatch.getValueByPointer(doc as object, pointer) as unknown;
  } catch {
    return undefined;
  }
}
