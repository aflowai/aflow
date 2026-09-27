import { z } from 'zod';

// ============================================================================
// Map Node Types
// ============================================================================

/**
 * Canonical anatomical parts of the Entity Map (DL-7).
 * Every kind maps to a fixed spatial slot on the map.
 */
export const MapNodeKindSchema = z.enum([
  'helmsman',
  'runner',
  'coach',
  'memory',
  'skills',
  'evals',
  'stagedChanges',
  'triggers',
]);

export type MapNodeKind = z.infer<typeof MapNodeKindSchema>;

/**
 * Three node states with distinct visual treatments (DL-10).
 * Stuck is first-class — not absence of activity, but an actionable signal.
 */
export const MapNodeStateSchema = z.enum(['idle', 'active', 'stuck']);

export type MapNodeState = z.infer<typeof MapNodeStateSchema>;

/**
 * A node on the Entity Map. Rendered as an AnatomicalNode in the SVG layer.
 */
export const MapNodeSchema = z.object({
  /** Which anatomical part this node represents. */
  kind: MapNodeKindSchema,

  /** Current visual state. */
  state: MapNodeStateSchema,

  /** Display label (e.g., "Helmsman", "Runners (2 live)"). */
  label: z.string(),

  /** Optional count badge (inbox items, staged changes, skills). */
  count: z.number().int().nonnegative().optional(),

  /** Summary text for hover tooltip. */
  summary: z.string().max(200).optional(),

  /** Associated workflow slug (for worker nodes). */
  workflowSlug: z.string().optional(),
});

export type MapNode = z.infer<typeof MapNodeSchema>;

// ============================================================================
// Map Edge Types
// ============================================================================

/**
 * Canonical edges between anatomical regions (DL-9).
 * Edges are always drawn (soft when idle); they animate when interaction fires.
 */
export const MapEdgeKindSchema = z.enum([
  'trigger_to_helmsman',
  'helmsman_to_memory',
  'memory_to_helmsman',
  'helmsman_to_runner',
  'runner_to_memory',
  'memory_to_runner',
  'runner_to_helmsman',
  'runner_to_evals',
  'evals_to_coach',
  'completion_to_coach',
  'coach_to_staged',
  'staged_to_helmsman',
  'staged_to_operator',
]);

export type MapEdgeKind = z.infer<typeof MapEdgeKindSchema>;

// ============================================================================
// Card Spec (DL-1 — progressive disclosure)
// ============================================================================

/**
 * CardSpec declares how an entity event renders across surfaces.
 * Every event type should provide a CardSpec so surfaces can render
 * new event types without code changes.
 *
 * Level 0 (Pulse): just the event header — no CardSpec needed.
 * Level 1 (Card): label + metric + outcome + breadcrumb from CardSpec.
 * Level 2 (Inline expand): key fields from event payload.
 * Level 3 (Peek panel): fetched by PayloadRef (lazy).
 */
export const CardSpecSchema = z.object({
  /** One-line label for the card (Level 1). */
  label: z.string().max(200),

  /** Optional metric value (e.g., "0.82", "$0.08", "12.4s"). */
  metric: z.string().max(50).optional(),

  /** Optional outcome indicator (e.g., "success", "regression", "partial"). */
  outcome: z.string().max(50).optional(),

  /** Breadcrumb path for context (e.g., "pricing-approval > fetch-comps"). */
  breadcrumb: z.string().max(200).optional(),

  /** Which Map node this event originates from. */
  mapNodeKind: MapNodeKindSchema,

  /** Default narration line (for the Narration Log at Essentials density). */
  narrationLine: z.string().max(500),
});

export type CardSpec = z.infer<typeof CardSpecSchema>;

// ============================================================================
// Narration Log
// ============================================================================

/** Density level for the Narration Log (DL-17). */
export const NarrationDensitySchema = z.enum(['essentials', 'deep']);

export type NarrationDensity = z.infer<typeof NarrationDensitySchema>;

/**
 * A rendered line in the Narration Log. Derived from an EntityEventEnvelope
 * + its CardSpec for display.
 */
