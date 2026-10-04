import { z } from 'zod';
import { AppletToolMetaSchema, type AppletToolMeta } from '../applet/toolMeta.js';
import {
  AgentToolLoweringSchema,
  ToolSurfaceContextSchema,
  ToolSurfaceSchema,
} from './toolSurface.js';

export * from './toolSurface.js';
import { DEFAULT_AI_MODELS } from '@aflow/lib';
import { AGENT_SIGNAL_BLOCKED_OPERATION_ID } from '../catalog/operationId.js';
import { TEXT_MODELS } from '../operations/enums.js';
import { AgentToolErrorSchema } from './errors.js';
import { SummaryTemplateSchema } from './aiPrompt.js';

// ============================================================================

/**
 * Agent role determines the behavioral contract for an agent turn.
 * - `assistant`: Conversational, ongoing interaction, user-facing thread
 * - `subagent`: Delegated bounded task, completion-first, minimal user interruption
 */
export const AgentRoleSchema = z.enum(['assistant', 'subagent']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Controls when the agent may pause and request user input.
 * - `allowed`: Agent can freely ask for user input (default for assistant)
 * - `blocked_only`: Agent should only ask when genuinely blocked (default for subagent)
 * - `never`: Agent must never ask for user input
 */
export const RequestInputPolicySchema = z.enum(['allowed', 'blocked_only', 'never']);
export type RequestInputPolicy = z.infer<typeof RequestInputPolicySchema>;

/**
 * Controls when/whether the agent should complete.
 * - `open_ended`: Agent never needs to complete; conversation continues (default for assistant)
 * - `allowed`: Agent may complete but isn't required to
 * - `must_complete_or_block`: Agent must complete when done or block when stuck (default for subagent)
 */
export const CompletionPolicySchema = z.enum(['open_ended', 'allowed', 'must_complete_or_block']);
export type CompletionPolicy = z.infer<typeof CompletionPolicySchema>;

/**
 * Blocking category for subagent input requests.
 * Explains WHY the subagent cannot continue autonomously.
 */
export const BlockingCategorySchema = z.enum([
  'missing_input',
  'approval_required',
  'external_dependency',
  'access_denied',
  'other',
]);
export type BlockingCategory = z.infer<typeof BlockingCategorySchema>;

// ============================================================================
// Response Options (structured choices for pause_for_input)
// ============================================================================

/** A single selectable option presented to the user. */
export const ResponseOptionSchema = z.object({
  value: z.string(),
  /** Display label shown to the user (defaults to value). */
  label: z.string().optional(),
});
export type ResponseOption = z.infer<typeof ResponseOptionSchema>;

/**
 * Structured response options for pause_for_input.
 * Renders as radio buttons / checkboxes (≤8) or dropdown (>8).
 * User can always type free-text instead.
 */
export const ResponseOptionsSchema = z.object({
  type: z.enum(['single', 'multi']).default('single'),
  options: z.array(ResponseOptionSchema).min(2).max(50),
});
export type ResponseOptions = z.infer<typeof ResponseOptionsSchema>;

/**
 * Resolve effective policies from agentRole + explicit overrides.
 *
 * Explicit policy fields win over role defaults, and `unattended` wins over
 * both: a configured `allowed` describes the ordinary mode rather than a
 * judgement about runs with nobody in them, so it cannot be read as consent to
 * park on a question forever.
 */
export function resolveAgentPolicies(config: {
  agentRole: AgentRole | undefined;
  requestInputPolicy: RequestInputPolicy | undefined;
  completionPolicy: CompletionPolicy | undefined;
  /**
   * Whether anybody is there to answer.
   *
   * An assistant is the conversation handler, so it pauses and never closes:
   * a conversation is not finished, it is only quiet, and the person can resume
   * whenever they like. That is right when there is a person. Started by a
   * schedule there is not, and the same behaviour parks the run forever on a
   * question nobody will read.
   *
   * So an unattended assistant takes the subagent's terminal shape: finish, or
   * say what stopped it. Not the same as forbidding every pause — an approval
   * still parks and still belongs in the Action Center, because that one is
   * addressed to a person who will come back to it. What goes is the agent's
   * discretion to ask a question into an empty room.
   */
  unattended?: boolean;
}): {
  agentRole: AgentRole;
  requestInputPolicy: RequestInputPolicy;
  completionPolicy: CompletionPolicy;
} {
  const agentRole = config.agentRole ?? 'assistant';

  // Ahead of the explicit fields, not behind them: a standing `allowed` states
  // the ordinary mode, and read as a judgement about unattended runs it wins
  // silently and parks the agent on a question no one will read.
  if (agentRole !== 'subagent' && config.unattended === true) {
    return {
      agentRole,
      requestInputPolicy: 'never',
      completionPolicy: 'must_complete_or_block',
    };
  }

  const defaults =
    agentRole === 'subagent'
      ? {
          requestInputPolicy: 'blocked_only' as const,
          completionPolicy: 'must_complete_or_block' as const,
        }
      : {
          requestInputPolicy: 'allowed' as const,
          completionPolicy: 'open_ended' as const,
        };
  return {
    agentRole,
    requestInputPolicy: config.requestInputPolicy ?? defaults.requestInputPolicy,
    completionPolicy: config.completionPolicy ?? defaults.completionPolicy,
  };
}

function nonEmptyPromptSchema(max: number, description: string) {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, {
      message: 'Prompt cannot be empty',
    })
    .describe(description);
}

// ============================================================================

