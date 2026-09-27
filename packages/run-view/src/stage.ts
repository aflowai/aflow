/**
 * The stage — which object the room is currently gathered around.
 *
 * Derived, never stored: the latest applet mount in the conversation IS the
 * staged instance, and there is exactly one card per instance. Every client folds the same items, so
 * every participant and every late joiner converges on the same stage with no
 * event, no state, and no migration. A session with no live applet has no
 * stage and renders exactly as before.
 */
import type { ConversationItem } from './types.js';

export interface StagedApplet {
  instanceId: string;
  /** The mount the stage grew out of — the stream renders it as a chip. */
  itemId: string;
}

export function deriveStagedApplet(items: readonly ConversationItem[]): StagedApplet | null {
  let staged: StagedApplet | null = null;
  let stagedAt = -Infinity;
  for (const item of items) {
    if (item.kind !== 'inline_applet') continue;
    if (item.createdAtMs >= stagedAt) {
      staged = { instanceId: item.instanceId, itemId: item.itemId };
      stagedAt = item.createdAtMs;
    }
  }
  return staged;
}