export const NarrationLineSchema = z.object({
  /** Source entity event ID. */
  eventId: z.string().uuid(),

  /** Epoch ms timestamp. */
  timestamp: z.number(),

  /** Which Map node produced this line. */
  nodeKind: MapNodeKindSchema,

  /** The narration text (from CardSpec.narrationLine or event summary). */
  text: z.string().max(500),

  /**
   * Optional reasoning prose (Deep density).
   * May be a PayloadRef string for lazy-loading (Level 3).
   */
  reasoning: z.string().optional(),

  /** Whether reasoning was captured for this event (DL-16). */
  hasReasoning: z.boolean(),
});

export type NarrationLine = z.infer<typeof NarrationLineSchema>;

// ============================================================================
// Attention Inbox
// ============================================================================

/** Item kinds that appear in the Attention Inbox (§6.4). */
export const InboxItemKindSchema = z.enum([
  'staged_change', // From 102c: Learner proposals
  'eval_regression', // From 102f: baseline vs current regression
  'anomaly', // From 102c: tool tightened, cost outlier, etc.
  'pattern_flag', // From 102c: "this happened N times"
  'stuck_runner', // Runner past timeout or blocked
  'training_prompt', // Training Mode: first-time handling suggestion
]);

export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

/** Priority levels for inbox items, derived from directives. */
export const InboxItemPrioritySchema = z.enum(['high', 'normal', 'low']);

export type InboxItemPriority = z.infer<typeof InboxItemPrioritySchema>;

/** Actions available on inbox items (DL-18, §10). */
export const InboxItemActionSchema = z.object({
  /** Machine-readable action key. */
  action: z.enum([
    'approve',
    'reject',
    'defer',
    'snooze',
    'retry',
    'skip',
    'abort',
    'teach',
    'investigate',
    'consider',
    'dismiss',
    'accept_regression',
  ]),

  /** Human-readable button label. */
  label: z.string().max(50),

  /** Keyboard shortcut hint (e.g., "a", "r", "u"). */
  shortcut: z.string().max(10).optional(),

  /** Whether this action is destructive / high-stakes. */
  destructive: z.boolean().optional(),
});

export type InboxItemAction = z.infer<typeof InboxItemActionSchema>;

/**
 * An item in the Attention Inbox. Each item carries evidence inline
 * (evidence-first action, §7.4) and deep-links to its causal chain.
 */
export const InboxItemSchema = z.object({
  /** Unique item identifier. */
  id: z.string().uuid(),

  /** What kind of attention this requires. */
  kind: InboxItemKindSchema,

  /** Derived priority. */
  priority: InboxItemPrioritySchema,

  /** One-line plain-language summary. */
  summary: z.string().max(500),

  /** Inline evidence (no click-to-expand). */
  evidence: z.string().max(2000),

  /** Link to the entity event that created this item. */
  sourceEventId: z.string().uuid().optional(),

  /** Link to the staged change (for staged_change kind). */
  stagedChangeId: z.string().uuid().optional(),

  /** Available actions for this item. */
  actions: z.array(InboxItemActionSchema),

  /** When this item was created. */
  createdAt: z.string().datetime(),

  /** When this item expires (auto-dismiss). */
  expiresAt: z.string().datetime().optional(),

  /** Whether this item has been snoozed. */
  snoozedUntil: z.string().datetime().optional(),
});

export type InboxItem = z.infer<typeof InboxItemSchema>;

// ============================================================================
// Constitutional Bar
// ============================================================================

/** Operating modes for the Constitutional Bar display. */
export const EntityPostureSchema = z.enum(['training', 'balanced']);

export type EntityPosture = z.infer<typeof EntityPostureSchema>;

/**
 * State rendered in the Constitutional Bar (§3.1, top of console).
 */
export const ConstitutionalBarStateSchema = z.object({
  /** Entity display name (from directives or space name). */
  entityName: z.string(),

  /** Entity role description. */
  role: z.string().max(200).optional(),

  /** Current operating mode. */
  mode: z.enum(['conversational', 'exploratory', 'procedural', 'supervisory']),

  /** Current governance posture. */
  posture: EntityPostureSchema,

  /** Whether all scheduled + learner activity is paused. */
  isPaused: z.boolean(),

  /** Whether the entity is connected (SSE alive). */
  isConnected: z.boolean(),
});