/**
 * Operation catalog configuration for agent steps.
 * Only step types explicitly listed in `discovery.allowedStepTypes` are shown to the agent.
 * Omitting `catalog` entirely (or providing no `discovery.allowedStepTypes`) means no catalog is injected.
 *
 * Two formats:
 * - `summary` (default): Operation IDs + one-line descriptions grouped by stepType.
 *   Includes guidance on using `catalog.tool.list` to pull detailed schemas
 *   for specific groups or operations on-demand. Best for generalist agents.
 * - `detailed`: Full pruned JSON schemas for every operation. Best for specialist agents
 *   with small, known toolsets where you want zero round-trips.
 */
export const CatalogFormatSchema = z.enum(['summary', 'detailed', 'compact', 'none']);
export type CatalogFormat = z.infer<typeof CatalogFormatSchema>;

export const IntegrationDiscoveryModeSchema = z.enum(['none', 'bound', 'allowlist']);
export type IntegrationDiscoveryMode = z.infer<typeof IntegrationDiscoveryModeSchema>;

export const IntegrationDiscoveryAllowEntrySchema = z.object({
  sourceKind: z.enum(['api', 'mcp']),
  integrationId: z.string().min(1).max(128),
  bindingId: z.string().min(1).max(128).optional(),
  toolNames: z.array(z.string().min(1).max(256)).max(50).optional(),
});
export type IntegrationDiscoveryAllowEntry = z.infer<typeof IntegrationDiscoveryAllowEntrySchema>;

export const IntegrationDiscoveryConfigSchema = z.object({
  mode: IntegrationDiscoveryModeSchema,
  /** Restrict to specific source kinds. Defaults to both when omitted. */
  sourceKinds: z.array(z.enum(['api', 'mcp'])).optional(),
  /** Required when mode='allowlist'; ignored otherwise. */
  allowed: z.array(IntegrationDiscoveryAllowEntrySchema).max(50).optional(),
  /** Soft cap per source-kind in search results. */
  maxResultsPerSource: z.number().int().min(1).max(50).optional(),
});
export type IntegrationDiscoveryConfig = z.infer<typeof IntegrationDiscoveryConfigSchema>;

/**
 * Discovery configuration — controls what the agent can discover at runtime
 * via the discovery step (catalog.tool.search / catalog.tool.list).
 */
