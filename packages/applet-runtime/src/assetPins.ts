/**
 * The permitted set for the media channel: the assets an instance's own state
 * pins, derived from that state and nothing else.
 *
 * A view asking the host to read a document is asking it to read on the view's
 * behalf, and a view is untrusted code — an agent writes some of them. So the
 * request never widens the set: the state is walked afresh on every request,
 * and an asset that is not in it is refused. There is deliberately no
 * `collectFrom(allowlist)` shape here, because a stored allowlist is a thing a
 * later caller can hand in stale or widened.
 */
import {
  APPLET_JSON_MAX_DEPTH,
  AppletAssetPinSchema,
  appletAssetPinKey,
  type AppletAssetPin,
} from '@aflow/schemas';

/** Every asset the state pins, keyed by `appletAssetPinKey`. */
export function collectAppletAssetPins(
  state: Record<string, unknown>,
): Map<string, AppletAssetPin> {
  const pins = new Map<string, AppletAssetPin>();
  visit(state, APPLET_JSON_MAX_DEPTH, pins);
  return pins;
}

/**
 * Whether this exact asset — path, version and the bytes it was pinned to — is
 * referenced by the state. The whole triple has to match: a state that pins one
 * version of a path does not thereby permit another.
 */
export function appletStateReferencesAsset(
  state: Record<string, unknown>,
  asset: AppletAssetPin,
): boolean {
  return collectAppletAssetPins(state).has(appletAssetPinKey(asset));
}

function visit(node: unknown, depthLeft: number, pins: Map<string, AppletAssetPin>): void {
  if (depthLeft <= 0 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, depthLeft - 1, pins);
    return;
  }
  const parsed = AppletAssetPinSchema.safeParse(node);
  if (parsed.success) pins.set(appletAssetPinKey(parsed.data), parsed.data);
  for (const child of Object.values(node)) visit(child, depthLeft - 1, pins);
}
