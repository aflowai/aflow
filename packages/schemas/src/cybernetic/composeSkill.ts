import { z } from 'zod';
import {
  OutcomeSchema,
  PAUSE_INSTRUCTION_MAX_CHARS,
  WorkflowTaskPollSchema,
  WorkflowTaskOutputProjectionSchema,
} from '../operations/workflow.js';
import { analyzeInputTemplate, TEMPLATE_BIND_KEY } from '../operations/workflow/taskTemplate.js';
import { ProcedureActivationSchema, CapabilityGrantKindSchema } from './context.js';
import { ApiCallModeSchema } from '../models/apiDefinition.js';
import { ComposedWorkflowSchema } from './stagedChange.js';
import { SkillCampaignContractSchema, SkillGoalDirectionSchema, SkillGoalSchema } from './skill.js';
import { campaignParam, isCampaignRef, CAMPAIGN_FIELD_KEY_RE } from './campaignRef.js';

// ============================================================================
// ComposeIntent — output of analyze-intent (§5.1)
// ============================================================================

/**
 * Hard requirement for a capability the user goal explicitly named or that
 * the goal structurally requires. NEVER droppable downstream — the
 * `capability-references-bound` validator suppresses the "drop" suggestion
 * when an unbound reference appears in this list.
 */
export const ComposeIntentRequiredCapabilitySchema = z.object({
  kind: z.enum(['api', 'mcp', 'operation', 'compute']),
  /** apiId | serverId | operation prefix | the literal "compute". */
  identifier: z.string().min(1).max(120),
  /** Why the user goal needs this capability. */
  rationale: z.string().min(1).max(500),
});
export type ComposeIntentRequiredCapability = z.infer<typeof ComposeIntentRequiredCapabilitySchema>;

/**
 * Hard requirement for real-source data. Tasks producing such data have
 * provenance contracts attached at assemble-workflow time (§11) — fabrication
 * is rejected at submit_output.
 */
export const ComposeIntentRequiredDataSourceSchema = z.object({
  purposeId: z.string().min(1).max(200),
  sourceKind: z.enum(['api', 'mcp', 'memory', 'user-upload']),
  /** When known, the apiId / serverId / memory key. */
  sourceId: z.string().min(1).max(200).optional(),
});
export type ComposeIntentRequiredDataSource = z.infer<typeof ComposeIntentRequiredDataSourceSchema>;

/**
 * Optional advisory hint for the downstream draft-task-graph phase.
 * §13.5 keeps these as soft constraints — the design phase may add or omit
 * tasks but should rationalize deviations.
 */
export const ComposeIntentTaskShapeHintSchema = z.object({
  purpose: z.string().min(1).max(200),
  suggestedKind: z.enum(['agent', 'operation', 'human']),
});
export type ComposeIntentTaskShapeHint = z.infer<typeof ComposeIntentTaskShapeHintSchema>;

export const ComposeIntentPauseForUserSchema = z.object({
  needed: z.boolean(),
  /** Free-form description of where in the workflow the pause should sit. */
  when: z.string().max(280).optional(),
});
export type ComposeIntentPauseForUser = z.infer<typeof ComposeIntentPauseForUserSchema>;

export const ComposeIntentSchema = z.object({
  /**
   * compose-skill is create-only. Requests to fix/modify an existing skill
   * must route through workflow.manage.patch / workflow_refinement instead.
   */
  authoringIntent: z
    .enum(['create_new_skill', 'modify_existing_skill'])
    .default('create_new_skill'),
  /** Restated user intent in one paragraph — what the skill must do. */
  intent: z.string().min(1).max(2000),
  /** Maps to WorkflowModeSchema downstream. No `'graph'` value (§5.4). */
  iterationModel: z.enum(['optimization', 'process', 'project']),
  requiredCapabilities: z.array(ComposeIntentRequiredCapabilitySchema).max(20).default([]),
  requiredDataSources: z.array(ComposeIntentRequiredDataSourceSchema).max(20).default([]),
  taskShapeHints: z.array(ComposeIntentTaskShapeHintSchema).max(20).default([]),
  pauseForUser: ComposeIntentPauseForUserSchema.default({ needed: false }),
});
export type ComposeIntent = z.infer<typeof ComposeIntentSchema>;

// ============================================================================
// DesignSurface — output of prepare-design-surface (§5.2 / §6.2)
// ============================================================================

