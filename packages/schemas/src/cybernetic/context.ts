import { z } from 'zod';

import { cappedText } from '../modelOutput/cappedText.js';
import { WorkflowLearningCategorySchema } from '../operations/workflow/enums.js';
import { WORKFLOW_LEARNING_TEXT_MAX_CHARS } from '../operations/workflow/learning.js';

// ============================================================================
// Task Context Search
// ============================================================================

/**
 * A scoped search query within the context assembly pipeline.
 * Used by the scoped and curated strategies to find relevant memory documents.
 */
export const TaskContextSearchSchema = z.object({
  /** Memory path prefix to search within. */
  pathPrefix: z.string().max(1024).optional(),

  /** Tags to filter by (any match). */
  tags: z.array(z.string().max(64)).max(10).optional(),

  /** Recency constraint (e.g., '7d', '1h', '30m'). */
  recency: z.string().max(20).optional(),

  /** Maximum results from this search. */
  limit: z.number().int().min(1).max(50).default(10),

  /** Search mode — list (directory listing) or search (semantic/keyword). */
  mode: z.enum(['list', 'search']).default('list'),

  /** Semantic search query (when mode = 'search'). */
  query: z.string().max(500).optional(),
});

export type TaskContextSearch = z.infer<typeof TaskContextSearchSchema>;

// ============================================================================
// Task Capability Grants (104n)
// ============================================================================

export const IntegrationToolGrantSchema = z.object({
  /** Endpoint ID for `sourceKind: 'api'`; tool name for `sourceKind: 'mcp'`. */
  toolName: z.string().min(1).max(128),
  /** Optional definition/schema revision pin used for replay and drift detection. */
  revision: z.string().min(1).max(128).optional(),
  schemaHash: z.string().min(1).max(128).optional(),
});

export type IntegrationToolGrant = z.infer<typeof IntegrationToolGrantSchema>;

/**
 * How a task calls a granted integration. `endpoint_tools` (default) promotes
 * the listed `toolNames` as native endpoint/tool calls. `direct_url` is an
 * egress-allowlist-only grant against a `callMode: 'direct_url'` binding —
 * carries NO toolNames and is called via `api.http.call` direct-URL mode
 * (apiId + bindingId + url) for signed/dynamic cross-host URLs.
 */
export const CapabilityGrantKindSchema = z.enum(['endpoint_tools', 'direct_url']);
export type CapabilityGrantKind = z.infer<typeof CapabilityGrantKindSchema>;

/**
 * Which binding a grant's tools resolve against. `binding` names a concrete
 * binding row; `connection` defers resolution to the run's pinned connection
 * (resolved at dispatch, fail-closed when no connection is pinned).
 */
export const GrantBindingRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('binding'), bindingId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('connection') }),
]);

export type GrantBindingRef = z.infer<typeof GrantBindingRefSchema>;

export const IntegrationCapabilityGrantSchema = z.object({
  capabilityId: z.string().min(1).max(128),
  binding: GrantBindingRefSchema,
  sourceKind: z.enum(['api', 'mcp']),
  /** API definition `apiId` or MCP server definition `serverId`. */
  integrationId: z.string().min(1).max(128),
  /** How the binding is called — endpoint tools vs. direct-URL. Absent ≡ 'endpoint_tools'. */
  grantKind: CapabilityGrantKindSchema.optional(),
  /** Granted endpoint IDs (API) or tool names (MCP). Empty for `direct_url`. */
  toolNames: z.array(IntegrationToolGrantSchema).max(50).default([]),
  /**
   * Escape hatch for broad grants. Not allowed in compose-skill output.
   * Reserved for operator-authored exploratory skills and bind-capability.
   */
  allTools: z.boolean().default(false),
});

export type IntegrationCapabilityGrant = z.infer<typeof IntegrationCapabilityGrantSchema>;

export const TaskCapabilityGrantSchema = z.object({
  /** Phoenix-native operation IDs promoted as direct Runner tools. */
  operations: z.array(z.string().max(128)).max(50).default([]),

  /** Bound API endpoints + MCP tools promoted as endpoint/tool-native tools. */
  integrations: z.array(IntegrationCapabilityGrantSchema).max(40).default([]),

  /**
   * The promotable ceiling — operation IDs the task may pull into its tool
   * surface at runtime, kept off the default surface until promoted.
   * Broader than `operations` by design: `operations` is what the task
   * starts with; `promotable.operations` is what it may reach for.
   * Declaring a non-empty set surfaces `catalog.tool.promote` automatically;
   * promotion outside this set is rejected.
   */
  promotable: z
    .object({
      operations: z.array(z.string().max(128)).max(100).default([]),
    })
    .optional(),
});

export type TaskCapabilityGrant = z.infer<typeof TaskCapabilityGrantSchema>;

// ============================================================================
// Task Context Spec
// ============================================================================

