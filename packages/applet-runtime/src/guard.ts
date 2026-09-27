/**
 * Action-guard evaluation — the gateway's declarative pre-apply assertion.
 * Pure pointer dereferencing over `{ state }` and the validated input: the
 * applet declares what must hold, the platform never runs domain code.
 */
import { canonicalJsonStringify } from './json.js';
import { materializeAppletPathTemplate } from './template.js';
import { resolveJsonPointer } from './pointer.js';
import { AppletTemplateError } from './errors.js';
import type { AppletActionGuard } from '@aflow/schemas';

export type AppletGuardVerdict = { ok: true } | { ok: false; message: string };

export function evaluateAppletActionGuard(params: {
  guard: AppletActionGuard;
  state: Record<string, unknown>;
  input: Record<string, unknown>;
}): AppletGuardVerdict {
  const { guard, state, input } = params;
  const doc = { state };

  if (guard.bypass !== undefined) {
    const bypass = resolveJsonPointer({ input }, guard.bypass);
    if (bypass.found && bypass.value === true) return { ok: true };
  }

  if (guard.freshness !== undefined) {
    const stamp = resolveJsonPointer(doc, guard.freshness.stamp);
    const tracked = resolveJsonPointer(doc, guard.freshness.matchesLengthOf);
    const fresh =
      stamp.found &&
      typeof stamp.value === 'number' &&
      tracked.found &&
      Array.isArray(tracked.value) &&
      tracked.value.length === stamp.value;
    if (!fresh) {
      return guard.onUnverifiable === 'allow'
        ? { ok: true }
        : { ok: false, message: guard.message };
    }
  }

  let path: string;
  try {
    path = materializeAppletPathTemplate(guard.assert, input);
  } catch (err) {
    if (err instanceof AppletTemplateError) return { ok: false, message: guard.message };
    throw err;
  }
  const asserted = resolveJsonPointer(doc, path);
  if (!asserted.found) return { ok: false, message: guard.message };
  if (canonicalJsonStringify(asserted.value) !== canonicalJsonStringify(guard.equals)) {
    return { ok: false, message: guard.message };
  }
  return { ok: true };
}