export const DesignSurfaceIntegrationSchema = z.object({
  sourceKind: z.enum(['api', 'mcp']),
  /** API definition `apiId` or MCP server definition `serverId`. */
  integrationId: z.string().min(1),
  bindingId: z.string().min(1),
  /**
   * Binding call mode. `direct_url` bindings have no endpoints and are called
   * via api.http.call direct-URL mode; a task grants them with `grantKind: 'direct_url'`.
   * Absent ≡ 'endpoint'.
   */
  callMode: ApiCallModeSchema.optional(),
  /** Endpoint IDs (API) or tool names (MCP) available on this binding. */
  toolNames: z.array(z.string().min(1)).default([]),
});
export type DesignSurfaceIntegration = z.infer<typeof DesignSurfaceIntegrationSchema>;

export const DesignSurfaceBindableSchema = z.object({
  kind: z.enum(['api', 'mcp']),
  identifier: z.string().min(1),
});
export type DesignSurfaceBindable = z.infer<typeof DesignSurfaceBindableSchema>;

export const DesignSurfaceSchema = z.object({
  integrations: z.array(DesignSurfaceIntegrationSchema).default([]),
  /**
   * Full operation IDs (matching `TaskCapabilityGrantSchema.operations` which
   * expects IDs, not prefixes). Platform-prefix filtering happens before the
   * surface is emitted.
   */
  operations: z.array(z.string().min(1)).default([]),
  /**
   * One entry per `SPACE_POLICY_OPERATION_PREFIXES` gate (`compute`, `code`,
   * …), keyed by operation prefix. A `false` entry is why that prefix's
   * operations are absent from `operations` above — the operator enables it
   * per space, so `signal_blocked` is the only runner reaction that resolves it.
   */
  policies: z.record(z.boolean()),
  /**
   * Bindable but not bound — advisory references the operator could enable
   * later. Surface emits these only on `status: 'feasible'`.
   */
  bindableButUnbound: z.array(DesignSurfaceBindableSchema).default([]),
});
export type DesignSurface = z.infer<typeof DesignSurfaceSchema>;

// ============================================================================
// PrepareDesignSurfaceInput — operation input wrapper (§5.2)
// ============================================================================

/**
 * Input shape for the `skill.compose.prepare_surface` operation.
 *
 * The compose-skill workflow wires `inputBindings: { intent: { kind:
 * 'task_output', taskId: 'analyze-intent' } }` on this task, so the actual
 * operation payload at delegation time is `{ intent: ComposeIntent }` — not
 * a bare ComposeIntent. Catalog-level input validation must use this wrapper
 * shape; the handler enforces it via the registered `inputZod`.
 */
export const PrepareDesignSurfaceInputSchema = z.object({
  intent: ComposeIntentSchema,
});
export type PrepareDesignSurfaceInput = z.infer<typeof PrepareDesignSurfaceInputSchema>;

// ============================================================================
// PrepareDesignSurfaceOutput — three-shape discriminated union (§5.2)
// ============================================================================

export const PrepareDesignSurfaceMissingSchema = z.object({
  /**
   * `policy` — a space policy the operator toggles, never a binding;
   * `identifier` names it (`compute`, `code`, …).
   */
  kind: z.enum(['api', 'mcp', 'operation', 'policy']),
  identifier: z.string().min(1),
});
export type PrepareDesignSurfaceMissing = z.infer<typeof PrepareDesignSurfaceMissingSchema>;

export const PrepareDesignSurfaceHandoffSchema = z.object({
  /** Slug of the in-product skill that can resolve the gap, e.g. 'bind-capability'. */
  skillSlug: z.string().min(1),
  /** Pre-fill payload for the resolving skill. */
  prefill: z.record(z.unknown()),
});
export type PrepareDesignSurfaceHandoff = z.infer<typeof PrepareDesignSurfaceHandoffSchema>;

export const PrepareDesignSurfaceOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('feasible'),
    designSurface: DesignSurfaceSchema,
  }),
  z.object({
    status: z.literal('blocked'),
    /**
     * `needs_binding` — operator can resolve via bind-capability.
     * `policy_disabled` — operator must enable a space policy (e.g. compute).
     */
    reason: z.enum(['needs_binding', 'policy_disabled']),
    missing: z.array(PrepareDesignSurfaceMissingSchema).min(1),
    handoff: PrepareDesignSurfaceHandoffSchema,
  }),
  z.object({
    /**
     * No in-product skill can resolve the gap (no definition exists, no
     * policy can grant it). The user must define a new capability or change
     * the goal. Surfaced via PAUSED + signal_blocked semantics, not FAILED,
     * so the run can resume after the user resolves it (§5.2 / review pass 3).
     */
    status: z.literal('unsupported'),
    missing: z.array(PrepareDesignSurfaceMissingSchema).min(1),
  }),
]);
export type PrepareDesignSurfaceOutput = z.infer<typeof PrepareDesignSurfaceOutputSchema>;