export type ConstitutionalBarState = z.infer<typeof ConstitutionalBarStateSchema>;

// ============================================================================
// Command Launcher (⌘K)
// ============================================================================

/**
 * An action registered with the ⌘K command launcher (DL-18, §10).
 * Actions that don't exist yet are shown disabled with a "Phase N" tooltip.
 */
export const ConsoleActionSchema = z.object({
  /** Unique action identifier. */
  id: z.string(),

  /** Display label in the launcher. */
  label: z.string().max(100),

  /** Category for grouping in the launcher. */
  category: z.enum([
    'navigation', // Jump to a Map node or surface
    'control', // Pause, resume, redirect
    'triage', // Approve, reject, unstick
    'inspect', // Open peek panel, trace chain
  ]),

  /** Keyboard shortcut (e.g., "⌘p", "a", "r"). */
  shortcut: z.string().max(20).optional(),

  /** Whether this action is available in the current phase. */
  enabled: z.boolean(),

  /** Phase hint for disabled actions (e.g., "Phase 3"). */
  phaseHint: z.string().max(20).optional(),

  /** Target Map node kind (for navigation actions). */
  targetNodeKind: MapNodeKindSchema.optional(),
});

export type ConsoleAction = z.infer<typeof ConsoleActionSchema>;

// ============================================================================
// Event-to-Map mapping
// ============================================================================

/**
 * Maps entity event types to the Map node they affect.
 * Used by the client-side event router to determine where to render
 * ripples, update state, and append narration lines.
 *
 * This is a static mapping — add entries here when 102e adds event types.
 */
export const EVENT_TYPE_TO_NODE_KIND: Record<string, MapNodeKind> = {
  // Helmsman
  'entity.trigger.received': 'triggers',
  'entity.trigger.routed': 'helmsman',
  'entity.mode.transition': 'helmsman',
  'entity.interaction.started': 'helmsman',
  'entity.interaction.ended': 'helmsman',

  // Procedure lifecycle
  'entity.procedure.activated': 'helmsman',
  'entity.procedure.completed': 'helmsman',
  'entity.runner.dispatched': 'runner',
  'entity.runner.completed': 'runner',
  'entity.context.assembled': 'runner',

  // Coach
  'entity.coach.activated': 'coach',
  'entity.coach.proposal': 'coach',
  'entity.coach.ratified': 'stagedChanges',
  'entity.coach.rejected': 'stagedChanges',
  'entity.coach.anomaly': 'coach',
  'entity.coach.consolidation': 'coach',
  'entity.coach.promotion': 'skills',
  'entity.coach.suppressed': 'coach',

  // Memory/Identity
  'entity.memory.mutation': 'memory',
  'entity.identity.updated': 'memory',

  // Evaluation
  'entity.eval.completed': 'evals',
  'entity.eval.regression': 'evals',

  'entity.space.bootstrapped': 'helmsman',
  'entity.directives.updated': 'helmsman',

  'entity.skill.authored': 'skills',
  'entity.binding.ratified': 'helmsman',
  'entity.binding.removed': 'helmsman',
};

/**
 * Maps entity event types to canonical edges that should animate
 * when the event fires (DL-9). Multiple edges may fire per event.
 */
