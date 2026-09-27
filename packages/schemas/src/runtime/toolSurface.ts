import { z } from 'zod';

// ============================================================================
// Tool lowering + the per-turn tool surface (the executed truth of what the
// model could call). Split from agentTurn.ts; re-exported there for callers.
// ============================================================================

/**
 * How the orchestrator executes this tool.
 * - step: authored graph step, routed via normal onSuccess edges
 * - run_step: virtual tool, synthesized as dynamic step via handleRunStepInline
 * - delegate: sub-agent delegation via agent.control.delegate
 */
export const AgentToolLoweringSchema = z.enum([
  'step',
  'run_step',
  'delegate',
  'api_call',
  'mcp_call',
]);
export type AgentToolLowering = z.infer<typeof AgentToolLoweringSchema>;

/** Pinned/virtual cap pressure (pinned = MAX_TOTAL_TOOLS, virtual = MAX_VIRTUAL_TOOLS). */
export const ToolSurfaceScopeSchema = z.object({
  pinnedUsed: z.number().int().nonnegative(),
  pinnedMax: z.number().int().nonnegative(),
  virtualUsed: z.number().int().nonnegative(),
  virtualMax: z.number().int().nonnegative(),
});
export type ToolSurfaceScope = z.infer<typeof ToolSurfaceScopeSchema>;

/** Not callable yet — reachable via catalog.tool.search/promote. Ids + counts only. */
export const ToolSurfaceDiscoverableSchema = z.object({
  operationIds: z.array(z.string()).default([]),
  operationCount: z.number().int().nonnegative().default(0),
  apiBindingCount: z.number().int().nonnegative().default(0),
  mcpServerCount: z.number().int().nonnegative().default(0),
});
export type ToolSurfaceDiscoverable = z.infer<typeof ToolSurfaceDiscoverableSchema>;

/**
 * Orchestrator-resolved context the executor echoes onto `ToolSurface` — cap
 * pressure and the discoverable (promotable-but-not-active) tier.
 */
export const ToolSurfaceContextSchema = z.object({
  scope: ToolSurfaceScopeSchema.optional(),
  discoverable: ToolSurfaceDiscoverableSchema.optional(),
});
export type ToolSurfaceContext = z.infer<typeof ToolSurfaceContextSchema>;

// ============================================================================
// Tool surface (the tools serialized into the model request, per turn)
// ============================================================================

/**
 * One tool the agent could call on a turn, as it was actually serialized for
 * the model. `source: 'meta'` marks the executor-added functions (complete,
 * pause_for_input, present_options) so the per-entry estimates sum to exactly
 * what went on the wire. `parameters` is the EMITTED schema (post-provider
 * sanitization) — the real token cost, not the pre-sanitized `inputSchema`.
 */
export const ToolSurfaceEntrySchema = z.object({
  /** Stable internal id. Graph tools: stepId. Virtual: operationId. Meta: the function name. */
  toolId: z.string(),
  /** Provider-facing function name (differs from toolId via sanitization/collision). */
  callName: z.string(),
  source: z.enum(['core', 'discovered', 'api', 'mcp', 'applet', 'graph', 'meta']),
  kind: z.enum(['graph', 'virtual', 'meta']).optional(),
  lowering: AgentToolLoweringSchema.optional(),
  operationId: z.string().optional(),
  stepType: z.string().optional(),
  description: z.string().optional(),
  /** Estimated tokens for this tool's serialized declaration/schema block. */
  estTokens: z.number().int().nonnegative(),
  /** The emitted JSON Schema (what became the declaration's `parameters`). */
  parameters: z.record(z.unknown()),
  /** Promotion provenance (filled by the orchestrator for promoted tools). */
  discoveredAtTurn: z.number().int().nonnegative().optional(),
  lastUsedAtTurn: z.number().int().nonnegative().optional(),
});
export type ToolSurfaceEntry = z.infer<typeof ToolSurfaceEntrySchema>;

/**
 * The full tool surface for one turn — the executed truth, recorded by the AI
 * executor where the request is serialized (never re-derived at read time).
 * `scope` and `discoverable` are populated by the orchestrator passthrough
 * (`AgentTurnInput.toolSurfaceContext`).
 */
export const ToolSurfaceSchema = z.object({
  deliveryMode: z.enum(['native_fc', 'generate_json']),
  provider: z.string(),
  model: z.string(),
  /** Serialized size of the active surface and a stable hash for change detection. */
  surfaceBytes: z.number().int().nonnegative(),
  surfaceHash: z.string(),
  active: z.array(ToolSurfaceEntrySchema),
  scope: ToolSurfaceScopeSchema.optional(),
  discoverable: ToolSurfaceDiscoverableSchema.optional(),
});
export type ToolSurface = z.infer<typeof ToolSurfaceSchema>;