export const DiscoveryConfigSchema = z.object({
  /** Step types available for discovery. Supports ${state.*} refs. */
  allowedStepTypes: z.array(z.string()).optional(),
  /**
   * Operation-level allowlist. When present and non-empty it is the SOLE
   * authority for platform-operation discovery and promotion — `allowedStepTypes`
   * is IGNORED for operations (it still bounds the catalog fetch, but does not
   * widen the allowed set). Setting both does not union them: the op list wins.
   * Use one granularity per config; use `allowedOperationIds` when you want an
   * exact set, `allowedStepTypes` when you want breadth.
   */
  allowedOperationIds: z.array(z.string()).optional(),
  integrations: IntegrationDiscoveryConfigSchema.optional(),
  allowedApiIds: z.array(z.string()).optional(),
  allowedMcpServerIds: z.array(z.string()).optional(),
  /** Whether the agent can discover other agents in the space. */
  allowedAgents: z.boolean().optional(),
  /** Operations to exclude from discovery results. */
  excludeOperationIds: z.array(z.string()).optional(),
  /** Groups to exclude from discovery results. */
  excludeGroupIds: z.array(z.string()).optional(),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export const CatalogConfigSchema = z.object({
  // ── Source of truth: what the agent has as direct tools ──
  /**
   * Operations always promoted to direct callable tools from session start.
   * These bypass discovery — the model can call them immediately as native functions.
   * Typically 3-10 most-used operations for this agent's domain.
   */
  coreOperations: z.array(z.string()).optional(),
  coreAgents: z.array(z.string()).optional(),
  coreApis: z.array(z.string()).optional(),
  coreMcpServers: z.array(z.string()).optional(),

  // ── Discovery config ──
  /**
   * Step ID for the discovery step. When set, the agent can discover additional
   * operations beyond coreOperations and have them promoted to direct tools.
   */
  discoveryStepId: z.string().optional(),
  /** Discovery scope — controls what the agent can find via the discovery step. */
  discovery: DiscoveryConfigSchema.optional(),

  // ── Awareness block format ──
  /**
   * Catalog format for the awareness context block.
   * - 'summary': opID + one-liner menu (~2K tokens). Default when no coreOperations.
   * - 'detailed': full pruned schemas per operation. For specialist agents.
   * - 'compact': step-type-level summary (~200 tokens). Auto-selected when coreOperations is set.
   * - 'none': no catalog block. Auto-selected when coreOperations covers all scope ops.
   *
   * When omitted, the orchestrator auto-derives the optimal format from coreOperations coverage.
   */
  format: CatalogFormatSchema.optional(),
});
export type CatalogConfig = z.infer<typeof CatalogConfigSchema>;

// ============================================================================
// Agent Tool Spec (derived from flow definition + catalog at runtime)
// ============================================================================

/**
 * Tool kind: graph (authored step) or virtual (promoted operation).
 * - graph: backed by a step in the agent's flow graph
 * - virtual: promoted from the operation catalog, lowered to run_step internally
 */
export const AgentToolKindSchema = z.enum(['graph', 'virtual']);
export type AgentToolKind = z.infer<typeof AgentToolKindSchema>;

export const AgentToolSpecSchema = z.object({
  /** Stable internal identifier. Graph tools: stepId. Virtual tools: operationId. */
  toolId: z.string(),
  /** Provider-facing function name (derived from toolId, sanitized per provider) */
  callName: z.string().optional(),
  /** Whether this is an authored graph step or a promoted operation. Defaults to 'graph'. */
  kind: AgentToolKindSchema.optional(),
  /** How the orchestrator executes this tool. Defaults to 'step'. */
  lowering: AgentToolLoweringSchema.optional(),
  /** Operation ID (e.g., "api.http.call", "memory.store.query") */
  operationId: z.string(),
  /** Step type (e.g., "ai", "api", "memory") */
  stepType: z.string(),
  /** Human-readable name for the tool */
  name: z.string(),
  /** Description for the model */
  description: z.string().optional(),
  /** JSON Schema for the tool's input */
  inputSchema: z.record(z.unknown()).default({}),
  /** For graph tools: the backing step definition ID */
  backingStepId: z.string().optional(),
  /** For virtual tools: where it came from */
  source: z.enum(['core', 'discovered', 'api', 'mcp', 'applet']).optional(),
  apiMeta: z
    .object({
      apiId: z.string(),
      endpointId: z.string(),
      /** 104n: explicit binding identity. When present, lowering uses this
       *  binding directly instead of scope-based heuristic resolution. */
      bindingId: z.string().optional(),
      /** 104n: capability identity from the task grant (V1: same as bindingId). */
      capabilityId: z.string().optional(),
    })
    .optional(),
  /**
   * Applet action lowered over ui.applet.act (Plan 264 §4.14). The lowering
   * injects instanceId/baseVersion and mints actionId at dispatch — a model
   * must not mint idempotency keys or assert versions.
   */
  appletMeta: AppletToolMetaSchema.optional(),
  mcpMeta: z
    .object({
      serverId: z.string(),
      toolName: z.string(),
      bindingId: z.string().optional(),
      capabilityId: z.string().optional(),
      /**
       * Present when the server runs on the operator's own machine. It decides
       * where the call is lowered — a remote server is reached by the MCP lane,
       * this one by the host lane, and nothing else about the tool differs.
       */
      hostBindingId: z.string().optional(),
    })
    .optional(),
  /** Governance metadata */
  governance: z
    .object({
      sideEffects: z.boolean().default(false),
      opTaskOnly: z.boolean().default(false),
    })
    .optional(),
  /**
   * Promotion provenance for session-discovered (agent-promoted) tools. Stamped
   * by the orchestrator from `ai.agent._virtualTools`; absent on pinned tools.
   */
  discoveredAtTurn: z.number().int().nonnegative().optional(),
  lastUsedAtTurn: z.number().int().nonnegative().optional(),
});
export type AgentToolSpec = z.infer<typeof AgentToolSpecSchema>;

/** Pinned/virtual cap pressure (pinned = MAX_TOTAL_TOOLS, virtual = MAX_VIRTUAL_TOOLS). */
export const ToolSurfaceScopeSchema = z.object({
  pinnedUsed: z.number().int().nonnegative(),
  pinnedMax: z.number().int().nonnegative(),
  virtualUsed: z.number().int().nonnegative(),
  virtualMax: z.number().int().nonnegative(),
});
export type ToolSurfaceScope = z.infer<typeof ToolSurfaceScopeSchema>;

// ============================================================================
// Agent Turn Input (sent to ai.agent.turn operation)
// ============================================================================

/**
 * Provider-native reasoning continuity mode (Plan 259).
 *
 * - `off` (default): retain only the minimum provider reasoning needed to keep
 *   the active tool-use exchange wire-valid; discard the rest.
 * - `tool_loop`: retain native reasoning across the current assistant tool-use
 *   turn (since the last user instruction); reset when a new instruction starts.
 * - `conversation`: retain compatible native reasoning across the session,
 *   bounded by provider-native compaction. Requires model capability
 *   (`reasoningContinuity.conversation`); authoring it on a model that lacks it
 *   fails before the provider call with `AI_REASONING_CONTINUITY_UNSUPPORTED`.
 */
/**
 * `auto` is the default and means "retain across the tool loop wherever the
 * provider can". It exists because the other modes fail loud on a provider that
 * cannot replay reasoning — correct for a choice someone made, catastrophic for
 * a default, which would fail every turn on three of the five providers.
 * Naming an explicit mode keeps the loud failure.
 */
export const ReasoningContinuityModeSchema = z.enum(['auto', 'off', 'tool_loop', 'conversation']);
export type ReasoningContinuityMode = z.infer<typeof ReasoningContinuityModeSchema>;

/**
 * Policy governing agent behavior per turn.
 */
export const AgentTurnPolicySchema = z.object({
  maxToolCallsPerTurn: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Max tool calls per turn (1–20)'),
  allowParallel: z.boolean().default(false).describe('Allow invoking multiple tools in parallel'),
  maxParallel: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Max parallel tool calls (1–10)'),
  allowComplete: z
    .boolean()
    .default(true)
    .describe('Whether the agent can terminate the run (derived from agentRole/completionPolicy)'),
  budgetHints: z
    .object({
      maxTotalTurns: z.number().int().positive().optional(),
      maxTotalToolCalls: z.number().int().positive().optional(),
      maxTotalTokens: z.number().int().positive().optional(),
    })
    .describe('Budget limits across all turns')
    .optional(),
});
export type AgentTurnPolicy = z.infer<typeof AgentTurnPolicySchema>;

export const AgentContextProfileSchema = z.enum(['minimal', 'default', 'detailed', 'debug']);
export type AgentContextProfile = z.infer<typeof AgentContextProfileSchema>;

/**
 * Input to the ai.agent.turn operation.
 * The orchestrator assembles this from the flow definition, history, context, and tool specs.
 */
export const AgentTurnInputSchema = z.object({
  model: z.enum(TEXT_MODELS).or(z.string()).describe('AI model to use').optional(),
  agentRole: AgentRoleSchema.default('assistant').describe(
    'Agent role: assistant (conversational) or subagent (bounded task)',
  ),
  systemPrompt: z.string().max(100_000).describe('Agent persona and instructions').optional(),
  prompt: nonEmptyPromptSchema(100_000, 'The user request or goal for this turn'),
  context: z.record(z.unknown()).describe('Structured context data keyed by label').optional(),
  contextProfile: AgentContextProfileSchema.optional()
    .default('default')
    .describe(
      'Optional runtime-context profile. `minimal` = most cache-friendly, `default` = add current date, `detailed` = add run-aware metadata, `debug` = include full volatile debugging context.',
    ),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .describe('Creativity level (0 = precise, 2 = creative)')
    .optional(),
  maxTokens: z
    .number()
    .int()
    .positive()
    .max(128_000)
    .describe('Maximum output tokens per model call (provider default if omitted)')
    .optional(),
  reasoningEffort: z
    .enum(['off', 'low', 'medium', 'high'])
    .optional()
    .describe(
      'Reasoning effort override. Resolution: this field → catalog model default → provider default. Populated by the orchestrator from `EntityDirectives.reasoningDefaults` when the caller has a cybernetic role.',
    ),
  reasoningContinuity: ReasoningContinuityModeSchema.optional().describe(
    'Resolved provider-native reasoning continuity mode (Plan 259). Orthogonal to reasoningEffort: effort controls how much the current response reasons; continuity controls whether provider-native reasoning is carried into the next tool-use turn.',
  ),
  requestInputPolicy: RequestInputPolicySchema.optional().describe(
    'When the agent may pause for user input (derived from agentRole if omitted)',
  ),
  completionPolicy: CompletionPolicySchema.optional().describe(
    'When/whether the agent should complete (derived from agentRole if omitted)',
  ),
  finalOutputSchema: z
    .record(z.unknown())
    .optional()
    .describe('JSON Schema for structured completion result (subagent)'),
  completionPrompt: z
    .string()
    .max(4000)
    .optional()
    .describe('Explicit finish instructions appended near end of prompt (subagent)'),
  availableTools: z
    .array(AgentToolSpecSchema)
    .describe('Tools the agent can invoke (derived from connected steps)'),
  toolSurfaceContext: ToolSurfaceContextSchema.optional().describe(
    'Orchestrator-resolved cap pressure + discoverable tier; the executor echoes it onto AgentTurnOutput.toolSurface (observability only).',
  ),
  historyRef: z.string().describe('Reference to conversation history').optional(),
  contextRef: z.string().describe('Reference to context snapshot').optional(),
  lastToolResults: z
    .array(
      z.object({
        toolCallId: z.string(),
        toolId: z.string(),
        name: z.string(),
        status: z.enum(['SUCCEEDED', 'FAILED', 'PAUSED']),
        summary: z.string().max(16000).optional(),
        error: AgentToolErrorSchema.optional(),
      }),
    )
    .describe('Recent tool results for grounding')
    .optional(),
  policy: AgentTurnPolicySchema.default({}).describe('Turn limits and parallelism settings'),
  turnNumber: z.number().int().nonnegative().default(0).describe('Current turn number'),
  totalToolCallsSoFar: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Cumulative tool calls across all turns'),
  contextWindowOverride: z.number().int().positive().optional(),
});
export type AgentTurnInput = z.infer<typeof AgentTurnInputSchema>;

/**
 * The largest step output, as JSON with its internal payload references
 * removed, that an agent is shown whole. Anything larger is stored and the
 * agent is handed a summary and a path to read it back from — a second call
 * for what was one result. A producer that wants its results read in one call
 * bounds them under this.
 */
export const TOOL_RESULT_INLINE_MAX_CHARS = 12_288;

// ============================================================================
// Agent Turn Decision (output from ai.agent.turn)
// ============================================================================

/**
 * User-visible agent communication — what the agent chose to say and what the
 * user reads in chat. This is the product of the turn, so the cap is a generous
 * backstop against runaway output, not a concision enforcer.
 */
export const DECISION_MESSAGE_MAX = 16000;
/**
 * Debug/observability rationale. Not user-facing and not part of the turn's
 * success, but it is replayed into the next turn's history — so it gets enough
 * room to hold a genuine rationale without bloating the transcript.
 */
export const DECISION_REASONING_MAX = 8000;
/** Short auxiliary strings: the TTS voice line and the blocking reason. */
const DECISION_TEXT_MAX = 4000;

/**
 * The agent's decision after a turn.
 * Discriminated union on "action".
 */
export const AgentTurnDecisionSchema = z.discriminatedUnion('action', [
  // Invoke a single tool
  z.object({
    action: z.literal('invoke_step'),
    /** Tool ID to invoke (must be in availableTools) */
    toolId: z.string(),
    /** Arguments for the tool (validated against its input schema). Must be an object even when empty (`{}`). */
    args: z.record(z.unknown()),
    /** Optional user-visible message to show now */
    message: z.string().max(DECISION_MESSAGE_MAX).optional(),
    /** Agent's reasoning (for observability/debugging) */
    reasoning: z.string().max(DECISION_REASONING_MAX).nullable().optional(),
    /** Native model thinking (chain-of-thought from reasoning-capable models). Distinct from `reasoning` — this is the model's internal reasoning surfaced by the provider, not a field the model was asked to fill. */
    thinking: z.string().nullable().optional(),
  }),

  // Invoke multiple tools
  z.object({
    action: z.literal('invoke_steps'),
    /** Tool calls to make */
    calls: z.array(
      z.object({
        toolId: z.string(),
        /** Arguments for the tool. Must be an object even when empty (`{}`). */
        args: z.record(z.unknown()),
        /** Idempotency key for deduplication */
        idempotencyKey: z.string().optional(),
      }),
    ),
    /** Optional user-visible message */
    message: z.string().max(DECISION_MESSAGE_MAX).optional(),
    reasoning: z.string().max(DECISION_REASONING_MAX).nullable().optional(),
    /** Native model thinking (see `invoke_step` variant for details). */
    thinking: z.string().nullable().optional(),
  }),

  // Pause for user input
  z.object({
    action: z.literal('pause_for_input'),
    /** The message to show the user */
    message: z.string().max(DECISION_MESSAGE_MAX),
    /** Short spoken version for TTS (voice mode only) */
    voiceMessage: z.string().max(DECISION_TEXT_MAX).optional(),
    /** JSON Schema for the expected input (defaults to { type: "string" }) */
    inputSchema: z.record(z.unknown()).optional(),
    /** Structured choices — rendered as buttons/dropdown. User can always type free-text. */
    responseOptions: ResponseOptionsSchema.optional(),
    /** Agent's reasoning (for observability/debugging) */
    reasoning: z.string().max(DECISION_REASONING_MAX).nullable().optional(),
    /** Why the agent is blocked (required for subagent role with blocked_only policy) */
    blockingReason: z.string().max(DECISION_TEXT_MAX).optional(),
    /** Category of blocking condition */
    blockingCategory: BlockingCategorySchema.optional(),
    /** Native model thinking (see `invoke_step` variant for details). */
    thinking: z.string().nullable().optional(),
  }),

  // Complete the run
  z.object({
    action: z.literal('complete'),
    /** Final result (ref-first via variable mapping) */
    result: z.unknown(),
    /** Optional user-visible message */
    message: z.string().max(DECISION_MESSAGE_MAX).optional(),
    /** Short spoken version for TTS (voice mode only) */
    voiceMessage: z.string().max(DECISION_TEXT_MAX).optional(),
    reasoning: z.string().max(DECISION_REASONING_MAX).nullable().optional(),
    /** Native model thinking (see `invoke_step` variant for details). */
    thinking: z.string().nullable().optional(),
  }),
]);
export type AgentTurnDecision = z.infer<typeof AgentTurnDecisionSchema>;

/**
 * Whether `pause_for_input` is a permissible action for this policy.
 *
 * `'allowed'` and `'blocked_only'` both permit the action; `'blocked_only'`
 * additionally requires the decision to carry explicit blocking metadata
 * (see {@link isExplicitlyBlockedPauseDecision}). `'never'` forbids it entirely.
 *
 * `undefined` means "use the role default", which is not `never`.
 */
export function isPauseForInputAllowed(
  requestInputPolicy: RequestInputPolicy | undefined,
): boolean {
  return requestInputPolicy !== 'never';
}

/**
 * Whether a *text-only* turn (no tool calls) should be implicitly interpreted
 * as a `pause_for_input`.
 *
 * This is the assistant/conversational contract: "no tool calls = I'm replying
 * to the user, their turn next." Only `'allowed'` opts into that semantic.
 *
 * For `'never'`, text-only means "I'm done, here's my final output" and
 * should be treated as `complete`.
 *
 * For `'blocked_only'`, text-only is also treated as a pause — a subagent
 * that responds in text without calling `complete()` didn't finish its task.
 * The auto-generated `blockingReason` ensures the decision passes the
 * `blocked_only` gate in {@link normalizeDisallowedPauseDecision}.
 */
export function canImplicitlyPauseOnTextOnly(
  requestInputPolicy: RequestInputPolicy | undefined,
): boolean {
  const policy = requestInputPolicy ?? 'allowed';
  return policy === 'allowed' || policy === 'blocked_only';
}

/**
 * Whether a `pause_for_input` decision carries the explicit block metadata
 * required under `'blocked_only'` policy.
 */
export function isExplicitlyBlockedPauseDecision(decision: AgentTurnDecision): boolean {
  if (decision.action !== 'pause_for_input') return false;
  const hasReason =
    typeof decision.blockingReason === 'string' && decision.blockingReason.trim().length > 0;
  const hasCategory = decision.blockingCategory !== undefined;
  return hasReason || hasCategory;
}

/**
 * Allowed agent decision actions after request-input policy and completion
 * allowances are applied.
 */
export function getAllowedAgentDecisionActions(params: {
  requestInputPolicy: RequestInputPolicy | undefined;
  allowComplete: boolean;
}): Array<AgentTurnDecision['action']> {
  const actions: Array<AgentTurnDecision['action']> = ['invoke_step', 'invoke_steps'];
  if (isPauseForInputAllowed(params.requestInputPolicy)) {
    actions.push('pause_for_input');
  }
  if (params.allowComplete) {
    actions.push('complete');
  }
  return actions;
}

/**
 * The tool-surface projection needed to locate the blocked-signal escape and
 * shape its arguments.
 */
export type BlockedSignalToolSource = Pick<AgentToolSpec, 'toolId' | 'operationId' | 'inputSchema'>;

export function findBlockedSignalTool(
  availableTools: readonly BlockedSignalToolSource[] | undefined,
): BlockedSignalToolSource | undefined {
  return availableTools?.find((tool) => tool.operationId === AGENT_SIGNAL_BLOCKED_OPERATION_ID);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateTo(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const BLOCKED_REASON_FALLBACK_MAX = 1000;
const BLOCKED_CATEGORY_FALLBACK = 'missing_input';
/**
 * A coerced blocked-signal is the platform acting on the agent's behalf; an
 * unprefixed reason reads as if the agent deliberately blocked with its own
 * prose, which misleads both the supervising agent and the operator.
 */
export const BLOCKED_REASON_AUTO_CONVERT_PREFIX =
  '[auto-converted: the agent replied with text instead of a legal action] ';

/**
 * Build an `invoke_step` decision targeting the blocked-signal tool, carrying
 * the model's text as the blocking reason. The legal escape for an agent that
 * can neither pause for input nor complete: the run pauses and the reason
 * bubbles to the supervising agent instead of the task dying on a policy
 * violation. Argument caps and the category value are read from the tool's
 * actual input schema so the coerced call passes tool-arg validation.
 */
export function buildBlockedSignalDecision(params: {
  tool: BlockedSignalToolSource;
  message: string;
  reasoning?: string | null | undefined;
}): AgentTurnDecision {
  const properties = isJsonObject(params.tool.inputSchema['properties'])
    ? params.tool.inputSchema['properties']
    : {};
  const reasonSchema = isJsonObject(properties['reason']) ? properties['reason'] : {};
  const reasonMax =
    typeof reasonSchema['maxLength'] === 'number' && reasonSchema['maxLength'] > 0
      ? reasonSchema['maxLength']
      : BLOCKED_REASON_FALLBACK_MAX;
  const categorySchema = isJsonObject(properties['category']) ? properties['category'] : {};
  const categoryEnum = Array.isArray(categorySchema['enum'])
    ? categorySchema['enum'].filter((value): value is string => typeof value === 'string')
    : [];
  const category = categoryEnum.includes(BLOCKED_CATEGORY_FALLBACK)
    ? BLOCKED_CATEGORY_FALLBACK
    : (categoryEnum[0] ?? BLOCKED_CATEGORY_FALLBACK);

  const trimmedMessage = params.message.trim();
  const reason = truncateTo(
    trimmedMessage.length > 0
      ? `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}${trimmedMessage}`
      : 'Agent could not proceed and had no way to request input.',
    reasonMax,
  );
  const reasoning = params.reasoning?.trim();

  return {
    action: 'invoke_step',
    toolId: params.tool.toolId,
    args: { reason, category },
    ...(trimmedMessage.length > 0
      ? { message: truncateTo(trimmedMessage, DECISION_MESSAGE_MAX) }
      : {}),
    ...(reasoning ? { reasoning: truncateTo(reasoning, DECISION_REASONING_MAX) } : {}),
  };
}

/**
 * Native function-calling models sometimes reply with plain text and no tool
 * calls. Convert that fallback into the best legal decision for the agent.
 *
 * - `'allowed'` (assistant/conversational): text-only = implicit pause
 * - `'blocked_only'` (subagent): text-only = implicit pause with auto
 *   blockingReason — a subagent that responds in text without calling
 *   `complete()` didn't finish its task; treat as blocked so the pause
 *   bubbles up to the supervising agent.
 * - `'never'`: text-only = implicit complete (pausing is forbidden). When
 *   completion is also forbidden, route through the blocked-signal tool if the
 *   agent has one — the only decision the policy would not reject.
 */
export function buildImplicitTextOnlyAgentDecision(params: {
  requestInputPolicy: RequestInputPolicy | undefined;
  allowComplete: boolean;
  message: string;
  availableTools?: readonly BlockedSignalToolSource[] | undefined;
}): AgentTurnDecision {
  if (!canImplicitlyPauseOnTextOnly(params.requestInputPolicy)) {
    if (params.allowComplete) {
      return {
        action: 'complete',
        result: params.message,
        ...(params.message ? { message: params.message } : {}),
      };
    }
    const blockedSignalTool = findBlockedSignalTool(params.availableTools);
    if (blockedSignalTool) {
      return buildBlockedSignalDecision({ tool: blockedSignalTool, message: params.message });
    }
  }

  const policy = params.requestInputPolicy ?? 'allowed';

  // 'blocked_only': auto-generate blockingReason so the decision passes
  // the normalizeDisallowedPauseDecision gate (which requires explicit
  // blocking metadata under 'blocked_only').
  if (policy === 'blocked_only') {
    return {
      action: 'pause_for_input',
      message: params.message,
      blockingReason: 'Agent responded in text without calling complete — treating as blocked',
      blockingCategory: 'missing_input' as BlockingCategory,
    };
  }

  return {
    action: 'pause_for_input',
    message: params.message,
  };
}

/**
 * Defense-in-depth: coerce a `pause_for_input` decision that is illegal for
 * the current policy into a `complete` decision using the pause message as
 * the final result payload.
 *
 * Rules:
 * - `'allowed'`: any pause is legitimate — pass through.
 * - `'blocked_only'`: pause is legitimate only when it carries explicit
 *   blocking metadata (`blockingReason` or `blockingCategory`). Otherwise
 *   coerce to `complete`.
 * - `'never'`: no pause is legitimate — always coerce to `complete`.
 *
 * When `allowComplete` is false there is no completion target. Under `'never'`
 * the blocked-signal tool (when the agent has one) is the remaining legal
 * escape — coerce the pause into that call so the run pauses visibly instead
 * of failing validation. Otherwise leave the decision alone and let validation
 * reject it loudly.
 */
export function normalizeDisallowedPauseDecision(params: {
  requestInputPolicy: RequestInputPolicy | undefined;
  allowComplete: boolean;
  decision: AgentTurnDecision;
  availableTools?: readonly BlockedSignalToolSource[] | undefined;
}): AgentTurnDecision {
  if (params.decision.action !== 'pause_for_input') {
    return params.decision;
  }

  if (!params.allowComplete) {
    if ((params.requestInputPolicy ?? 'allowed') === 'never') {
      const blockedSignalTool = findBlockedSignalTool(params.availableTools);
      if (blockedSignalTool) {
        return buildBlockedSignalDecision({
          tool: blockedSignalTool,
          message: params.decision.message,
          reasoning: params.decision.reasoning,
        });
      }
    }
    return params.decision;
  }

  const policy = params.requestInputPolicy ?? 'allowed';
  if (policy === 'allowed') {
    return params.decision;
  }
  if (policy === 'blocked_only' && isExplicitlyBlockedPauseDecision(params.decision)) {
    return params.decision;
  }

  const message =
    params.decision.message.trim().length > 0
      ? params.decision.message
      : '[Agent attempted to request input, but input requests are disabled.]';

  return {
    action: 'complete',
    result: message,
    message,
    ...(params.decision.reasoning ? { reasoning: params.decision.reasoning } : {}),
  };
}

// ============================================================================
// Agent Turn Output (full output from ai.agent.turn)
// ============================================================================

/**
 * Full output from ai.agent.turn: decision + metadata.
 */
export const TokenEstimateSchema = z.object({
  /** Estimated tokens in system prompt (base only — tool schemas are `tools`). */
  system: z.number().int().nonnegative(),
  /** Estimated tokens in context blocks */
  context: z.number().int().nonnegative(),
  /** Estimated tokens in conversation history */
  history: z.number().int().nonnegative(),
  /**
   * Estimated tokens for the tool surface (native-FC declarations, or the
   * JSON-mode tool-schema section). Non-overlapping with `system`.
   */
  tools: z.number().int().nonnegative(),
  /** Total estimated tokens (system + context + history + tools) */
  total: z.number().int().nonnegative(),
  /** Model's context window size */
  modelWindow: z.number().int().nonnegative(),
  /** Tokens reserved for model completion response */
  reservedForCompletion: z.number().int().nonnegative().default(4096),
  /** Hard budget = modelWindow - reservedForCompletion - safetyMargin; bounds the forced clearing. */
  effectiveBudget: z.number().int().nonnegative(),
  /** Utilization = total / effectiveBudget */
  utilization: z.number().nonnegative(),
  /** Working budget = effectiveBudget capped by the retention policy; triggers clearing and compaction. */
  workingBudget: z.number().int().nonnegative(),
  /** Working utilization = total / workingBudget */
  workingUtilization: z.number().nonnegative(),
});
export type TokenEstimate = z.infer<typeof TokenEstimateSchema>;

export const AgentTurnOutputSchema = z.object({
  /** The agent's decision */
  decision: AgentTurnDecisionSchema,
  /** Token usage for this turn */
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    /** Tokens spent on internal reasoning (subset of completionTokens). */
    reasoningTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    uncachedPromptTokens: z.number().int().nonnegative().optional(),
  }),
  /** Model used */
  model: z.string(),
  /** Turn number */
  turnNumber: z.number().int().nonnegative(),
  /**
   * Short audit trail when the turn required repair or fallback (e.g. Zod repair, native FC→JSON).
   * `modelMessages` / `modelOutput` always reflect the final accepted attempt only.
   */
  decisionAttemptSummary: z.array(z.string()).optional(),
  tokenEstimate: TokenEstimateSchema.optional(),
  /**
   * Non-sensitive provider-native reasoning continuity diagnostics (Plan 259).
   * Never carries reasoning content — only mode, provider, and byte/item counts.
   */
  reasoningContinuity: z
    .object({
      requestedMode: ReasoningContinuityModeSchema,
      effectiveMode: ReasoningContinuityModeSchema,
      provider: z.string(),
      /** Bytes of provider reasoning replayed into this request. */
      stateBytes: z.number().int().nonnegative(),
      /** Count of assistant turns whose reasoning was replayed. */
      stateItems: z.number().int().nonnegative().optional(),
      /** Why optional reasoning was reset this turn, if it was. */
      resetReason: z.enum(['provider_switch', 'model_switch']).optional(),
    })
    .optional(),
  /**
   * The tools serialized into this turn's model request, with per-tool token
   * cost. Optional so a read of an older payload (or an error path) tolerates
   * its absence; the executor always writes it on a normal turn.
   */
  toolSurface: ToolSurfaceSchema.optional(),
});
export type AgentTurnOutput = z.infer<typeof AgentTurnOutputSchema>;

// ============================================================================
// Agent Step Config (in flow definition step.config)
// ============================================================================

/**
 * Configuration for an agent step.
 * This is the config object inside a step definition with operation = "ai.agent.turn".
 */
export const AgentStepConfigSchema = z.object({
  /** Model to use */
  model: z.enum(TEXT_MODELS).or(z.string()).default(DEFAULT_AI_MODELS.text),
  /**
   * Agent role determines the behavioral contract.
   * - assistant: Conversational, ongoing interaction, user-facing thread (default)
   * - subagent: Delegated bounded task, completion-first, minimal user interruption
   */
  agentRole: AgentRoleSchema.default('assistant'),
  /** Agent persona and instructions */
  systemPrompt: z.string().max(100_000).optional(),
  /** Author-defined goal/prompt for the turn */
  prompt: z.string().max(100_000).optional(),
  /** Structured context blocks resolved into the turn context message */
  context: z.record(z.unknown()).optional(),
  /** Optional runtime-context profile with a cache-friendly default */
  contextProfile: AgentContextProfileSchema.optional().default('default'),
  /** Temperature */
  temperature: z.number().min(0).max(2).default(0.1),
  /** Maximum output tokens per model call (provider default ~8192 if omitted) */
  maxTokens: z.number().int().positive().max(128_000).optional(),
  /** Override request-input policy (derived from agentRole if omitted) */
  requestInputPolicy: RequestInputPolicySchema.optional(),
  /** Override completion policy (derived from agentRole if omitted) */
  completionPolicy: CompletionPolicySchema.optional(),
  /** JSON Schema the subagent's `complete.result` must validate against */
  finalOutputSchema: z.record(z.unknown()).optional(),
  /** Explicit finish instructions appended to the prompt (subagent) */
  completionPrompt: z.string().max(4000).optional(),
  /** Turn policy (tool limits, parallelism, budget hints) */
  turnPolicy: AgentTurnPolicySchema.default({}),
  maxDelegationDepth: z.number().int().min(1).max(10).default(3).optional(),
  maxParallelDelegates: z.number().int().min(1).max(20).default(5).optional(),
  historyPolicy: z
    .object({
      enabled: z.boolean().default(true),
      maxMessages: z.number().int().positive().default(50),
      truncationPolicy: z.enum(['sliding_window', 'oldest_first']).default('sliding_window'),
      includeToolMessages: z.boolean().default(true),
    })
    .default({}),
  /** Context policy */
  contextPolicy: z
    .object({
      enabled: z.boolean().default(true),
      contextVariables: z.array(z.string()).default([]),
      mode: z.enum(['inline_small', 'ref_only']).default('inline_small'),
    })
    .default({}),
  /** Output policy */
  outputPolicy: z
    .object({
      /** Emit user-visible message alongside tool invocations */
      emitMessageOnToolCall: z.boolean().default(true),
      /** Emit user-visible message on completion */
      emitMessageOnComplete: z.boolean().default(true),
    })
    .default({}),
  catalog: CatalogConfigSchema.optional(),
  summaryTemplate: SummaryTemplateSchema.optional(),
  contextWindowOverride: z.number().int().positive().optional(),
  /**
   * Provider-native reasoning continuity (Plan 259).
   *
   * `auto` by default — tool-loop retention wherever the provider supports it:
   * an agent that reasons its way to a tool call and
   * then cannot see that reasoning when the result returns will re-derive it,
   * and re-derivation does not reliably reproduce the same plan. A live Runner
   * planned twelve cases inside its reasoning, emitted the opening move, lost
   * the plan, and re-sent that same move 130 times. Reasoning the next turn
   * cannot see is reasoning worth not paying for.
   *
   * Only `conversation` — retention across user turns, not just the tool loop —
   * remains an opt-in. Naming `tool_loop` explicitly still fails loud on a
   * provider that cannot replay it; `auto` degrades to `off` there instead.
   */
  reasoningContinuity: ReasoningContinuityModeSchema.default('auto'),
});
export type AgentStepConfig = z.infer<typeof AgentStepConfigSchema>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build AgentToolSpec for a graph step (authored in the flow definition).
 */
export function buildToolSpec(params: {
  stepId: string;
  stepType: string;
  operationId: string;
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}): AgentToolSpec {
  return {
    toolId: params.stepId,
    kind: 'graph',
    lowering: 'step',
    operationId: params.operationId,
    stepType: params.stepType,
    name: params.name ?? params.stepId,
    description: params.description,
    inputSchema: params.inputSchema ?? {},
    backingStepId: params.stepId,
  };
}

/**
 * Build AgentToolSpec for a virtual tool (promoted from operation catalog).
 */
export function buildVirtualToolSpec(params: {
  operationId: string;
  stepType: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source: 'core' | 'discovered' | 'api' | 'mcp' | 'applet';
  /** Override the default lowering ('run_step'). Use 'delegate' for agent virtual tools, 'api_call' for API tools, 'mcp_call' for MCP tools. */
  lowering?: 'run_step' | 'delegate' | 'api_call' | 'mcp_call';
  /** Override the default toolId (the operationId). Applet tools carry a per-action toolId over the shared ui.applet.act operation. */
  toolId?: string;
  /** Override the default callName (derived from operationId). */
  callName?: string;
  apiMeta?: { apiId: string; endpointId: string; bindingId?: string; capabilityId?: string };
  mcpMeta?: {
    serverId: string;
    toolName: string;
    bindingId?: string;
    capabilityId?: string;
    hostBindingId?: string;
  };
  appletMeta?: AppletToolMeta;
}): AgentToolSpec {
  const spec: AgentToolSpec = {
    toolId: params.toolId ?? params.operationId,
    kind: 'virtual',
    lowering: params.lowering ?? 'run_step',
    operationId: params.operationId,
    stepType: params.stepType,
    name: params.name,
    description: params.description,
    inputSchema: params.inputSchema,
    source: params.source,
  };
  if (params.callName) spec.callName = params.callName;
  if (params.apiMeta) spec.apiMeta = params.apiMeta;
  if (params.mcpMeta) spec.mcpMeta = params.mcpMeta;
  if (params.appletMeta) spec.appletMeta = params.appletMeta;
  return spec;
}

/**
 * Check if a step definition is an agent step.
 */
export function isAgentStep(step: { operation: string }): boolean {
  return step.operation === 'ai.agent.turn';
}
