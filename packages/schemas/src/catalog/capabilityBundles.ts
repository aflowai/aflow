import { getOperation } from './registry.js';
import { MEMORY_READ_OPERATION_ID, RUN_OUTPUT_READ_OPERATION_ID } from './operationId.js';

/**
 * Operator-facing groupings of capability groups.
 *
 * Capability groups (`stepType.group`) are the enforcement key and there are 34
 * of them across a platform agent's surface — the right granularity for a grant
 * check and far too fine for a control an operator reads. A bundle is the unit
 * an operator toggles; the groups underneath stay the unit the orchestrator
 * enforces.
 *
 * `tier` records what a bundle actually costs, which is what makes the control
 * legible: `loaded` bundles contribute pinned tool schemas to every single turn,
 * `on_demand` defers tool schemas until promotion; compact discovery awareness
 * still has a context cost.
 */
export type CapabilityBundleTier = 'loaded' | 'on_demand';

export interface CapabilityBundle {
  id: string;
  /** Operator-facing label. Minimal by design — the hint carries the detail. */
  label: string;
  hint: string;
  tier: CapabilityBundleTier;
  /**
   * Refusing to shed this bundle is a platform decision, not a preference, so
   * the reason travels with it and is shown rather than hidden.
   */
  locked?: { reason: string };
  /**
   * Capability groups this bundle owns. An entry is either a whole group
   * (`memory.store`) or one access mode of it (`memory.store:write`), which is
   * how a group whose reads and writes are different decisions can be split
   * without inventing an axis — capability profiles already grant on exactly
   * this pair.
   */
  capabilityGroupIds: readonly string[];
  operationIds?: readonly string[];
  parentId?: string;
}