export const EVENT_TYPE_TO_EDGES: Record<string, MapEdgeKind[]> = {
  'entity.trigger.received': ['trigger_to_helmsman'],
  'entity.trigger.routed': [],
  'entity.mode.transition': [],
  'entity.interaction.started': ['trigger_to_helmsman'],
  'entity.interaction.ended': [],

  'entity.procedure.activated': ['helmsman_to_runner'],
  'entity.procedure.completed': ['runner_to_helmsman'],
  'entity.runner.dispatched': ['helmsman_to_runner'],
  'entity.runner.completed': ['runner_to_helmsman', 'runner_to_evals'],
  'entity.context.assembled': ['memory_to_runner'],

  'entity.coach.activated': ['completion_to_coach'],
  'entity.coach.proposal': ['coach_to_staged'],
  'entity.coach.ratified': ['staged_to_helmsman'],
  'entity.coach.rejected': ['staged_to_operator'],
  'entity.coach.anomaly': [],
  'entity.coach.consolidation': [],
  'entity.coach.promotion': [],
  'entity.coach.suppressed': [],

  'entity.memory.mutation': [],
  'entity.identity.updated': [],

  'entity.eval.completed': ['runner_to_evals'],
  'entity.eval.regression': ['evals_to_coach'],

  'entity.space.bootstrapped': ['trigger_to_helmsman', 'helmsman_to_memory'],
  'entity.directives.updated': ['helmsman_to_memory', 'staged_to_helmsman'],

  'entity.skill.authored': [],
  'entity.binding.ratified': ['staged_to_helmsman'],
  'entity.binding.removed': ['staged_to_helmsman'],
};

// ============================================================================

/**
 * The Process Map is a *derived* topology of the entity's actual configuration:
 * triggers, agents, skills, evals, memory, and staged changes — wired with
 * the corrected control-flow edges (Helmsman activates a skill → Runner
 * executes it → results loop back through Eval → Coach → Staged).
 *
 * This schema is **additive** alongside the legacy `MapNode`/`MapEdgeKind`
 * model, which still drives the SVG anatomical map in `EntityConsolePanel`.
 * Phase 3 wires the new `EntityProcessMap` over the legacy panel; the legacy
 * model is retired in a later cleanup.
 */
export const ProcessMapNodeKindSchema = z.enum([
  'trigger',
  'agent',
  'skill',
  'memory',
  'staged',
  'directives',
]);

export type ProcessMapNodeKind = z.infer<typeof ProcessMapNodeKindSchema>;

/**
 * Trigger source categories (DL-7). One node per category that has at least
 * one configured source in the space (chat is always present; others are
 * derived from the space's schedules + workflow `triggerPatterns`).
 */
export const TriggerCategorySchema = z.enum(['chat', 'schedule', 'on_completion', 'external']);

export type TriggerCategory = z.infer<typeof TriggerCategorySchema>;

/** Stable platform role for a system agent (mirrors `AgentSystemRoleSchema`). */
export const ProcessMapAgentRoleSchema = z.enum(['helmsman', 'runner', 'coach', 'other']);

export type ProcessMapAgentRole = z.infer<typeof ProcessMapAgentRoleSchema>;

const ProcessMapTriggerNodeSchema = z.object({
  id: z.string(), // `trigger:${category}`
  kind: z.literal('trigger'),
  category: TriggerCategorySchema,
  label: z.string(),
  /** True when the space actually has a source of this trigger category. */
  present: z.boolean(),
  count: z.number().int().nonnegative().optional(),
});

/**
 * Compact attention summary surfaced on the Helmsman agent node (ontology
 * §5.7). Mirrors the counts a fresh Helmsman session would see when it
 * starts — active runs, pending proposals, anomalies, pattern flags — so the
 * operator can read the entity's current cross-session state at a glance
 * without opening an inspector.
 */
export const ProcessMapAttentionSummarySchema = z.object({
  /** Active workflow runs (running or paused). */
  activeRuns: z.number().int().nonnegative(),
  /** Pending Coach proposals awaiting operator ratification. */
  pendingProposals: z.number().int().nonnegative(),
  /** Coach-flagged anomalies still in `/coach/anomalies/`. */
  pendingAnomalies: z.number().int().nonnegative(),
  /**
   * Subset of pending proposals classified as pattern flags. The Helmsman
   * may consider promoting these into new skills via `compose-skill`.
   */
  pendingPatternFlags: z.number().int().nonnegative(),
  /** Slugs of currently active workflow runs (capped at 5 for the chip). */
  activeRunSlugs: z.array(z.string()).max(5),
  degradedSkills: z
    .array(
      z.object({
        slug: z.string(),
        validationError: z.string(),
      }),
    )
    .max(10),
  /**
   * Schema-valid skills that fall short of current authoring standards
   * (e.g. tasks declare no `context.capabilities`). Surfaced so the
   * Helmsman can suggest Coach review when the operator activates one,
   * and so the operator sees the quality gap in the UI.
   */
  skillQualityFlags: z
    .array(
      z.object({
        slug: z.string(),
        issue: z.enum(['no_capability_declarations']),
        taskIds: z.array(z.string()).max(8),
      }),
    )
    .max(20),
  /**
   * ISO timestamp of when this attention snapshot was computed. Lets the UI
   * show staleness (the underlying cache has a 60s TTL).
   */
  generatedAt: z.string().datetime(),
});

