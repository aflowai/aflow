import type {
  AgentToolSpec,
  CatalogConfig,
  DirectiveConnectionRef,
  IntegrationDiscoveryAllowEntry,
} from '@aflow/schemas';
import {
  DirectiveConnectionRefSchema,
  MAX_PINNED_TOOLS,
  applyBundlePlacements,
  getOperation,
  withGuaranteedReadOps,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type { VirtualToolEntry } from './agentTurn.js';

/**
 * Reading an operator's capability-bundle settings and applying them to a turn.
 *
 * Split from the turn assembler because none of it needs assembly context: it is
 * stored config in, a narrowed tool set out. The assembler keeps only the wiring.
 */

/**
 * Ceiling on the pinned tier, enforced by the surface assembler — which THROWS
 * on overflow rather than trimming, taking the turn with it. The number is the
 * one the settings surfaces quote and the write guard refuses against, so it
 * has a single owner; the assembler's name for it survives because the thrown
 * message carries it and the error classifier matches on that.
 */
export const MAX_TOTAL_TOOLS = MAX_PINNED_TOOLS;

/**
 * The operator's per-bundle placement map. Unreadable or absent means "authored
 * defaults" rather than an error: this is stored config that can be hand-edited
 * or left behind by a rename, and it must degrade to the platform's own layout
 * instead of failing every turn in the space.
 */
export function resolveBundlePlacements(directives: unknown): Record<string, string> {
  const raw = (directives as { capabilityDiscovery?: { bundlePlacements?: unknown } } | undefined)
    ?.capabilityDiscovery?.bundlePlacements;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[id] = value;
  }
  return out;
}

/**
 * The operator's explicit per-agent connection allowlist, or `undefined` to
 * leave the agent's authored integration mode alone. An empty list is
 * meaningful and preserved — it means "no connections", not "unset".
 *
 * Entries are parsed against the stored contract rather than hand-narrowed, so
 * a field added to the directive arrives here without a second definition to
 * keep in step. A malformed entry is skipped: this is hand-editable config, and
 * one bad row must not take the turn down with it.
 */
