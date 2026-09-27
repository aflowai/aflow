/**
 * The names this machine already uses, told to the workspace before it records
 * a new one.
 *
 * A name is unique on the machine, while a workspace keys folders by (space,
 * id) — so a second workspace reaching a folder called `docs` is the ordinary
 * case, not a corner. Only the workspace knows which space a code redeems for,
 * which makes it the half that can tell a reconnect from a collision, and the
 * only half able to pick a name that collides with neither.
 */
import type { HostBinding } from './bindings.js';

export interface HostBindingNameInUse {
  readonly hostBindingId: string;
  readonly root: string;
  /** Absent for a binding written before the workspace was recorded. */
  readonly spaceId?: string;
}

export function namesInUseFor(bindings: readonly HostBinding[]): HostBindingNameInUse[] {
  return bindings.map((binding) => ({
    hostBindingId: binding.id,
    root: binding.root,
    ...(binding.spaceId !== undefined ? { spaceId: binding.spaceId } : {}),
  }));
}