// ============================================================================
// Provenance contract — anti-fabrication primitive (§6.5 / §11)
// ============================================================================

export const SourceEvidenceSchema = z.object({
  /** Unguessable identifier the runner references via `sourceEvidenceRef`. */
  callId: z.string().uuid(),
  /** API id or MCP server id of the call. Must match provenance.sourceId. */
  sourceId: z.string().min(1).max(128),
  /** Binding the platform actually authenticated as. */
  bindingId: z.string().min(1).max(128),
  /** Platform endpoint or MCP tool that was invoked. */
  endpointOrTool: z.string().min(1).max(128),
  /** Wall-clock when the platform completed the call. */
  executedAtMs: z.number().int().nonnegative(),
  /** Hash of the request payload — guards replay claims. Optional during 2.5a. */
  requestHash: z.string().min(1).max(128).optional(),
  /** Hash of the response payload — lets memory.store.put preserve attribution. */
  responseHash: z.string().min(1).max(128).optional(),
  /**
   * Trusted platform issuer. The runtime validator only accepts these
   * literals — a runner cannot author an evidence doc claiming to come
   * from the platform.
   */
  issuedBy: z.enum(['platform:api.http.call', 'platform:mcp.tools.call']),
  /** Run that issued the evidence — used to scope validity to the same run. */
  runId: z.string().min(1).max(128),
});
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;

export const ProvenanceSchema = z.object({}).passthrough();
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ============================================================================
// TaskGraphDraft — output of draft-task-graph (§5.3 / §6.3)
//
// Phase 4 surface — included here so the schemas package owns the full
// composition-compiler IR in one file. Not yet wired into a workflow.
// ============================================================================

const SCHEMA_TYPE_KEYS = ['type', '$ref', 'oneOf', 'anyOf', 'allOf', 'enum', 'const'] as const;

export function isUsableJsonSchema(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return SCHEMA_TYPE_KEYS.some((k) => k in value);
}

const TaskOutputProductionSchema = z.object({
  /**
   * Local name for the produced output, e.g. 'cleanedDataset'. MUST be a
   * valid identifier (`[a-zA-Z][a-zA-Z0-9_]*`) — assembled
   * `WorkflowTaskOutputPortSchema.key` enforces the same regex, and
   * downstream binding paths (`tasks.<taskId>.output.<key>`) use dot
   * notation that breaks on kebab-case. Use camelCase or snake_case;
   * kebab-case is rejected.
   */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      'Must be a valid identifier (camelCase or snake_case; no hyphens)',
    )
    .describe(
      'Local name for the produced output (referenced by downstream consumes[].outputKey). camelCase or snake_case identifier — no hyphens.',
    ),
  shape: z
    .record(z.unknown())
    .refine(isUsableJsonSchema, {
      message:
        'shape must be a usable JSON Schema fragment — include at least one of: type, $ref, oneOf, anyOf, allOf, enum, const',
    })
    .optional()
    .describe(
      "JSON Schema fragment describing this output's shape. Compiled into both the producer's outputContract.schema and the consumer's inputContract. Optional ONLY when this port feeds an operation task's input (the platform derives it from the consumer op); otherwise required and must be a real, usable schema.",
    ),
  semantics: z
    .enum(['data', 'artifact', 'metric', 'status'])
    .default('data')
    .describe('What kind of value this output is.'),
  providesPurposeId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Match a purposeId from intent.requiredDataSources[*].purposeId. ' +
        'Set on EXACTLY ONE task (the source-of-truth fetcher) per requiredDataSources entry — that task must also carry the matching api/mcp capability grant on context.capabilities. ' +
        'Consumer/derived/writeback tasks MUST omit this field — provenance propagates through consumes[] automatically. ' +
        'Multiple labels per purposeId, label without matching grant, or missing label for a required entry are all rejected at assembly.',
    ),
});

/** Cross-task dataflow consume — reads an upstream task's produced port. */
const TaskOutputConsumptionSchema = z.object({
  /** Upstream task to read from. */
  taskId: z.string().min(1).max(64),
  /**
   * Must match a `produces[*].key` on that upstream task. Identifier shape
   * mirrors `produces.key` (no hyphens) so the join is well-formed.
   */
  outputKey: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      'Must be a valid identifier (camelCase or snake_case; no hyphens)',
    ),
  /** Local input name this task uses for the consumed value. */
  bindAs: z.string().min(1).max(64),
});

/**
 * Campaign-field consume — binds a declared campaign-contract field as a task
 * input. Lowered to a `campaign_input` runtime binding by `assembleWorkflow`.
 * Only valid in the optimization archetype (the draft must declare
 * `optimization.campaign`); `campaignField` must name a declared field.
 */