export const CAPABILITY_BUNDLES: readonly CapabilityBundle[] = [
  {
    id: 'chat',
    label: 'Chat',
    hint: 'Ask questions and raise cards for your attention.',
    tier: 'loaded',
    locked: { reason: 'how it reaches you' },
    capabilityGroupIds: ['human.chat', 'human.action_center'],
  },
  {
    id: 'discovery',
    label: 'Capability discovery',
    hint: 'Search the catalog and add tools when they are needed.',
    tier: 'loaded',
    // Dropping catalog.tool.search does not merely remove three tools: its
    // presence is what selects the compact awareness rollup over the format
    // that enumerates every promotable operation id, so shedding it costs far
    // more prompt than it saves.
    locked: { reason: 'holds the surface compact' },
    capabilityGroupIds: ['catalog.tool', 'catalog.skill'],
  },
  {
    id: 'memory_read',
    label: 'Memory · read',
    hint: 'Search and read this space’s notes, documents, and standing context.',
    tier: 'loaded',
    capabilityGroupIds: ['memory.store:read', 'memory.context:read', 'memory.run_output'],
  },
  {
    id: 'memory_write',
    label: 'Memory · write',
    hint: 'Record, edit, and remove notes and standing context.',
    tier: 'on_demand',
    capabilityGroupIds: ['memory.store:write', 'memory.context:write'],
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Keep the space’s plan: what is being worked on, what it is for, and when it is done.',
    tier: 'loaded',
    capabilityGroupIds: ['plan.node'],
  },
  {
    id: 'run_skills',
    label: 'Run skills',
    hint: 'Start, resume, cancel and inspect skill runs.',
    tier: 'loaded',
    capabilityGroupIds: ['workflow.run'],
    parentId: 'skills',
  },
  {
    id: 'author_skills',
    label: 'Edit skills',
    hint: 'Edit skill definitions and inspect detailed run ledgers.',
    tier: 'on_demand',
    capabilityGroupIds: ['workflow.manage', 'workflow.ledger', 'workflow', 'skill.manage'],
    parentId: 'skills',
  },
  {
    id: 'visuals',
    label: 'Visuals',
    hint: 'Render existing artifacts and inline visualizations.',
    tier: 'on_demand',
    capabilityGroupIds: ['ui.surface', 'ui.artifact', 'ui.catalog'],
    operationIds: ['ui.artifact.render', 'ui.surface.visualize'],
    parentId: 'visuals',
  },
  {
    id: 'web',
    label: 'Web',
    hint: 'Search the web and fetch pages.',
    tier: 'loaded',
    capabilityGroupIds: ['search.web'],
  },
  {
    id: 'learning',
    label: 'Learning changes',
    hint: 'Review and update what skill runs carry forward.',
    tier: 'on_demand',
    capabilityGroupIds: [
      'learner.learning',
      'learner.flag',
      'learner.observation',
      'learner.propose',
      'learner.review',
    ],
  },
  {
    id: 'integrations',
    label: 'HTTP definitions',
    hint: 'Define and edit the HTTP services this space calls. Bound tools are managed under Connections.',
    tier: 'on_demand',
    parentId: 'http_setup',
    capabilityGroupIds: ['api.definition'],
  },
  {
    id: 'mcp_servers',
    label: 'MCP servers',
    hint: 'Register and bind MCP servers. Separate from Integrations because an MCP server is a different substrate from an HTTP API — most spaces use one or the other.',
    tier: 'on_demand',
    // The largest single split available: 14 tools and ~3k tokens, roughly half
    // of what Integrations cost before. A space wiring up REST services was
    // paying all of it for a protocol it never speaks, and the reverse holds
    // too. The boundary is real rather than a size heuristic — these ops share
    // no schema, no binding shape and no call path with the HTTP ones.
    capabilityGroupIds: ['mcp.server'],
    parentId: 'mcp_setup',
  },
  {
    id: 'simulations',
    label: 'Simulations',
    hint: 'Author and inspect the worlds that answer an API without a host. Only a space building against a service that does not exist yet needs these.',
    tier: 'on_demand',
    // Split from Integrations rather than folded into it. A space wiring up
    // real services carries no simulations, and paying for the authoring
    // surface of a feature it does not use is the cost this control exists to
    // let an operator shed. `integration.simulation.upsert` alone prices near
    // 2k tokens — the artifact it takes IS the schema.
    capabilityGroupIds: ['integration.simulation'],
  },
  {
    id: 'help',
    label: 'Product help',
    hint: 'Aflow’s own help articles, the ones on the Help page: how the product works, where things are, how to set them up.',
    tier: 'on_demand',
    capabilityGroupIds: ['catalog.help'],
  },
  {
    id: 'store',
    label: 'Store',
    hint: 'Find skills and services this space does not have yet. Installing one raises a proposal for you to approve.',
    tier: 'on_demand',
    capabilityGroupIds: ['store.listing'],
  },
  {
    id: 'media',
    label: 'Video & animation',
    hint: 'Generate and edit images and video. Billed per call.',
    tier: 'on_demand',
    capabilityGroupIds: ['ai.media'],
    parentId: 'media',
  },
  {
    id: 'code',
    label: 'Sandbox',
    hint: 'Run code in a sandbox, read repositories, drive the coding lane.',
    tier: 'on_demand',
    capabilityGroupIds: ['compute.sandbox'],
    parentId: 'code',
  },
  {
    id: 'host_files',
    label: 'Files on this computer',
    hint: 'Read and write inside a folder the operator connected, in place on their machine.',
    tier: 'on_demand',
    capabilityGroupIds: ['host.file'],
  },
  {
    id: 'host_commands',
    label: 'Commands on this computer',
    hint: "Run the operator's own tools inside a connected project. Separate from file access.",
    tier: 'on_demand',
    capabilityGroupIds: ['host.process'],
  },
  {
    id: 'host_mcp',
    label: 'Local MCP servers',
    hint: "Use MCP servers installed on the operator's computer. They run inside a connected folder rather than being trusted to stay in one.",
    tier: 'on_demand',
    // Separate from the remote MCP bundle even though the protocol is the same.
    // What differs is who is confining whom: a remote server polices its own
    // side of a network boundary, a local one has the operator's filesystem
    // underneath it and is confined by the operating system.
    capabilityGroupIds: ['host.mcp'],
  },
  {
    id: 'host_harness',
    label: 'Coding agents on this computer',
    hint: 'Put a coding agent the operator already installed to work on a connected repository. Returns a diff; changes nothing in place.',
    tier: 'on_demand',
    // Separate from host_commands even though a harness is a command. The two
    // are chosen for different reasons — one to run a build, one to delegate a
    // change — and a space that wants a harness should not have to take a
    // general shell to get it.
    capabilityGroupIds: ['host.harness'],
  },
  {
    id: 'browser',
    label: 'Browser',
    hint: 'Open and use web pages in a real browser on the operator’s machine, with the sign-ins its profile holds. browser.profile.list says which sites hold a session.',
    tier: 'on_demand',
    capabilityGroupIds: ['browser.page', 'browser.profile'],
  },
  {
    id: 'local_models',
    label: 'Models on this computer',
    hint: 'Read why the model on this computer is slow or not answering, and propose the fix for the operator to approve: download, delete, load, unload, or the window its requests get.',
    tier: 'on_demand',
    capabilityGroupIds: ['model.runtime'],
  },
  {
    id: 'http',
    label: 'Direct HTTP',
    hint: 'Call a bound endpoint raw. The connection is the normal path.',
    tier: 'on_demand',
    capabilityGroupIds: ['api.http'],
  },
  {
    id: 'delegation',
    label: 'Delegation',
    hint: 'Run work in a child session and answer back.',
    tier: 'on_demand',
    capabilityGroupIds: ['agent.control'],
  },
  {
    id: 'agents',
    label: 'Agents',
    hint: 'Create and browse agent definitions.',
    tier: 'on_demand',
    capabilityGroupIds: ['agent.manage', 'catalog.agent'],
  },
  {
    id: 'evaluations',
    label: 'Evaluations',
    hint: 'Read a skill’s golden dataset and run measurement batches over it.',
    tier: 'on_demand',
    // The agent-permitted slice only (Plan 269 D7): dataset reads, draft
    // promotion, batch launch and comparison. Every dataset or label WRITE is
    // an operator-only server route with no operation behind it, so there is
    // nothing here for a bundle to offer.
    capabilityGroupIds: ['eval.dataset', 'eval.case', 'eval.batch'],
  },
  {
    id: 'guardrails',
    label: 'Guardrails',
    hint: 'Author policies and review what tripped them.',
    tier: 'on_demand',
    capabilityGroupIds: ['guardrail.policy', 'guardrail.violation'],
  },
  {
    id: 'schedules',
    label: 'Schedules',
    hint: 'Set skills to run on a recurring schedule.',
    tier: 'on_demand',
    capabilityGroupIds: ['agent.schedule'],
  },
  {
    id: 'applets',
    label: 'Applets',
    hint: 'Start and read shared interactive documents.',
    tier: 'on_demand',
    capabilityGroupIds: ['ui.applet'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    hint: 'Email you and ask for approvals outside the chat.',
    tier: 'on_demand',
    capabilityGroupIds: ['user.notification', 'user.interaction'],
  },
  {
    id: 'space',
    label: 'Space',
    hint: 'Read this space and preview archiving it.',
    tier: 'on_demand',
    capabilityGroupIds: ['space.manage'],
  },
  {
    id: 'inspect_skills',
    label: 'Inspect skills',
    hint: 'Read a skill and its invocation contract.',
    tier: 'loaded',
    capabilityGroupIds: [],
    operationIds: ['workflow.manage.get'],
    parentId: 'skills',
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    hint: 'Browse and manage long-running skill campaigns.',
    tier: 'on_demand',
    capabilityGroupIds: ['workflow.campaign'],
    parentId: 'skills',
  },
  {
    id: 'proposals',
    label: 'Proposals',
    hint: 'Inspect proposals requiring operator attention.',
    tier: 'loaded',
    capabilityGroupIds: ['proposal'],
    parentId: 'learning',
  },
  {
    id: 'workflow_learning',
    label: 'Run learnings',
    hint: 'Record a skill run’s learnings.',
    tier: 'on_demand',
    capabilityGroupIds: [],
    operationIds: ['workflow.learn'],
    parentId: 'learning',
  },
  {
    id: 'connection_inventory',
    label: 'Connection inventory',
    hint: 'Find the API and MCP services bound in this space.',
    tier: 'on_demand',
    capabilityGroupIds: ['integration.registry'],
    parentId: 'http_setup',
  },
  {
    id: 'http_bindings',
    label: 'HTTP bindings',
    hint: 'Connect HTTP services and check their credentials.',
    tier: 'on_demand',
    capabilityGroupIds: ['api.binding'],
    parentId: 'http_setup',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    hint: 'Configure incoming service events.',
    tier: 'on_demand',
    capabilityGroupIds: ['api.webhook'],
    parentId: 'http_setup',
  },
  {
    id: 'mcp_bindings',
    label: 'MCP bindings',
    hint: 'Connect remote MCP servers.',
    tier: 'on_demand',
    capabilityGroupIds: ['mcp.binding'],
    parentId: 'mcp_setup',
  },
  {
    id: 'mcp_inventory',
    label: 'MCP tool inventory',
    hint: 'Inspect tools offered by remote servers.',
    tier: 'on_demand',
    capabilityGroupIds: ['mcp.tool'],
    parentId: 'mcp_setup',
  },
  {
    id: 'artifacts',
    label: 'Build artifacts',
    hint: 'Generate and inspect visual artifacts.',
    tier: 'on_demand',
    capabilityGroupIds: [],
    operationIds: ['ui.artifact.generate', 'ui.artifact.get', 'ui.artifact.list', 'ui.catalog.get'],
    parentId: 'visuals',
  },
  {
    id: 'images',
    label: 'Images',
    hint: 'Generate and edit images.',
    tier: 'on_demand',
    capabilityGroupIds: [],
    operationIds: ['ai.media.image', 'ai.media.edit_image'],
    parentId: 'media',
  },
  {
    id: 'repositories',
    label: 'Repository inspection',
    hint: 'Inspect connected repositories.',
    tier: 'on_demand',
    capabilityGroupIds: ['code.repo'],
    parentId: 'code',
  },
  {
    id: 'managed_code',
    label: 'Managed coding lane',
    hint: 'Commission code changes on a managed checkout.',
    tier: 'on_demand',
    capabilityGroupIds: ['code.agent'],
    parentId: 'code',
  },
];

const BUNDLE_BY_GROUP: ReadonlyMap<string, CapabilityBundle> = new Map(
  CAPABILITY_BUNDLES.flatMap((b) => b.capabilityGroupIds.map((g) => [g, b] as const)),
);

/**
 * The bundle owning a group at an access mode. The mode-qualified key wins so a
 * split group (`memory.store:write`) beats a whole-group claim, and a bundle
 * that names the plain group still covers both modes.
 */
function bundleForGroupAccess(
  capabilityGroupId: string,
  accessMode: string | undefined,
): CapabilityBundle | undefined {
  if (accessMode !== undefined) {
    const qualified = BUNDLE_BY_GROUP.get(`${capabilityGroupId}:${accessMode}`);
    if (qualified) return qualified;
  }
  return BUNDLE_BY_GROUP.get(capabilityGroupId);
}

export function getCapabilityBundle(bundleId: string): CapabilityBundle | undefined {
  return CAPABILITY_BUNDLES.find((b) => b.id === bundleId);
}

/** The bundle owning a capability group, or undefined when the group is unassigned. */
export function bundleForCapabilityGroup(
  capabilityGroupId: string,
  accessMode?: string,
): CapabilityBundle | undefined {
  return bundleForGroupAccess(capabilityGroupId, accessMode);
}

/** The bundle owning an operation, resolved through its capability group. */
export function bundleForOperation(operationId: string): CapabilityBundle | undefined {
  const exact = CAPABILITY_BUNDLES.find((b) => b.operationIds?.includes(operationId));
  if (exact) return exact;
  const op = getOperation(operationId);
  if (!op) return undefined;
  return bundleForGroupAccess(op.capabilityGroupId, op.accessMode);
}

/**
 * The capability groups covered by `bundleIds`. Unknown ids contribute nothing
 * rather than throwing: a stored directive naming a bundle that has since been
 * renamed must degrade to "not disabled", never to a failed turn.
 */
export function capabilityGroupsForBundles(bundleIds: readonly string[]): Set<string> {
  const groups = new Set<string>();
  for (const id of bundleIds) {
    const bundle = getCapabilityBundle(id);
    if (!bundle) continue;
    for (const g of bundle.capabilityGroupIds) groups.add(g);
  }
  return groups;
}

/**
 * The bundles an agent's surface actually spans, in registry order.
 *
 * The registry is total over the catalog so enforcement and the guard test can
 * rely on it, which means it names capability no single agent holds — eval and
 * guardrail authoring, agent CRUD, raw HTTP. Offering those in a control for an
 * agent that can never reach them is noise, so the offer is DERIVED from the
 * surface rather than kept as a per-agent list that would rot the first time a
 * preset changed. Pass the agent's pinned operations plus its discovery
 * ceiling.
 */
export function bundlesForSurface(operationIds: Iterable<string>): CapabilityBundle[] {
  const present = new Set<string>();
  for (const opId of operationIds) {
    const bundle = bundleForOperation(opId);
    if (bundle) present.add(bundle.id);
  }
  return CAPABILITY_BUNDLES.filter((b) => present.has(b.id));
}

/**
 * Where a bundle's operations sit for an agent.
 *
 * The authored `tier` is the DEFAULT placement, not a fixed fact — an operator
 * moves a bundle between these, and the same value expresses both "stop paying
 * for this every turn" and "stop offering it at all".
 */
export type CapabilityBundlePlacement = 'always_on' | 'on_demand' | 'off';

/** The default placement for a bundle, from its authored tier. */
export function defaultPlacement(bundle: CapabilityBundle): CapabilityBundlePlacement {
  return bundle.tier === 'loaded' ? 'always_on' : 'on_demand';
}

/**
 * A bundle's effective placement. A locked bundle refuses every value: the
 * reason it is locked does not stop applying because a stored setting says so.
 */
export function effectivePlacement(
  bundle: CapabilityBundle,
  placements: Readonly<Record<string, string>> | undefined,
): CapabilityBundlePlacement {
  if (bundle.locked) return 'always_on';
  const stored = placements?.[bundle.id];
  return stored === 'always_on' || stored === 'on_demand' || stored === 'off'
    ? stored
    : defaultPlacement(bundle);
}

/**
 * The one field these helpers read. Structural rather than `CatalogConfig` so
 * the catalog module stays free of a runtime import it would only need for a
 * field name — and generic at the call site so a caller's richer config type
 * survives the round trip.
 */
export interface ShedableCatalogConfig {
  coreOperations?: string[] | undefined;
}

export interface PlacedSurface {
  /** Pinned every turn — these carry the per-turn schema cost. */
  coreOperations: string[];
  /** Reachable through discovery, with schemas loaded only when promoted. */
  discoverableOperationIds: string[];
  offOperationIds: Set<string>;
}

/**
 * Redistribute an agent's authored surface according to operator placement.
 *
 * The load-bearing rule: placement moves operations BETWEEN the pinned list and
 * the discovery ceiling, and only `off` removes anything. `coreOperations ∪
 * discoverable` is therefore invariant except where a bundle is off, so
 * `always_on` can never widen what an agent may do — it only decides what is
 * paid for on every turn. Authority stays with the discovery ceiling and the
 * capability profile.
 *
 * Only an EXPLICIT placement repositions an operation. Without one the tool
 * keeps where the agent definition authored it, so storing a placement for one
 * bundle cannot quietly move another bundle's tools — a bundle's `tier` is the
 * default for the CONTROL, not a claim that every operation it owns was
 * authored in that tier. Memory is the case that proves it: its writes are a
 * `loaded` bundle, but `memory.store.delete` is authored discoverable, and a
 * default-driven pass would pin it the moment an operator touched an unrelated
 * row.
 *
 * An operation whose bundle cannot be resolved likewise keeps its authored
 * position: an unassigned group is a registry gap (the guard test exists to
 * catch one), and silently unpinning a tool because of it would be the worst
 * reading.
 */
export function resolveToolPlacement(
  tool: { operationId: string; bundleId: string; defaultPinned: boolean; locked: boolean },
  placements?: Readonly<Record<string, string>>,
  operationPlacements?: Readonly<Record<string, string>>,
): CapabilityBundlePlacement {
  const fallback = tool.defaultPinned ? 'always_on' : 'on_demand';
  if (tool.locked) return fallback;
  const group = placements?.[tool.bundleId];
  const value = group === 'off' ? 'off' : (operationPlacements?.[tool.operationId] ?? group);
  return value === 'always_on' || value === 'on_demand' || value === 'off' ? value : fallback;
}

export function applyBundlePlacements(
  coreOperations: readonly string[],
  discoverableOperationIds: readonly string[],
  placements: Readonly<Record<string, string>> | undefined,
  operationPlacements?: Readonly<Record<string, string>>,
): PlacedSurface {
  const pinned: string[] = [];
  const discoverable: string[] = [];
  const offOperationIds = new Set<string>();

  const place = (opId: string, authoredPinned: boolean): void => {
    const bundle = bundleForOperation(opId);
    const placement = resolveToolPlacement(
      {
        operationId: opId,
        bundleId: bundle?.id ?? '',
        defaultPinned: authoredPinned,
        locked: bundle?.locked !== undefined,
      },
      placements,
      operationPlacements,
    );
    switch (placement) {
      case 'always_on':
        pinned.push(opId);
        return;
      case 'on_demand':
        discoverable.push(opId);
        return;
      case 'off':
        offOperationIds.add(opId);
        return;
    }
  };

  for (const opId of coreOperations) place(opId, true);
  for (const opId of discoverableOperationIds) {
    if (!coreOperations.includes(opId)) place(opId, false);
  }

  return {
    coreOperations: [...new Set(pinned)],
    discoverableOperationIds: [...new Set(discoverable)],
    offOperationIds,
  };
}

/**
 * Guarantee the agent can always re-read a truncated run output (Plan 196 §4.9).
 *
 * Idempotent, and deliberately callable more than once per turn: it is applied
 * before shedding, where a pinned memory read already satisfies it, and again
 * after — otherwise shedding Memory would take the floor with it.
 */
export function withGuaranteedReadOps<T extends ShedableCatalogConfig>(
  catalogConfig: T | undefined,
): T {
  const existing = catalogConfig?.coreOperations ?? [];
  if (
    existing.includes(MEMORY_READ_OPERATION_ID) ||
    existing.includes(RUN_OUTPUT_READ_OPERATION_ID)
  ) {
    return (catalogConfig ?? {}) as T;
  }
  return {
    ...(catalogConfig ?? {}),
    coreOperations: [...existing, RUN_OUTPUT_READ_OPERATION_ID],
  } as T;
}

/**
 * The pinned-tool ceiling the surface assembler enforces, owned here because
 * placement made the cap something an operator can ask to exceed: the settings
 * panel quotes it, the write guard refuses against it, and the assembler throws
 * past it. A second copy would let those three disagree.
 */
export const MAX_PINNED_TOOLS = 50;

export interface PlacementValidation {
  ok: boolean;
  pinnedCount: number;
  max: number;
  /** Operator-facing reason, present only when `ok` is false. */
  message?: string;
}

/**
 * Check a placement map before it is stored.
 *
 * Validated at the write boundary rather than at turn assembly because
 * `buildAvailableTools` THROWS past the cap: a stored setting that exceeded it
 * would not degrade, it would fail every turn in the space, with nothing in the
 * UI explaining why. Refusing the save is the only place the operator can still
 * act on the answer.
 */
export function validateBundlePlacements(
  coreOperations: readonly string[],
  discoverableOperationIds: readonly string[],
  placements: Readonly<Record<string, string>> | undefined,
): PlacementValidation {
  const placed = applyBundlePlacements(coreOperations, discoverableOperationIds, placements);
  const pinnedCount = placed.coreOperations.length;
  if (pinnedCount <= MAX_PINNED_TOOLS) {
    return { ok: true, pinnedCount, max: MAX_PINNED_TOOLS };
  }
  const alwaysOn = CAPABILITY_BUNDLES.filter(
    (b) => !b.locked && effectivePlacement(b, placements) === 'always_on',
  ).map((b) => b.label);
  return {
    ok: false,
    pinnedCount,
    max: MAX_PINNED_TOOLS,
    message:
      `Always-on capabilities would pin ${String(pinnedCount)} tools, over the limit of ` +
      `${String(MAX_PINNED_TOOLS)}. Move something to on-demand` +
      (alwaysOn.length > 0 ? ` — currently always-on: ${alwaysOn.join(', ')}.` : '.'),
  };
}

/**
 * `bundleIds` minus anything locked. A locked bundle is refused here rather
 * than hidden in the UI, so a hand-written directive cannot shed it either.
 */
export function shedableBundleIds(bundleIds: readonly string[]): string[] {
  return bundleIds.filter((id) => {
    const bundle = getCapabilityBundle(id);
    return bundle !== undefined && bundle.locked === undefined;
  });
}