/**
 * Per-task context configuration for cybernetic procedures.
 * Defines what context a worker receives when executing this task.
 *
 * Three strategies matched to familiarity:
 * - static: deterministic refs, zero LLM cost
 * - scoped: deterministic base + bounded search, minimal cost
 * - curated: attention function with judgment, one LLM call
 *
 * Context strategies self-optimize over time (curated -> scoped -> static)
 * as the Learner (102c) observes manifest stability.
 */
export const TaskContextSpecSchema = z.object({
  /** Which context assembly strategy to use. */
  strategy: z.enum(['static', 'scoped', 'curated']).default('curated'),

  /**
   * Tools the worker should have access to (legacy field — use `capabilities` for new skills).
   * Resolves against any operation/agent callable in the tenant, subject to
   * capability profile + directives — NOT a subset of the executive's minimal catalog.
   * Workers can legitimately reach ops the executive cannot (principle 13: skills bundle tools).
   *
   * When both `tools` and `capabilities.operations` are present, they are merged.
   * New skills should use `capabilities` exclusively.
   */
  tools: z.array(z.string().max(128)).max(50).optional(),

  /**
   * Tool groups to include (e.g., 'memory', 'compute', 'ai.generation').
   * Groups expand to all matching operations in the space.
   */
  toolGroups: z.array(z.string().max(64)).max(10).optional(),

  capabilities: TaskCapabilityGrantSchema.optional(),

  /** Static memory references — always loaded regardless of strategy. */
  staticRefs: z.array(z.string().max(1024)).max(20).optional(),

  /** Scoped search queries — deterministic scope, dynamic results (for scoped + curated). */
  search: z.array(TaskContextSearchSchema).max(5).optional(),

  /** Which workflow learnings to inject. */
  learnings: z.enum(['none', 'active']).default('active'),

  /** Budget constraints for curated strategy. */
  budget: z
    .object({
      maxRefs: z.number().int().min(1).max(50).default(10),
      maxTokens: z.number().int().min(100).max(32000).default(8000),
    })
    .optional(),

  /** Attention function config (only used when strategy = 'curated'). */
  attentionFunction: z
    .object({
      /** Model to use for the attention function LLM call. */
      model: z.string().max(64).optional(),
      /** Additional instructions for the attention function. */
      additionalInstructions: z.string().max(500).optional(),
    })
    .optional(),

  /**
   * Whether the Learner (102c) can promote the context strategy.
   * - auto-optimize: Learner may promote curated -> scoped -> static based on stability
   * - pinned: Strategy stays as configured (useful for inherently dynamic tasks)
   */
  contextPolicy: z.enum(['auto-optimize', 'pinned']).default('auto-optimize'),
});

export type TaskContextSpec = z.infer<typeof TaskContextSpecSchema>;

// ============================================================================
// Effective Task Tool Manifest (104n §5.2a)
// ============================================================================

/**
 * Immutable snapshot of the exact tool surface used for a task execution.
 * Persisted at task start for replay, debugging, Coach review, and operator trust.
 * Later API/MCP registry edits must not rewrite historical manifests.
 */
export const EffectiveTaskToolManifestSchema = z.object({
  taskId: z.string().min(1).max(64),
  runId: z.string().min(1).max(128),
  generatedAt: z.string().datetime(),

  /** Phoenix operations promoted as direct tools. */
  operations: z.array(
    z.object({
      operationId: z.string().min(1).max(128),
      agentTool: z.boolean(),
      schemaHash: z.string().min(1).max(128).optional(),
    }),
  ),

  /** API endpoints promoted as native tools. */
  apiEndpoints: z.array(
    z.object({
      capabilityId: z.string().min(1).max(128),
      bindingId: z.string().min(1).max(128),
      apiId: z.string().min(1).max(128),
      endpointId: z.string().min(1).max(128),
      revision: z.string().min(1).max(128).optional(),
      schemaHash: z.string().min(1).max(128).optional(),
      toolName: z.string().min(1).max(256),
      broadGrant: z.boolean(),
    }),
  ),

  /** MCP tools promoted as native tools. */
  mcpTools: z.array(
    z.object({
      capabilityId: z.string().min(1).max(128),
      bindingId: z.string().min(1).max(128),
      serverId: z.string().min(1).max(128),
      toolName: z.string().min(1).max(256),
      schemaHash: z.string().min(1).max(128).optional(),
      broadGrant: z.boolean(),
    }),
  ),
});

export type EffectiveTaskToolManifest = z.infer<typeof EffectiveTaskToolManifestSchema>;

// ============================================================================
// Needs Capability Handoff (104n §6.2)
// ============================================================================

/**
 * Structured handoff when compose-skill discovers missing API/MCP bindings.
 * Emitted instead of a `skill_compose` proposal when required capabilities
 * are not yet bound in the space.
 */
export const NeedsCapabilityHandoffSchema = z.object({
  code: z.literal('SKILL_COMPOSE_NEEDS_BINDING'),
  requestedCapabilities: z.array(
    z.object({
      kind: z.enum(['api', 'mcp']),
      nameOrId: z.string().min(1).max(128),
      requiredByTasks: z.array(z.string().max(64)).max(20),
      requiredEndpointsOrTools: z.array(z.string().max(128)).max(50).optional(),
      rationale: z.string().max(500),
    }),
  ),
  suggestedNextAction: z.object({
    skillSlug: z.literal('bind-capability'),
    prefill: z.record(z.string(), z.unknown()),
  }),
});