const CampaignFieldConsumptionSchema = z.object({
  /** Campaign-contract field key (matches `optimization.campaign.fields.<key>`). */
  campaignField: z
    .string()
    .min(1)
    .max(64)
    .regex(CAMPAIGN_FIELD_KEY_RE, 'Must be a campaign field key (identifier; no hyphens)'),
  /** Local input name this task uses for the campaign value. */
  bindAs: z.string().min(1).max(64),
});

const TaskInputConsumptionSchema = z.union([
  TaskOutputConsumptionSchema,
  CampaignFieldConsumptionSchema,
]);
type TaskInputConsumption = z.infer<typeof TaskInputConsumptionSchema>;

/** Narrow a consume to the campaign-field variant. */
export function isCampaignFieldConsume(
  c: TaskInputConsumption,
): c is z.infer<typeof CampaignFieldConsumptionSchema> {
  return 'campaignField' in c;
}

const TaskCapabilityRefSchema = z.object({
  integrations: z
    .array(
      z.object({
        sourceKind: z.enum(['api', 'mcp']),
        /** API definition `apiId` or MCP server definition `serverId`. */
        integrationId: z.string().min(1),
        bindingId: z.string().min(1),
        /**
         * How this binding is called. `direct_url` (against a direct_url binding)
         * carries NO toolNames and is invoked via api.http.call direct-URL mode.
         * Absent ≡ 'endpoint_tools'.
         */
        grantKind: CapabilityGrantKindSchema.optional(),
        /** Subset of DesignSurface.integrations[*].toolNames for this binding. */
        toolNames: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
  operations: z.array(z.string().min(1)).default([]),
});

/**
 * Agent task kind — the role this task plays in the workflow.
 *
 * Kind is the unit of authoring discipline. compose-skill's draft-task-graph
 * picks a kind per agent task; the kind determines (a) the legal capability
 * grants for that task, and (b) the runner's disposition (execute mode vs
 * exploration mode). Each kind is a small canonical contract — over time
 * these become preset profiles with defaulted tool sets, but the field is
 * the load-bearing identifier.
 *
 * - `fetcher` — fetches real data from a named external source (api/mcp).
 *   MUST grant at least one api/mcp endpoint/tool. MUST NOT grant
 *   compute.sandbox.exec (no escape hatch to fabricate). Typically labels
 *   exactly one produces[*] entry with `providesPurposeId`.
 *
 * - `transformer` — derives output from upstream data via consumes[].
 *   MAY grant compute.sandbox.exec for in-sandbox computation. MUST NOT
 *   grant api/mcp endpoints (transformers don't fetch real-source data;
 *   if the workflow needs additional source data, that's a separate
 *   fetcher task).
 *
 * - `writeback` — submits, posts, or otherwise mutates an external system
 *   via api/mcp. MUST grant at least one api/mcp endpoint/tool. MUST NOT
 *   label `providesPurposeId` (writebacks don't produce real-source
 *   data — they consume derived output and send it elsewhere). MUST NOT
 *   grant compute.sandbox.exec.
 *
 * - `judge` — evaluates, scores, or validates upstream output via an LLM
 *   judge or deterministic checks. Typically grants ai.* operations or
 *   compute. Does not grant api/mcp.
 *
 * - `researcher` — exploration mode. The runner reads `kind: 'researcher'`
 *   as explicit opt-in to investigation, novel approaches, and broader
 *   tool use. Use sparingly; most tasks are NOT researchers. The default
 *   runner disposition (execute-or-flag) is intentionally tight.
 *
 * The structural constraints are enforced by per-kind `superRefine`s on
 * `TaskGraphDraftSchema`. Soft constraints (e.g., "judges typically need ai")
 * are guidance only, not enforced.
 */
export const AgentTaskKindSchema = z.enum([
  'fetcher',
  'transformer',
  'writeback',
  'judge',
  'researcher',
]);
export type AgentTaskKind = z.infer<typeof AgentTaskKindSchema>;

const AgentTaskSchema = z.object({
  type: z.literal('agent'),
  taskId: z.string().min(1).max(64),
  /**
   * The role this task plays in the workflow. Determines legal capability
   * grants and runner disposition. See `AgentTaskKindSchema` for the
   * canonical list and per-kind contracts.
   */
  kind: AgentTaskKindSchema,
  goal: z.string().min(1).max(4000),
  dependsOn: z.array(z.string().max(64)).default([]),
  when: z.string().max(500).optional(),
  produces: z.array(TaskOutputProductionSchema).default([]),
  consumes: z.array(TaskInputConsumptionSchema).default([]),
  context: z
    .object({
      capabilities: TaskCapabilityRefSchema.default({
        integrations: [],
        operations: [],
      }),
    })
    .default({
      capabilities: { integrations: [], operations: [] },
    }),
});

const OperationTaskSchema = z.object({
  type: z.literal('operation'),
  taskId: z.string().min(1).max(64),
  /** Required: which platform operation runs at this step. */
  operationId: z.string().min(1).max(120),
  /** Op input-spec, may reference state. */
  inputBindings: z.record(z.unknown()).default({}),
  inputTemplate: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional nested op-input template. Literal JSON where any node may be { "$bind": "<name>" } referencing a consumes[].bindAs or a literal inputBindings key. When present, the substituted template is exactly the op input. Use only when the operation requires a nested input shape.',
    ),
  dependsOn: z.array(z.string().max(64)).default([]),
  when: z.string().max(500).optional(),
  produces: z.array(TaskOutputProductionSchema).default([]),
  consumes: z.array(TaskInputConsumptionSchema).default([]),
  /**
   * Async-completion poll policy (Plan 194). The harness re-runs this op until
   * `poll.until` holds (against the RAW op output) or `maxCycles` is exhausted.
   * Use for leaderboard/job/status endpoints that settle over time.
   */
  poll: WorkflowTaskPollSchema.optional(),
  /**
   * Terminal-only output projection (Plan 194). Projects fields from the RAW op
   * response into the task output (e.g. a scored metric out of an API body).
   * When set, the projected object — not the raw response — is the task output;
   * declare a matching `produces[].shape`.
   */
  outputProjection: WorkflowTaskOutputProjectionSchema.optional(),
  /**
   * Retry safety for deliberate `re_execute` (Plan 149/202). `safe` =
   * idempotent (auto-retryable). `unsafe`/`unknown` = side effects may have
   * occurred; retry requires operator confirmation. Author `unsafe` on
   * quota-consuming / irreversible ops (submit, post, trade).
   */
  retryability: z.enum(['safe', 'unsafe', 'unknown']).optional(),
  /** Max attempts before the task is terminal-failed (default 1 at runtime). */
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const HumanTaskSchema = z.object({
  type: z.literal('human'),
  taskId: z.string().min(1).max(64),
  /** Prompt shown to the human when the task pauses. */
  pauseInstruction: z.string().min(1).max(PAUSE_INSTRUCTION_MAX_CHARS),
  intent: z.enum(['collect', 'approve']).default('collect'),
  /**
   * TaskIds whose output this approval gate is reviewing. The assembler
   * folds these into dependsOn so the approval fires only after the named
   * tasks complete — no explicit dependsOn needed for data-flow ordering.
   * Use on intent: 'approve' tasks to name what is being reviewed (e.g.
   * the task that trained the model being submitted).
   */
  approves: z.array(z.string().max(64)).default([]),
  context: z
    .object({
      actionPreview: z
        .object({
          op: z.string(),
          input: z.unknown(),
        })
        .optional(),
    })
    .optional(),
  failureMode: z.enum(['isolate', 'cancel_siblings']).default('isolate'),
  dependsOn: z.array(z.string().max(64)).default([]),
  when: z.string().max(500).optional(),
  produces: z.array(TaskOutputProductionSchema).default([]),
});

export const TaskGraphDraftTaskSchema = z.discriminatedUnion('type', [
  AgentTaskSchema,
  OperationTaskSchema,
  HumanTaskSchema,
]);
export type TaskGraphDraftTask = z.infer<typeof TaskGraphDraftTaskSchema>;

// ============================================================================
// Optimization archetype spec (Plan 203 §3.2)
// ============================================================================
//
// Present only on optimization-mode drafts. The Runner authors the JUDGMENT
// (which produced port is the score, the campaign field contract, the goal
// direction + target); `assembleWorkflow` DERIVES the coherence-heavy loop
// wiring from it — stateVariables, promoteOutputs, the threshold outcome,
// `output.primary`, the campaign manifest, and the numeric goal. One mis-keyed
// string can't break the loop because the keys are derived from ONE source
// (goalMetric.producedBy.outputKey), never re-typed across five fields.

/** Points at the produced port (semantics 'metric') that carries the score. */
const GoalMetricRefSchema = z
  .object({
    producedBy: z
      .object({
        /** Task that produces the score metric (the "observe" task). */
        taskId: z.string().min(1).max(64),
        /** A `produces[].key` (semantics 'metric') on that task. */
        outputKey: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Must be a valid identifier (no hyphens)'),
      })
      .strict(),
    /**
     * Whether a higher (`maximize`) or lower (`minimize`) score is better.
     * A literal, or a `$campaign` ref when direction is per-campaign config
     * (Kaggle: `{ "$campaign": "metricDirection" }`).
     */
    direction: campaignParam(SkillGoalDirectionSchema),
  })
  .strict();

export const OptimizationArchetypeSpecSchema = z
  .object({
    goalMetric: GoalMetricRefSchema,
    /**
     * Per-campaign config contract (identity vs config fields). Reused
     * verbatim as the skill `manifest.campaign` (Plan 195). Tasks bind these
     * via a `campaign_field` consume.
     */
    campaign: SkillCampaignContractSchema,
    /**
     * The goal threshold — the score that ends the campaign as goal-met.
     * A literal number, or a `$campaign` ref (Kaggle: `{ "$campaign":
     * "targetScore" }`).
     */
    target: campaignParam(z.number()),
    /** Optional override for the derived `output.guidance` (Helmsman loop hint). */
    guidance: z.string().min(1).max(500).optional(),
  })
  .strict();
export type OptimizationArchetypeSpec = z.infer<typeof OptimizationArchetypeSpecSchema>;

/**
 * Full draft-task-graph LLM output surface.
 *
 * The plan §6.3 specifies `tasks` only as the typed task-graph piece, but
 * the LLM phase has to author workflow-level naming + outcomes + activation
 * somewhere too — `assemble-workflow` is deterministic and can't author
 * those. Keeping it all in one draft schema means the runner has one
 * coherent submit_output target. `assemble-workflow` then does pure
 * structural lowering: tasks → WorkflowTask, produces/consumes →
 * inputBindings/promoteOutputs, iterationModel → mode, etc.
 */
export const TaskGraphDraftSchema = z
  .object({
    /** Skill slug — unique URL-safe identifier (mirrors WorkflowSchema.slug). */
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
      .min(3)
      .max(64),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(''),
    /**
     * Narrative skill goal — copied verbatim into the assembled workflow's
     * `goal`. Same ceiling as `ComposedWorkflowSchema.goal` (2000 chars). Aim
     * for 2-4 sentences; longer is allowed when describing iteration logic /
     * stop criteria.
     */
    goal: z.string().min(1).max(2000),
    // Optional: optimization-mode drafts must OMIT outcomes (the assembler
    // derives the threshold outcome from optimization.goalMetric); other modes
    // require ≥1. Enforced conditionally in the superRefine below — a fixed
    // `.min(1)` here would force optimization drafts to author a throwaway.
    outcomes: z.array(OutcomeSchema).max(10).default([]),
    tasks: z.array(TaskGraphDraftTaskSchema).min(1).max(20),
    /** Optional activation block — passed through assemble-workflow verbatim. */
    activation: ProcedureActivationSchema.optional(),
    /**
     * Optimization-archetype spec — present ONLY for optimization-mode skills
     * (`intent.iterationModel === 'optimization'`). When present, the assembler
     * derives the campaign loop wiring from it (Plan 203 §3.3).
     */
    optimization: OptimizationArchetypeSpecSchema.optional(),
  })
  .superRefine((draft, ctx) => {
    const opConsumedPorts = new Set<string>();
    for (const t of draft.tasks) {
      if (t.type !== 'operation' || t.inputTemplate !== undefined) continue;
      for (const c of t.consumes) {
        if (isCampaignFieldConsume(c)) continue;
        opConsumedPorts.add(`${c.taskId}::${c.outputKey}`);
      }
    }
    draft.tasks.forEach((t, ti) => {
      const produces = 'produces' in t ? t.produces : [];
      produces.forEach((p, pi) => {
        if (p.shape !== undefined) return;
        if (!opConsumedPorts.has(`${t.taskId}::${p.key}`)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', ti, 'produces', pi, 'shape'],
            message: `produces[].shape is required unless an operation task consumes this port (then it is derived from the consumer op). Port "${p.key}" on "${t.taskId}" is not op-consumed — declare its shape.`,
          });
        }
      });
    });

    // Per-kind capability constraints. The canonical contracts live on
    // AgentTaskKindSchema; this is their enforcement (folded from the former
    // JSON-Schema-only TaskGraphDraftJsonSchemaInvariants so the Zod is the
    // single authority).
    draft.tasks.forEach((t, ti) => {
      if (t.type !== 'agent') return;
      const { integrations, operations } = t.context.capabilities;
      const grantsHttpCall = operations.includes('api.http.call');
      // A direct_url grant promotes no native tool — it is callable only when the
      // task also grants `api.http.call` (the op that invokes it).
      const hasCallableGrant = integrations.some((i) =>
        i.grantKind === 'direct_url' ? grantsHttpCall : i.toolNames.length >= 1,
      );
      const grantsCompute = operations.includes('compute.sandbox.exec');
      const labelsPurpose = t.produces.some((p) => p.providesPurposeId !== undefined);
      const capsPath = ['tasks', ti, 'context', 'capabilities'];

      if (t.kind === 'fetcher' || t.kind === 'writeback') {
        if (!hasCallableGrant) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...capsPath, 'integrations'],
            message: `${t.kind} task "${t.taskId}" must grant a callable external source — an integrations[] entry with ≥1 toolName, or a direct_url grant together with "api.http.call" in operations.`,
          });
        }
        if (grantsCompute) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...capsPath, 'operations'],
            message: `${t.kind} task "${t.taskId}" must not grant "compute.sandbox.exec" — the sandbox has no network egress and cannot reach the external source. Use the api/mcp grant.`,
          });
        }
        if (t.kind === 'writeback' && labelsPurpose) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', ti, 'produces'],
            message: `writeback task "${t.taskId}" must not label produces[].providesPurposeId — writebacks send derived output, they do not produce real-source data.`,
          });
        }
      } else if (t.kind === 'transformer' || t.kind === 'judge') {
        if (integrations.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...capsPath, 'integrations'],
            message: `${t.kind} task "${t.taskId}" must not grant api/mcp integrations — it consumes upstream output. If the workflow needs more source data, add a separate fetcher task.`,
          });
        }
      } else if (t.kind === 'researcher' && labelsPurpose) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', ti, 'produces'],
          message: `researcher task "${t.taskId}" must not label produces[].providesPurposeId — only a fetcher is the source-of-truth for a requiredDataSources purposeId. Use kind: "fetcher" if this task fetches that data.`,
        });
      }
    });

    draft.tasks.forEach((t, ti) => {
      if (t.type !== 'operation' || t.inputTemplate === undefined) return;
      const declared = new Set<string>([
        ...t.consumes.map((c) => c.bindAs),
        ...Object.keys(t.inputBindings),
      ]);
      const analysis = analyzeInputTemplate(t.inputTemplate);
      for (const malformed of analysis.malformed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', ti, 'inputTemplate'],
          message: `inputTemplate node at "${malformed.path || '(root)'}" on "${t.taskId}" is malformed: ${malformed.reason}.`,
        });
      }
      for (const bind of analysis.binds) {
        if (!declared.has(bind.bindAs)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', ti, 'inputTemplate'],
            message:
              `inputTemplate "${TEMPLATE_BIND_KEY}": "${bind.bindAs}" at "${bind.path || '(root)'}" on "${t.taskId}" names no ` +
              `consumes[].bindAs or literal inputBindings key. Declared: [${[...declared].sort().join(', ') || '(none)'}].`,
          });
        }
      }
    });

    // --- Optimization-archetype draft coherence (Plan 203 §3.2/§3.4) ---------
    // The "optimization mode ⟺ spec present" check needs `intent.iterationModel`
    // and lives in assembleWorkflow / graphValidation. Here we only check that
    // the spec (and any campaign-field consume) is internally well-formed.
    const campaignFieldKeys = draft.optimization
      ? new Set(Object.keys(draft.optimization.campaign.fields))
      : null;

    // Every campaign-field consume must reference a declared campaign field —
    // and requires an optimization spec at all.
    draft.tasks.forEach((t, ti) => {
      const consumes = t.type === 'human' ? [] : t.consumes;
      consumes.forEach((c, ci) => {
        if (!isCampaignFieldConsume(c)) return;
        if (!campaignFieldKeys) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', ti, 'consumes', ci, 'campaignField'],
            message: `Task "${t.taskId}" has a campaign_field consume ("${c.campaignField}") but the draft declares no \`optimization.campaign\` — campaign consumes are only valid in the optimization archetype.`,
          });
          return;
        }
        if (!campaignFieldKeys.has(c.campaignField)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', ti, 'consumes', ci, 'campaignField'],
            message: `Task "${t.taskId}" consumes campaign field "${c.campaignField}" which is not declared in optimization.campaign.fields [${[...campaignFieldKeys].sort().join(', ') || '(none)'}].`,
          });
        }
      });
    });

    // Outcomes are mode-dependent: optimization-mode drafts must omit them
    // (the assembler derives the threshold outcome from optimization.goalMetric
    // and discards anything authored here); other modes require ≥1.
    if (draft.optimization) {
      if (draft.outcomes.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outcomes'],
          message:
            'Optimization-mode drafts must omit `outcomes` — the assembler derives the ' +
            'threshold outcome from `optimization.goalMetric`. Remove the outcomes array.',
        });
      }
    } else if (draft.outcomes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomes'],
        message:
          'A non-optimization skill needs at least one outcome describing success, e.g. ' +
          "{ id, name, evaluator: { type: 'manual', instruction: '...' } }.",
      });
    }

    // goalMetric.producedBy must reference a real produced port with
    // semantics 'metric' — the score the loop optimizes.
    if (draft.optimization) {
      const { taskId: gmTaskId, outputKey: gmKey } = draft.optimization.goalMetric.producedBy;
      const producer = draft.tasks.find((t) => t.taskId === gmTaskId);
      const port =
        producer && 'produces' in producer
          ? producer.produces.find((p) => p.key === gmKey)
          : undefined;
      if (!producer) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optimization', 'goalMetric', 'producedBy', 'taskId'],
          message: `optimization.goalMetric.producedBy.taskId "${gmTaskId}" names no task in the draft.`,
        });
      } else if (!port) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optimization', 'goalMetric', 'producedBy', 'outputKey'],
          message: `optimization.goalMetric.producedBy "${gmTaskId}.${gmKey}" names no produces[] port on that task. The score-producing task must declare a produces[] port with this key.`,
        });
      } else if (port.semantics !== 'metric') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optimization', 'goalMetric', 'producedBy', 'outputKey'],
          message: `optimization.goalMetric port "${gmTaskId}.${gmKey}" has semantics "${port.semantics}" — the goal-metric port must be semantics: "metric".`,
        });
      }

      // When a campaign contract is present, the goal target must be a
      // $campaign ref — a literal number bakes the bar into the skill
      // definition, making every campaign instance score against the same
      // fixed threshold (the Plan 195 §1b placeholder failure).
      const target = draft.optimization.target;
      if (!isCampaignRef(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optimization', 'target'],
          message:
            `optimization.target is a literal value (${JSON.stringify(target)}) but the skill ` +
            `has a campaign contract — the bar lives on the campaign, not baked into the skill. ` +
            `Use a $campaign reference, e.g. { "$campaign": "targetScore" }, where "targetScore" ` +
            `is a numeric field declared in optimization.campaign.fields.`,
        });
      }

      // Every identity campaign field must be consumed by at least one task
      // via a campaign_field consume, so it can distinguish campaign instances.
      const consumedCampaignFields = new Set<string>();
      draft.tasks.forEach((t) => {
        const consumes = t.type === 'human' ? [] : t.consumes;
        consumes.forEach((c) => {
          if (isCampaignFieldConsume(c)) consumedCampaignFields.add(c.campaignField);
        });
      });
      for (const [key, field] of Object.entries(draft.optimization.campaign.fields)) {
        if (field.identity === true && !consumedCampaignFields.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['optimization', 'campaign', 'fields', key],
            message:
              `Identity campaign field "${key}" is never consumed by any task. ` +
              `An identity field that nothing reads cannot distinguish instances — ` +
              `add a campaign_field consume on the task that uses it, e.g. ` +
              `consumes: [{ campaignField: "${key}", bindAs: "${key}" }].`,
          });
        }
      }
    }
  });
