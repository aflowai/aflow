/**
 * Apply a bounded /state-confined patch to a state body. Patch paths are
 * rooted at '/state', so the patch runs against a `{ state }` wrapper — the
 * same shape as the stored instance document.
 */
import { applyJsonPatch, JsonPatchError, type JsonPatchOperation } from '@aflow/lib';
import type { AppletStatePatchOp } from '@aflow/schemas';
import { AppletPatchApplyError } from './errors.js';
import { isJsonRecord } from './json.js';

export function applyAppletStatePatch(
  state: Record<string, unknown>,
  patch: readonly AppletStatePatchOp[],
): Record<string, unknown> {
  const doc: unknown = { state };
  let patched: unknown;
  try {
    patched = applyJsonPatch(doc, patch as readonly JsonPatchOperation[]);
  } catch (err) {
    if (err instanceof JsonPatchError) {
      throw new AppletPatchApplyError('apply_failed', err.message, err.opIndex, err.opPath);
    }
    throw err;
  }
  if (!isJsonRecord(patched) || !isJsonRecord(patched['state'])) {
    throw new AppletPatchApplyError(
      'state_shape_lost',
      "Patch left the document without an object '/state' subtree",
    );
  }
  return patched['state'];
}