export type ProcessMapAttentionSummary = z.infer<typeof ProcessMapAttentionSummarySchema>;

const ProcessMapAgentNodeSchema = z.object({
  id: z.string(), // `agent:${agentId}`
  kind: z.literal('agent'),
  agentId: z.string(),
  role: ProcessMapAgentRoleSchema,
  label: z.string(),
  systemRole: z.string().nullable(),
  /**
   * Session-scoped intent for `helmsman` agents (naming §2.5). Optional and
   * only populated on the Helmsman node; clients may render it as a pill on
   * the agent card. Until intent becomes a first-class schema (see naming
   * implementation-status table), callers surface a best-effort value derived
   * from the most recent intent-bearing entity event.
   */
  intent: z
    .enum(['chat', 'investigate', 'activate-skill', 'acquire-skill', 'manage'])
    .nullable()
    .optional(),
  /**
   * Compact attention summary — only populated for the helmsman role.
   * Surfaces the same counts the Helmsman would see in its turn context
   * (ontology §5.7 — Helmsman Attention).
   */
  attention: ProcessMapAttentionSummarySchema.optional(),
});

/**
 * Compact summary of a workflow's eval health. Surfaced inline on Process
 * Map skill nodes (sparkline + regression badge) and reused by the Skill
 * Inspector header. Sized to keep the snapshot under a few KB even for
 * many-workflow spaces.
 *
 * Per ontology §5.2, a skill bundles {goal, mode, workflow, eval suite,
 * activation hints} — evals live *inside* the skill, not as a peer node.
 */
export const EvalNodeSummarySchema = z.object({
  /** Rolling baseline overall score (0..1), or null if no baseline yet. */
  baselineOverall: z.number().min(0).max(1).nullable(),
  /** Last N overall scores, oldest → newest, capped at 12 for the sparkline. */
  recentScores: z.array(z.number().min(0).max(1)).max(12),
  /** True when consecutive breaches ≥ required (ratified regression). */
  regression: z.boolean(),
  /** How many results contributed to the baseline. */
  sampleSize: z.number().int().nonnegative(),
});

export type EvalNodeSummary = z.infer<typeof EvalNodeSummarySchema>;

const ProcessMapSkillNodeSchema = z.object({
  id: z.string(), // `skill:${slug}`
  kind: z.literal('skill'),
  slug: z.string(),
  label: z.string(),
  /** Skill mode (optimization/process/project). */
  mode: z.enum(['optimization', 'process', 'project']),
  /**
   * Narrative goal of the skill (ontology §5.2 "Skill goal"). Sourced from
   * `WorkflowSchema.goal` when present, falling back to `description`. May
   * be null while the `Workflow.goal` field is still being rolled out.
   */
  goal: z.string().nullable(),
  /** Whether this skill has a `/evals/{slug}/...` companion. */
  hasEval: z.boolean(),
  /** Whether this skill has activation patterns (cybernetic procedure). */
  isProcedure: z.boolean(),
  /** Number of tasks in the workflow — surfaced as a chip on the skill card. */
  taskCount: z.number().int().nonnegative(),
  /** Optional pinned-agent override; if set, edges narrow to just that agent. */
  assignedAgentId: z.string().nullable().optional(),
  /**
   * Inline eval health. Evals belong to the skill — the map does not render
   * a separate Eval node (ontology §5.2). Absent when the suite has no
   * baseline or results yet.
   */
  evalSummary: EvalNodeSummarySchema.optional(),
  /**
   * Set when the underlying `workflow.json` fails `WorkflowSchema` validation.
   * The skill is still emitted (mirrors the workflows-list degraded summary)
   * so operators can find and repair it instead of having it silently vanish
   * from the map.
   */
  validationError: z.string().nullable().optional(),
});