export type TaskGraphDraft = z.infer<typeof TaskGraphDraftSchema>;

// ============================================================================
// WorkflowAssemblyInput — input to assemble-workflow (§5.4 / §6.4)
// ============================================================================

export const WorkflowAssemblyInputSchema = z.object({
  intent: ComposeIntentSchema,
  surface: DesignSurfaceSchema,
  draft: TaskGraphDraftSchema,
});
export type WorkflowAssemblyInput = z.infer<typeof WorkflowAssemblyInputSchema>;

/**
 * Output of `skill.compose.assemble_workflow`. `workflow` + `activation` are
 * lowered onto the workflow doc; `campaign` + `goal` are the manifest-level
 * derivations for the optimization archetype (Plan 203 §3.3) that
 * `skill.compose.propose` reads onto `manifest.campaign` / `manifest.goal`.
 * Both are absent for non-optimization (process) skills.
 */
export const AssembleWorkflowOutputSchema = z.object({
  workflow: ComposedWorkflowSchema,
  activation: ProcedureActivationSchema.optional(),
  /** Derived campaign contract (optimization archetype) → `manifest.campaign`. */
  campaign: SkillCampaignContractSchema.optional(),
  /** Derived numeric goal (optimization archetype) → `manifest.goal`. */
  goal: SkillGoalSchema.optional(),
});
export type AssembleWorkflowOutput = z.infer<typeof AssembleWorkflowOutputSchema>;
