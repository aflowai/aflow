/**
 * Structural bounding of a /state-confined RFC 6902 patch — the gateway's
 * "bound the patch" step. Re-checks confinement even for schema-parsed
 * patches: materialized template patches and stored patches replay through
 * the same gate.
 */
import {
  APPLET_JSON_POINTER_MAX_LENGTH,
  APPLET_STATE_POINTER_PREFIX,
  APPLET_STATE_POINTER_RE,
  resolveAppletLimits,
  type AppletLimits,
  type AppletStatePatchOp,
} from '@aflow/schemas';
import { AppletPatchBoundsError } from './errors.js';
import { exceedsJsonDepth, jsonUtf8Bytes } from './json.js';

export function boundAppletStatePatch(
  patch: readonly AppletStatePatchOp[],
  limits: AppletLimits = resolveAppletLimits(),
): void {
  if (patch.length === 0) {
    throw new AppletPatchBoundsError('patch_empty', 'Patch carries no operations');
  }
  if (patch.length > limits.maxPatchOps) {
    throw new AppletPatchBoundsError(
      'patch_too_many_ops',
      `Patch has ${patch.length} operations (max ${limits.maxPatchOps})`,
    );
  }
  const bytes = jsonUtf8Bytes(patch);
  if (bytes > limits.maxStateBytes) {
    throw new AppletPatchBoundsError(
      'patch_too_large',
      `Patch serializes to ${bytes} bytes (max ${limits.maxStateBytes})`,
    );
  }
  patch.forEach((op, index) => {
    assertStatePointer(op.path, index);
    if (op.from !== undefined) assertStatePointer(op.from, index);
    if (op.value !== undefined && exceedsJsonDepth(op.value, limits.maxJsonDepth)) {
      throw new AppletPatchBoundsError(
        'patch_value_too_deep',
        `Operation ${index} value nests deeper than ${limits.maxJsonDepth} levels`,
        index,
        op.path,
      );
    }
  });
}

function assertStatePointer(pointer: string, opIndex: number): void {
  if (pointer.length > APPLET_JSON_POINTER_MAX_LENGTH) {
    throw new AppletPatchBoundsError(
      'pointer_too_long',
      `Operation ${opIndex} pointer exceeds ${APPLET_JSON_POINTER_MAX_LENGTH} characters`,
      opIndex,
      pointer,
    );
  }
  if (!APPLET_STATE_POINTER_RE.test(pointer)) {
    throw new AppletPatchBoundsError(
      'patch_outside_state',
      `Operation ${opIndex} targets '${pointer}' — patches are confined to '${APPLET_STATE_POINTER_PREFIX}'`,
      opIndex,
      pointer,
    );
  }
}