const ProcessMapMemoryNodeSchema = z.object({
  id: z.literal('memory'),
  kind: z.literal('memory'),
  label: z.string(),
});

const ProcessMapStagedNodeSchema = z.object({
  id: z.literal('staged'),
  kind: z.literal('staged'),
  label: z.string(),
  count: z.number().int().nonnegative(),
});

/**
 * Directives are entity-owned state (ontology §5.1). They constrain what the
 * Helmsman and Coach may do and what the operator may amend. Rendered as a
 * passive, dotted-linked node so the constitutional boundary is legible.
 */
const ProcessMapDirectivesNodeSchema = z.object({
  id: z.literal('directives'),
  kind: z.literal('directives'),
  label: z.string(),
});

/**
 * Individual integration node — one per bound API or MCP server.
 * Space-scoped: all Runners can call endpoints from these bindings.
 * Renders as passive nodes linked to the Runner.
 */
const ProcessMapIntegrationNodeSchema = z.object({
  id: z.string(),
  kind: z.literal('integration'),
  label: z.string(),
  /** 'api' or 'mcp' — drives icon and color. */
  integrationKind: z.enum(['api', 'mcp']),
  /** The apiId or serverId for drill-through. */
  integrationId: z.string(),
  /** Number of endpoints (API) or tools (MCP). */
  endpointCount: z.number().int().nonnegative(),
  /** Whether the binding is ready (has credentials) or needs setup. */
  ready: z.boolean(),
});

export const ProcessMapNodeSchema = z.discriminatedUnion('kind', [
  ProcessMapTriggerNodeSchema,
  ProcessMapAgentNodeSchema,
  ProcessMapSkillNodeSchema,
  ProcessMapMemoryNodeSchema,
  ProcessMapStagedNodeSchema,
  ProcessMapDirectivesNodeSchema,
  ProcessMapIntegrationNodeSchema,
]);

export type ProcessMapNode = z.infer<typeof ProcessMapNodeSchema>;

/**
 * Edge categories on the Process Map. The exact `from`/`to` node ids are
 * derived by the client adapter — these kinds tell the renderer what each
 * edge means (and which entity events should animate it).
 *
 * Control-flow model (ontology §2 runtime, vision §4.2, naming §3):
 *
 *   Trigger ──► Helmsman ──activate──► Skill ◄──execute── Runner
 *                                        │
 *                                        ▼ review
 *                                      Coach ──propose · reject──► Proposed ◄──ratify── Helmsman
 *
 *   Directives ····► Helmsman / Coach   (passive constraint)
 *   Memory      ····► Helmsman / Runner / Coach  (passive)
 *
 * Two simplifications worth calling out:
 *   1. The Helmsman's delegation to the Runner is implicit — every
 *      activated skill has both a `helmsman_to_skill` (activate) and
 *      `runner_to_skill` (execute) edge, so the Runner's role is legible
 *      without a dedicated delegate edge.
 *   2. The Operator is implicit too — "Proposed changes" IS the operator's
 *      review surface (the inspector panel on that node ratifies/rejects).
 *      Ratify is drawn Helmsman → Proposed (operator confirms into the
 *      Helmsman-facing queue). Coach ↔ Proposed is a single edge labeled
 *      propose · reject (both actions share the same link; reject animates
 *      on that edge too).
 */
export const ProcessMapEdgeKindSchema = z.enum([
  // Control loop
  'trigger_to_helmsman',
  'helmsman_to_skill', // activate (which capability)
  'runner_to_skill', // execute (read/run the workflow)
  'skill_to_coach', // review (coach reviews runs + evals)
  'coach_to_staged', // propose · reject (single coach↔proposed governance link)
  'helmsman_to_staged', // ratify (Helmsman → Proposed on the map; operator confirms via Proposed panel)
  // Governance (passive)
  'directives_to_helmsman',
  'directives_to_coach',
  'memory_link',
  // Integration nodes (passive — external tool surfaces feeding Runners)
  'integration_to_runner',
]);