export function resolveConnectionAllowlist(
  directives: unknown,
): DirectiveConnectionRef[] | undefined {
  const raw = (directives as { capabilityDiscovery?: { connections?: unknown } } | undefined)
    ?.capabilityDiscovery?.connections;
  if (!Array.isArray(raw)) return undefined;
  const entries: DirectiveConnectionRef[] = [];
  for (const c of raw) {
    const parsed = DirectiveConnectionRefSchema.safeParse(c);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** A discovery scope decides reach; `placement` is a tier control and has none. */
function toReachEntry(entry: DirectiveConnectionRef): IntegrationDiscoveryAllowEntry {
  return {
    sourceKind: entry.sourceKind,
    integrationId: entry.integrationId,
    ...(entry.bindingId !== undefined ? { bindingId: entry.bindingId } : {}),
  };
}

/** One binding an operator placed `always_on`, as the pinned tier resolves it. */
export interface PinnedConnection {
  sourceKind: 'api' | 'mcp';
  integrationId: string;
  bindingId: string;
  /** Pin only these tools. Absent pins all of them. Tier, never reach. */
  toolNames?: string[];
}

/**
 * The bindings an operator's always-on connections name.
 *
 * Binding-exact by necessity. A pinned tool carries its binding to the
 * executor, and a tool that names only an integration lets the executor
 * scope-resolve whichever binding of it comes first — so pinning by integration
 * would let an agent transact through a sibling binding the allowlist excludes.
 * That is reach, and placement is not allowed to grant any. An entry naming no
 * binding therefore stays on demand, where promote resolves the binding under
 * the allowlist's own rules.
 */
function resolvePinnedConnections(
  connections: readonly DirectiveConnectionRef[],
): PinnedConnection[] {
  const pinned: PinnedConnection[] = [];
  const seen = new Set<string>();
  const unbound: string[] = [];
  for (const entry of connections) {
    if (entry.placement !== 'always_on') continue;
    if (entry.bindingId === undefined) {
      unbound.push(`${entry.sourceKind}:${entry.integrationId}`);
      continue;
    }
    const key = `${entry.sourceKind}:${entry.bindingId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Absent means no narrowing, so every tool pins. An empty list is a
    // narrowing to nothing, so none do — and the connection is skipped rather
    // than pinned-with-zero-tools. Reading empty as "all" instead would spend
    // an operator's cap on tools they explicitly cleared, which is the failure
    // this whole control exists to prevent.
    if (entry.pinnedToolNames?.length === 0) continue;
    pinned.push({
      sourceKind: entry.sourceKind,
      integrationId: entry.integrationId,
      bindingId: entry.bindingId,
      ...(entry.pinnedToolNames ? { toolNames: entry.pinnedToolNames } : {}),
    });
  }
  if (unbound.length > 0) {
    getOrchestratorLogger().warn(
      `[capabilityShedding] always-on connections naming no binding stay on-demand ` +
        `(pinning is per binding): ${unbound.join(', ')}`,
    );
  }
  return pinned;
}

/**
 * The pinned connections that still fit under the ceiling, whole ones only.
 *
 * How many tools a connection carries is only known once its bindings resolve,
 * so this is the last point where an operator's list can be held under the cap
 * — past it the assembler throws and the turn is lost. A connection too large
 * for the room left is skipped rather than ending the walk, so one broad API
 * does not shut out the small connections behind it, and half an API's
 * endpoints is never a surface anyone chose.
 */
export function admitConnectionsWithinCap(
  pinnedSoFar: number,
  connectionToolSpecs: AgentToolSpec[] | undefined,
): AgentToolSpec[] {
  if (!connectionToolSpecs || connectionToolSpecs.length === 0) return [];

  const byBinding = new Map<string, AgentToolSpec[]>();
  for (const spec of connectionToolSpecs) {
    const bindingId = spec.apiMeta?.bindingId ?? spec.mcpMeta?.bindingId ?? spec.toolId;
    const group = byBinding.get(bindingId) ?? [];
    group.push(spec);
    byBinding.set(bindingId, group);
  }

  const admitted: AgentToolSpec[] = [];
  const dropped: string[] = [];
  let count = pinnedSoFar;
  for (const [bindingId, group] of byBinding) {
    if (count + group.length > MAX_TOTAL_TOOLS) {
      dropped.push(`${bindingId} (${String(group.length)} tools)`);
      continue;
    }
    admitted.push(...group);
    count += group.length;
  }

  if (dropped.length > 0) {
    getOrchestratorLogger().warn(
      `[capabilityShedding] always-on connections would breach the pinned tool cap ` +
        `(${String(MAX_TOTAL_TOOLS)}); left on-demand: ${dropped.join(', ')}`,
    );
  }
  return admitted;
}

export interface CapabilitySettings {
  catalogConfig: CatalogConfig | undefined;
  /** Groups the operator shed, for revoking already-promoted tools. */
  shedCapabilityGroups: ReadonlySet<string> | undefined;
  connectionAllowlist: DirectiveConnectionRef[] | undefined;
  /** The subset of the allowlist to pin, or `undefined` when there is no list. */
  pinnedConnections: PinnedConnection[] | undefined;
}

/**
 * Fold an operator's capability settings into a turn's catalog config.
 *
 * One setting drives both tiers: the pinned list loses its tools outright, and
 * the same capability groups join `excludeGroupIds` so discovery cannot re-offer
 * what was just removed.
 *
 * The read floor is re-asserted AFTER shedding: upstream it short-circuits on
 * the Helmsman's pinned `memory.store.get` and adds nothing, so shedding Memory
 * would otherwise leave the agent unable to re-read a truncated run output
 * (Plan 196 §4.9). The floor is a platform invariant, not a capability the
 * operator is choosing between.
 */
export function applyCapabilitySettings(
  catalogConfig: CatalogConfig | undefined,
  directives: unknown,
): CapabilitySettings {
  if (!catalogConfig || directives === undefined) {
    return {
      catalogConfig,
      shedCapabilityGroups: undefined,
      connectionAllowlist: undefined,
      pinnedConnections: undefined,
    };
  }

  let next = catalogConfig;
  let shedCapabilityGroups: ReadonlySet<string> | undefined;

  const placements = resolveBundlePlacements(directives);
  if (Object.keys(placements).length > 0) {
    const placed = applyBundlePlacements(
      next.coreOperations ?? [],
      next.discovery?.allowedOperationIds ?? [],
      placements,
    );
    next = { ...next, coreOperations: placed.coreOperations };
    // The read floor is re-asserted AFTER placement: upstream it short-circuits
    // on the Helmsman's pinned `memory.store.get` and adds nothing, so moving
    // Memory off would otherwise leave the agent unable to re-read a truncated
    // run output (Plan 196 §4.9). It is a platform invariant, not a placement.
    next = withGuaranteedReadOps(next);
    shedCapabilityGroups = placed.offCapabilityGroups;
    if (next.discovery) {
      const existingExcludes = next.discovery.excludeGroupIds ?? [];
      next = {
        ...next,
        discovery: {
          ...next.discovery,
          // Rewritten, not merged: a bundle moved to on_demand must become
          // reachable even when it was pinned-only before, and one moved to
          // always_on must leave the ceiling it no longer needs.
          allowedOperationIds: placed.discoverableOperationIds,
          excludeGroupIds: [...new Set([...existingExcludes, ...placed.offCapabilityGroups])],
        },
      };
    }
  }

  // Per-agent connection reach. The space keeps every binding; an explicit list
  // narrows what THIS agent may see, so a connection bound for a Runner need
  // not be handed to the Helmsman.
  const connectionAllowlist = resolveConnectionAllowlist(directives);
  if (connectionAllowlist && next.discovery) {
    next = {
      ...next,
      discovery: {
        ...next.discovery,
        integrations: {
          ...(next.discovery.integrations ?? {}),
          mode: 'allowlist',
          // The FULL list, both placements: reach is what a discovery scope
          // decides, and an always-on connection stays discoverable too.
          allowed: connectionAllowlist.map(toReachEntry),
        },
      },
    };
  }

  return {
    catalogConfig: next,
    shedCapabilityGroups,
    connectionAllowlist,
    // Resolved outside the discovery guard on purpose: pinning is where the
    // tokens are, and it has nothing to do with whether this agent was
    // authored with a discovery block.
    pinnedConnections: connectionAllowlist
      ? resolvePinnedConnections(connectionAllowlist)
      : undefined,
  };
}

/** `api:<bindingId>/<tool>` / `mcp:<bindingId>/<tool>` — the promoted-tool id shape. */
const INTEGRATION_TOOL_ID = /^(api|mcp):([^/]+)\//;

interface ConnectionReach {
  /** Binding ids named outright, per source kind. */
  exact: Record<'api' | 'mcp', Set<string>>;
  /**
   * Source kinds carrying an entry with no `bindingId`. Such an entry means
   * "every binding of this integration", and a promoted tool id carries only
   * the concrete binding — so membership cannot be decided without binding
   * metadata this layer does not have.
   */
  unresolvable: Set<'api' | 'mcp'>;
}

function connectionReach(allowlist: IntegrationDiscoveryAllowEntry[]): ConnectionReach {
  const reach: ConnectionReach = {
    exact: { api: new Set(), mcp: new Set() },
    unresolvable: new Set(),
  };
  for (const entry of allowlist) {
    if (entry.bindingId === undefined) reach.unresolvable.add(entry.sourceKind);
    else reach.exact[entry.sourceKind].add(entry.bindingId);
  }
  return reach;
}

/**
 * Drop already-promoted tools that the operator has since shed.
 *
 * Shedding `coreOperations` is not enough on its own: `_virtualTools` is
 * session state, and the surface rebuild re-materializes every entry in it on
 * each turn without consulting the discovery scope (`excludeGroupIds` is read
 * at search, promote, and awareness — none of which run on a rebuild). Without
 * this, an agent that promoted `compute.sandbox.exec` on turn 3 keeps calling
 * it for the rest of the session after Code is switched off on turn 4.
 *
 * The same holds for integration tools against the connection allowlist: their
 * specs resolve from the session cache rather than the integration reader, so
 * narrowing connections would otherwise only bound future discovery.
 *
 * Matching is on the `(sourceKind, bindingId)` pair, never the id alone: api
 * and mcp bindings live in separate tables and can share an id, so a flat set
 * would let `api/shared` keep `mcp:shared/...` alive. Where an entry cannot be
 * evaluated (see `ConnectionReach.unresolvable`) the tool is KEPT — revoking on
 * a guess breaks a working agent, and the promote path remains authoritative
 * for anything acquired later.
 */
export function withPromotedToolsRevoked(
  virtualToolsState: Record<string, VirtualToolEntry> | undefined,
  shedCapabilityGroups: ReadonlySet<string> | undefined,
  connectionAllowlist: IntegrationDiscoveryAllowEntry[] | undefined,
): Record<string, VirtualToolEntry> | undefined {
  if (!virtualToolsState) return undefined;
  const shedsOps = shedCapabilityGroups !== undefined && shedCapabilityGroups.size > 0;
  if (!shedsOps && connectionAllowlist === undefined) return virtualToolsState;

  const reach = connectionAllowlist ? connectionReach(connectionAllowlist) : undefined;

  const kept: Record<string, VirtualToolEntry> = {};
  for (const [toolId, entry] of Object.entries(virtualToolsState)) {
    const match = INTEGRATION_TOOL_ID.exec(toolId);
    if (match) {
      if (reach) {
        const sourceKind = match[1] as 'api' | 'mcp';
        const bindingId = match[2] ?? '';
        if (!reach.unresolvable.has(sourceKind) && !reach.exact[sourceKind].has(bindingId))
          continue;
      }
      kept[toolId] = entry;
      continue;
    }
    if (shedsOps) {
      const op = getOperation(toolId);
      if (op && shedCapabilityGroups.has(op.capabilityGroupId)) continue;
    }
    kept[toolId] = entry;
  }
  return kept;
}