export type NeedsCapabilityHandoff = z.infer<typeof NeedsCapabilityHandoffSchema>;

// ============================================================================
// Procedure Activation
// ============================================================================

/**
 * Activation pattern for a cybernetic procedure (stored on WorkflowSchema).
 * The executive uses these to recognize when a known procedure matches the
 * current request. Matching is cognitive — the executive reads activationHint
 * and triggerPatterns in its attention context and decides whether to activate.
 *
 * NOTE: No `schedule` field — scheduling via FlowSchedule (one scheduling system).
 * NOTE: No `autoActivate` — the executive always decides (intent classification).
 */
export const ProcedureActivationSchema = z.object({
  /** Keywords or phrases that suggest this procedure is relevant. */
  triggerPatterns: z.array(z.string().max(200)).max(10),

  /** Semantic description of when to activate (for LLM-based matching). */
  activationHint: z.string().max(500),

  /** Hard prerequisites — conditions that must be true for activation. */
  prerequisites: z.array(z.string().max(200)).max(5).optional(),

  /** Priority when multiple procedures match (higher = preferred). */
  priority: z.number().int().min(0).max(100).default(50),
});

export type ProcedureActivation = z.infer<typeof ProcedureActivationSchema>;

// ============================================================================
// Context Manifest (attention function output)
// ============================================================================

/**
 * Output of the attention function for curated context assembly.
 * Contains references (pointers) to what should be loaded — not the content itself.
 * The orchestrator resolves the manifest into actual context blocks.
 */
export const ContextManifestSchema = z.object({
  /** Memory document references to load. */
  memoryRefs: z
    .array(
      z.object({
        /** Memory path to the document. */
        path: z.string().max(1024),
        /** How much of the document to load. */
        view: z.enum(['stat', 'preview', 'content']).default('content'),
        rationale: cappedText(
          1000,
          'Why this document was selected, for learner review.',
        ).optional(),
      }),
    )
    .max(30),

  /**
   * Tool IDs or tool groups to include in the worker's tool set.
   * Individual ops for precision, groups (e.g., 'memory', 'compute', 'ai.generation')
   * for breadth. Groups expand to all matching operations in the space.
   */
  toolSubset: z.array(z.string().max(128)).max(50).optional(),

  /**
   * Relevant workflow learnings to inject (inlined content, not IDs).
   * Learnings are small — inlining avoids a resolution hop.
   */
  learnings: z
    .array(
      z.object({
        category: WorkflowLearningCategorySchema,
        observation: z.string().max(WORKFLOW_LEARNING_TEXT_MAX_CHARS),
        recommendation: z.string().max(WORKFLOW_LEARNING_TEXT_MAX_CHARS).optional(),
      }),
    )
    .max(10)
    .optional(),

  /** Prior task result IDs from the current run to include. */
  priorResultIds: z.array(z.string().max(64)).max(10).optional(),

  /** Free-form guidance for the worker (e.g., "focus on the anomaly in section 3"). */
  workerGuidance: z.string().max(500).optional(),
});

export type ContextManifest = z.infer<typeof ContextManifestSchema>;

// ============================================================================
// Procedure Usage Stats (for scarcity enforcement by 102c)
// ============================================================================

/** Origin of procedure creation — how the procedure came into existence. */
export const ProcedureOriginSchema = z.enum(['platform', 'operator', 'executive', 'cloned']);

export type ProcedureOrigin = z.infer<typeof ProcedureOriginSchema>;

/**
 * Usage statistics for a cybernetic procedure.
 * Tracks activation frequency, success rate, cost, and scarcity decay.
 * The Learner (102c) uses these for scarcity enforcement and procedure pruning.
 */
export const ProcedureUsageStatsSchema = z.object({
  /** Total number of times this procedure has been activated. */
  totalActivations: z.number().int().nonnegative(),

  /** When the procedure was last activated. */
  lastActivatedAt: z.string().datetime().optional(),

  /** When the procedure last succeeded. */
  lastSucceededAt: z.string().datetime().optional(),

  /** Success rate (0-1) across all activations. */
  successRate: z.number().min(0).max(1).optional(),

  /** Average cost per activation in cents. */
  avgCostCents: z.number().nonnegative().optional(),

  /** Average duration per activation in milliseconds. */
  avgDurationMs: z.number().int().nonnegative().optional(),

  /** When the procedure was created. */
  createdAt: z.string().datetime(),

  /** Source of creation — how the procedure came into existence. */
  origin: ProcedureOriginSchema,

  /** Scarcity decay score (0 = fresh, 1 = stale). Learner uses this for pruning. */
  decayScore: z.number().min(0).max(1).default(0),
});

export type ProcedureUsageStats = z.infer<typeof ProcedureUsageStatsSchema>;