export type ProcessMapEdgeKind = z.infer<typeof ProcessMapEdgeKindSchema>;

export const ProcessMapEdgeSchema = z.object({
  id: z.string(),
  kind: ProcessMapEdgeKindSchema,
  fromNodeId: z.string(),
  toNodeId: z.string(),
  /** Optional edge label for tooltip / overlay. */
  label: z.string().optional(),
  /** When true, render dotted/passive (e.g., memory links). */
  passive: z.boolean().optional(),
});

export type ProcessMapEdge = z.infer<typeof ProcessMapEdgeSchema>;

/** Snapshot returned by `GET /v1/spaces/:id/process-map`. */
export const ProcessMapSnapshotSchema = z.object({
  spaceId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  nodes: z.array(ProcessMapNodeSchema),
  edges: z.array(ProcessMapEdgeSchema),
  /** Counts surfaced as tile-style metrics in the overview header. */
  counts: z.object({
    agents: z.number().int().nonnegative(),
    /** Total skills in the playbook (all skills — seeded + acquired). */
    skills: z.number().int().nonnegative(),
    /** How many of those skills carry an eval suite. */
    withEvals: z.number().int().nonnegative(),
    /** Pending proposed changes awaiting operator review. */
    proposed: z.number().int().nonnegative(),
    /** Total bound integrations (APIs + MCP servers). */
    integrations: z.number().int().nonnegative(),
  }),
});

export type ProcessMapSnapshot = z.infer<typeof ProcessMapSnapshotSchema>;

/**
 * Maps entity event types to the **process map edge kinds** they animate.
 * The corrected control-flow model (ontology §2 runtime) lives here:
 *
 *   - Helmsman **activates** a skill (`helmsman_to_skill`); the Runner
 *     **executes** it (`runner_to_skill`) — delegation is implicit on the map.
 *   - Skills emit eval signals / completion up to the Coach
 *     (`skill_to_coach` — unified, since evals live inside the skill).
 *   - The Coach proposes changes; the Operator ratifies or rejects; ratify
 *     animates Helmsman → Proposed, propose/reject share Coach → Proposed.
 *
 * Multiple kinds may fire per event; the adapter resolves each kind to one
 * or more concrete edges based on the snapshot.
 */
export const EVENT_TYPE_TO_PROCESS_EDGES: Record<string, ProcessMapEdgeKind[]> = {
  'entity.trigger.received': ['trigger_to_helmsman'],
  'entity.trigger.routed': ['trigger_to_helmsman'],
  'entity.interaction.started': ['trigger_to_helmsman'],

  // Procedural activation: Helmsman activates the skill. The Runner's
  // involvement is implicit (every skill has a runner→skill execute edge).
  'entity.procedure.activated': ['helmsman_to_skill'],
  'entity.procedure.completed': ['skill_to_coach'],
  // Runner dispatch + completion both animate runner→skill: dispatch
  // marks the start of execution, completion marks the end.
  'entity.runner.dispatched': ['runner_to_skill'],
  'entity.runner.completed': ['runner_to_skill'],
  'entity.context.assembled': ['memory_link'],

  // Eval + supervision: evals belong to the skill; the Coach sees eval
  // signals and run-completion through a single edge kind.
  'entity.eval.completed': ['skill_to_coach'],
  'entity.eval.regression': ['skill_to_coach'],
  'entity.coach.activated': ['skill_to_coach'],
  'entity.coach.proposal': ['coach_to_staged'],
  'entity.coach.ratified': ['helmsman_to_staged'],
  'entity.coach.rejected': ['coach_to_staged'],
  'entity.coach.suppressed': ['coach_to_staged'],

  'entity.memory.mutation': ['memory_link'],
  'entity.identity.updated': ['memory_link'],

  'entity.space.bootstrapped': ['trigger_to_helmsman', 'memory_link'],
  'entity.directives.updated': ['directives_to_helmsman', 'directives_to_coach'],

  'entity.skill.authored': ['memory_link'],
  'entity.binding.ratified': [],
  'entity.binding.removed': [],
};
