import type { DirectiveConnectionRef } from '@aflow/schemas';
import type {
  ConnectionPlacement,
  SpaceConnection,
} from '../components/cybernetic/ConnectionPlacementEditor.js';

/**
 * A stored entry that names no binding grants its whole integration, so it is
 * the entry that answers for every binding of it.
 */
export function coversBinding(entry: DirectiveConnectionRef, connection: SpaceConnection): boolean {
  return (
    entry.sourceKind === connection.sourceKind &&
    entry.integrationId === connection.integrationId &&
    (entry.bindingId === undefined || entry.bindingId === connection.bindingId)
  );
}

/**
 * Placement per binding, or `null` when the agent stores no list at all — which
 * is what grants it every binding in the space.
 *
 * A connection absent from the returned map is one the stored list leaves out:
 * bound to the space, out of this agent's reach.
 */
export function connectionPlacements(
  stored: DirectiveConnectionRef[] | undefined,
  connections: SpaceConnection[],
): Record<string, ConnectionPlacement> | null {
  if (!stored) return null;
  const map: Record<string, ConnectionPlacement> = {};
  for (const c of connections) {
    const entry = stored.find((e) => coversBinding(e, c));
    if (entry) map[c.bindingId] = entry.placement;
  }
  return map;
}

/**
 * The list to store after one placement change, or `undefined` to store none.
 *
 * The list is an allowlist over what the agent may reach at all, so an edit
 * carries every connection forward — storing only the pinned ones would revoke
 * the rest. A list that was already stored keeps its exact membership for the
 * same reason: it is somebody's reach decision, and this control moves tiers.
 * An agent that had no list keeps none once nothing is pinned, because absence
 * is what grants every binding.
 *
 * A connection the stored list omits is APPENDED rather than ignored. Storing
 * the list at all freezes the agent's reach to the bindings of that moment, so
 * anything bound afterwards lands outside it — and this control is the only one
 * that writes the list. Without the append there is no way back in short of
 * hand-editing the directive.
 */
export function placeConnection(args: {
  stored: DirectiveConnectionRef[] | undefined;
  connections: SpaceConnection[];
  connection: SpaceConnection;
  placement: ConnectionPlacement;
}): DirectiveConnectionRef[] | undefined {
  const base: DirectiveConnectionRef[] =
    args.stored ??
    args.connections.map((c) => ({
      sourceKind: c.sourceKind,
      integrationId: c.integrationId,
      bindingId: c.bindingId,
      placement: 'on_demand',
    }));
  const next = base.some((e) => coversBinding(e, args.connection))
    ? base.map((e) => (coversBinding(e, args.connection) ? { ...e, placement: args.placement } : e))
    : [
        ...base,
        {
          sourceKind: args.connection.sourceKind,
          integrationId: args.connection.integrationId,
          bindingId: args.connection.bindingId,
          placement: args.placement,
        },
      ];
  if (args.stored === undefined && !next.some((e) => e.placement === 'always_on')) return undefined;
  return next;
}

/**
 * The list to store after one tool-subset change.
 *
 * `toolNames === undefined` clears the narrowing, which is how "all tools" is
 * expressed — distinct from an empty array, which pins none. Only ever applied
 * to an entry that already exists, since narrowing a connection presupposes
 * having placed it.
 */
export function setPinnedTools(args: {
  stored: DirectiveConnectionRef[] | undefined;
  connection: SpaceConnection;
  toolNames: string[] | undefined;
}): DirectiveConnectionRef[] | undefined {
  if (!args.stored) return args.stored;
  return args.stored.map((e) => {
    if (!coversBinding(e, args.connection)) return e;
    const { pinnedToolNames: _dropped, ...rest } = e;
    return args.toolNames === undefined ? rest : { ...rest, pinnedToolNames: args.toolNames };
  });
}

/** The tools an entry pins, or `null` when it pins all of them. */
export function pinnedToolsFor(
  stored: DirectiveConnectionRef[] | undefined,
  connection: SpaceConnection,
): string[] | null {
  const entry = stored?.find((e) => coversBinding(e, connection));
  return entry?.pinnedToolNames ?? null;
}
