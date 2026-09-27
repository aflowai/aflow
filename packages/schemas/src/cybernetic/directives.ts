import { z } from 'zod';
import { IntegrationDiscoveryAllowEntrySchema } from '../runtime/agentTurn.js';

// ============================================================================
// Staged Change Kind (owned by 102d, imported by 102c)
// ============================================================================

/**
 * Enum of change kinds that can be staged for operator review.
 * Defined here because directives reference it (alwaysRequireOperator).
 * 102c imports this enum and builds the full StagedChangeSchema on top.
 */
export const StagedChangeKindSchema = z.enum([
  'workflow_refinement',
  'workflow_block',
  'context_strategy',
  'learning_merge',
  'pattern_flag',
  'directive_amendment',
  'eval_criterion_change', // 104e §4.7: Coach-authored eval criterion add/remove/update
  'platform_issue', // 104e §4.7: Coach flags concern outside the skill's control
  'skill_compose', // 104f: atomic bundle creating a new skill
  'capability_binding', // 104g: bind/remove external API capability
  'artifact_update',
  'store_install', // install a store listing; ratification runs the install
  // 301 §5.6: a drafted golden case an operator ratifies. Distinct from
  // `eval_criterion_change`, which edits a criterion on a suite that exists —
  // this authors the case itself, and ratification runs it through the same
  // write path that refuses a case whose checks cannot fail.
  'eval_case_draft',
]);

export type StagedChangeKind = z.infer<typeof StagedChangeKindSchema>;

// ============================================================================

export const DirectiveResourceBudgetSchema = z.object({
  /** Maximum concurrent worker sessions. */
  maxConcurrentWorkers: z.number().int().positive().max(20).default(3),
});

export type DirectiveResourceBudget = z.infer<typeof DirectiveResourceBudgetSchema>;

// ============================================================================

/** Platform default when a cybernetic space has no model configured. */
export const DEFAULT_CYBERNETIC_MODEL = 'glm-pro';

/** Clerk assignment mode: resolve the curated economical model for the space default's provider. */
export const CLERK_AUTO = 'auto' as const;

/** Clerk assignment mode: run Clerk work on whatever the space default is. */
export const CLERK_SPACE_DEFAULT = 'space_default' as const;

/**
 * Per-space defaults for which LLM each cybernetic role uses.
 *
 * `default` is the recommended setting for every role. Per-role fields are
 * overrides — leave them unset unless the role benefits from a different
 * model. Resolution chain: role-specific override → `default` →
 * `DEFAULT_CYBERNETIC_MODEL`.
 *
 * Values are model aliases or ids accepted by `@aflow/ai-client`'s catalog
 * (e.g. `'glm-pro'`, `'sonnet'`, `'haiku'`, `'gpt-mini'`, `'flash'`).
 */
export const DirectiveModelDefaultsSchema = z.object({
  /** Recommended model for all roles. Used when no role-specific override is set. */
  default: z.string().min(1).max(64).default(DEFAULT_CYBERNETIC_MODEL),
  /** Override for the Helmsman (entity's chat agent). */
  helmsman: z.string().min(1).max(64).optional(),
  /** Override for the Runner (per-task workers). */
  runner: z.string().min(1).max(64).optional(),
  /** Override for the Coach (learning supervisor). */
  coach: z.string().min(1).max(64).optional(),
  /** Override for the Judge (eval grader). */
  judge: z.string().min(1).max(64).optional(),
  /**
   * The Clerk's assignment — the one role that does NOT inherit `default`.
   *
   * Clerk work is bounded background language: summarizing a conversation,
   * naming a record, synthesizing evidence it was handed. Running it on
   * whatever answers the operator's chat spends a reasoning-tier model on a
   * two-sentence summary, every time, forever. So an unset Clerk means
   * `auto` — the curated economical model for the space default's provider —
   * and `space_default` is a choice someone makes, not what inattention
   * produces.
   *
   * Stored as a mode or a durable model ref. The modes never reach the AI
   * client: `resolveClerkAssignment` is the only reader, and it returns a
   * concrete ref or nothing.
   */
  clerk: z
    .union([z.literal(CLERK_AUTO), z.literal(CLERK_SPACE_DEFAULT), z.string().min(1).max(64)])
    .optional(),
});

export type DirectiveModelDefaults = z.infer<typeof DirectiveModelDefaultsSchema>;

/**
 * Resolve the model to use for a given cybernetic role.
 * Single source of truth so callers don't re-derive the chain in 4 places.
 */
export function resolveRoleModel(
  defaults: DirectiveModelDefaults | undefined,
  role: ForegroundModelRole,
): string {
  return defaults?.[role] ?? defaults?.default ?? DEFAULT_CYBERNETIC_MODEL;
}

/**
 * The roles that answer to the space default. Clerk is absent on purpose —
 * its chain is `resolveClerkAssignment`, and a caller that reached it through
 * this one would silently promote background upkeep to the chat model.
 */
export type ForegroundModelRole = 'helmsman' | 'runner' | 'coach' | 'judge';

/** Every role an operator can assign a model to. */
export type CyberneticModelRole = ForegroundModelRole | 'clerk';

/** What a space's Clerk setting asks for, before any catalog or credential is consulted. */
export type ClerkAssignment =
  { mode: 'auto' } | { mode: 'space_default'; model: string } | { mode: 'explicit'; model: string };

/**
 * Read the Clerk assignment. Resolving `auto` to a concrete model needs the
 * catalog and the tenant's permitted set, which this package does not carry —
 * see `resolveClerkModel` in `@aflow/cybernetic-runtime`.
 */
export function resolveClerkAssignment(
  defaults: DirectiveModelDefaults | undefined,
): ClerkAssignment {
  const stored = defaults?.clerk;
  if (stored === undefined || stored === CLERK_AUTO) return { mode: 'auto' };
  if (stored === CLERK_SPACE_DEFAULT) {
    return { mode: 'space_default', model: defaults?.default ?? DEFAULT_CYBERNETIC_MODEL };
  }
  return { mode: 'explicit', model: stored };
}

// ============================================================================
// Reasoning Defaults (parallel to ModelDefaults)
//
// Per-role override of how much reasoning effort each role should use, on top
// of whatever the catalog declares for the chosen model. Resolution chain:
// per-call override → directives.reasoningDefaults.<role> →
// directives.reasoningDefaults.default → catalog model default → provider default.
// ============================================================================

/**
 * Reasoning effort level — mirrors the AI client's `ReasoningEffort` type.
 * Kept duplicated here because `@aflow/schemas` cannot import from
 * `@aflow/ai-client` (reverse dep). Values must stay in sync.
 */
export const DirectiveReasoningEffortSchema = z.enum(['off', 'low', 'medium', 'high']);
export type DirectiveReasoningEffort = z.infer<typeof DirectiveReasoningEffortSchema>;

/**
 * Per-role reasoning effort override. `'off'` requests the provider suppress
 * reasoning entirely (best-effort: Fireworks Kimi/DeepSeek/Qwen →
 * `reasoning_effort: 'none'`, else `'low'`).
 * Undefined → fall through to `default` → catalog model default.
 */
export const DirectiveReasoningDefaultsSchema = z.object({
  /** Effort applied to all roles when no role-specific override is set. */
  default: DirectiveReasoningEffortSchema.optional(),
  helmsman: DirectiveReasoningEffortSchema.optional(),
  runner: DirectiveReasoningEffortSchema.optional(),
  coach: DirectiveReasoningEffortSchema.optional(),
  judge: DirectiveReasoningEffortSchema.optional(),
  clerk: DirectiveReasoningEffortSchema.optional(),
});

export type DirectiveReasoningDefaults = z.infer<typeof DirectiveReasoningDefaultsSchema>;

/**
 * Resolve the reasoning effort for a given cybernetic role.
 * Returns `undefined` when no override is set — caller should fall through
 * to the catalog model's default.
 */
export function resolveRoleReasoning(
  defaults: DirectiveReasoningDefaults | undefined,
  role: ForegroundModelRole,
): DirectiveReasoningEffort | undefined {
  return defaults?.[role] ?? defaults?.default;
}

/**
 * The Clerk's reasoning effort. Independent of `default` for the same reason
 * its model is: inheriting a chat-tuned high effort would spend a reasoning
 * budget writing a two-sentence summary. `off` is a request — the AI client
 * clamps it to the nearest rung the chosen model actually accepts.
 */
export function resolveClerkReasoning(
  defaults: DirectiveReasoningDefaults | undefined,
): DirectiveReasoningEffort {
  return defaults?.clerk ?? 'off';
}

// ============================================================================
// Learning & Eval Policy
//
// CONFIG PHILOSOPHY: Operators think in postures, not raw numbers.
//
// Tier 1 — EXPOSED: Real operator policy choices with product-level variance.
// Tier 2 — INTERNAL DEFAULTS: Useful heuristics, not worth exposing yet.
//          Kept as constants in code, overridable only via advanced config.
// Tier 3 — NEVER EXPOSE: Pure implementation tuning (in 102c ScarcityPruningConfig).
// ============================================================================

/**
 * Tier 1 operator policy for the Learner subsystem.
 * Controls when the Learner activates, what it can auto-apply, and decay behavior.
 */
export const DirectiveLearningPolicySchema = z.object({
  /** Learner enabled at all. Master switch. */
  enabled: z.boolean().default(true),

  /**
   * Whether a finished run may auto-trigger a per-run Coach review. Gates the
   * per-run auto sources only (eval / trajectory / agent / maturity / directive
   * sampling); campaign-end synthesis, explicit invocation, and validity-repair
   * are never gated by it. Off by default — per-run review has not earned its
   * seat and is re-enabled only per named scenario (Plan 237). NOT a master
   * switch: `enabled=false` still disables everything above it.
   */
  coachAutoReviewPerRun: z.boolean().default(false),

  /** When the Learner activates for review. */
  learnerActivation: z
    .enum([
      'codified_only', // Only codified procedural runs trigger review (default, cheapest)
      'sampled', // Sample a percentage of all runs
      'always', // Every session/run triggers Learner review (expensive)
      'flagged', // Only when anomaly/failure is detected (most conservative)
    ])
    .default('codified_only'),

  /** Change kinds that always require operator approval (regardless of confidence). */
  alwaysRequireOperator: z
    .array(StagedChangeKindSchema)
    .default(['workflow_block', 'directive_amendment']),

  /** Decay mode: flag stale items for review, or auto-prune them. */
  decayMode: z.enum(['flag', 'auto_prune']).default('flag'),

  // -- 104e §4.3 / §4.7 / §4.8: Judge + Coach knobs -----------------------

  /** Max eval criteria per skill before retire-or-raise is enforced (§4.7). */
  maxEvalCriteriaPerSkill: z.number().int().min(1).max(50).default(10),

  /** Max Coach activations per skill per window across all trigger sources (§4.8). */
  maxCoachActivationsPerSkillPerWindow: z.number().int().min(1).max(100).default(10),

  /** Review cadence per maturity bucket, e.g. { bootstrapping: 1, stable: 5 } (§4.8). */
  coachMaturityCadence: z.record(z.string(), z.number().int().min(1)).default({}),

  /** Coach sampling policy — overrides learnerActivation for Coach-specific control (§4.8). */
  coachSamplingPolicy: z
    .enum(['always', 'codified_only', 'sampled', 'flagged'])
    .default('codified_only'),

  /** Score floor below which the Coach fires on eval-signal (§4.8). */
  coachScoreFloor: z.number().min(0).max(1).default(0.7),

  /** Number of initial runs in the bootstrap-review window (§4.8). */
  coachBootstrapRuns: z.number().int().min(0).max(50).default(5),

  coachTrajectoryRegressionK: z.number().min(0).default(2),
  coachTrajectoryMinRuns: z.number().int().min(2).default(6),
  coachTrajectoryRecentWindow: z.number().int().min(1).default(3),

  agentCondition: z
    .object({
      /** Step count at or above which derived complexity is `involved`. */
      involvedStepFloor: z.number().int().min(1).default(8),
      /** Step count at or above which derived complexity is `sprawling`. */
      sprawlingStepFloor: z.number().int().min(1).default(25),
      /** Failed-step fraction at or above which derived progress is `stalled`. */
      stalledFailureRatio: z.number().min(0).max(1).default(0.5),
    })
    .default({}),

  reflectionCapture: z
    .object({
      /** Max wall-clock wait (ms) for async captures to land at finalize. */
      barrierTimeoutMs: z.number().int().min(0).max(60_000).default(5_000),
      /** Poll interval (ms) while waiting on the completeness marker. */
      barrierPollMs: z.number().int().min(10).max(5_000).default(200),
    })
    .default({}),

  /** Retention window (ms) for rejected proposal fingerprints (§4.2). */
  rejectedFingerprintWindow: z
    .number()
    .int()
    .min(0)
    .default(7 * 24 * 60 * 60 * 1000), // 7 days

  /** How many recent ratified/rejected events to load into Coach prompt (§4.2). */
  coachFeedbackHistorySize: z.number().int().min(0).max(50).default(10),

  /** Max user feedback entries to load into Coach prompt per skill (§4.5). */
  userFeedbackPromptWindow: z.number().int().min(0).max(100).default(20),

  // -- 104e §4.4 / §4.6: Coach-health + causal measurement knobs ------------

  /** Causal measurement window (ms) for binding ratified proposals to eval deltas (§4.6). Default: 7 days. */
  causalWindow: z
    .number()
    .int()
    .min(60 * 60 * 1000)
    .default(7 * 24 * 60 * 60 * 1000),

  appliedChangeEvidenceLimit: z.number().int().min(0).max(20).default(5),

  /**
   * Max entries in the Runner-injected active learning set (durable +
   * candidate tiers; the trajectory header is never counted). Distinct from
   * `breadthEvidence.learningsLimit`, which bounds the Coach brief evidence.
   */
  activeSetBudget: z.number().int().min(1).max(100).default(20),

  breadthEvidence: z
    .object({
      caseWindow: z.number().int().min(1).max(200).default(20),
      learningsLimit: z.number().int().min(0).max(50).default(10),
    })
    .default({}),

  evalQualityReport: z
    .object({
      alwaysPassesMinSamples: z.number().int().min(2).max(100).default(10),
    })
    .default({}),

  skillMaturityRunsThreshold: z.number().int().min(0).max(50).default(5),

  skillMaturityDerivation: z
    .object({
      /** Completed-run floor for `mastered` (with the success streak below). */
      masteredRunsFloor: z.number().int().min(1).default(10),
      /** Consecutive terminal successes required for `mastered`. */
      masteredConsecutiveSuccesses: z.number().int().min(1).default(5),
    })
    .default({}),

  coachFactsEnrichment: z
    .object({
      enabled: z.boolean().default(false),
      /** Model alias / id forwarded to `@aflow/ai-client`. */
      model: z.string().min(1).max(64).default('haiku'),
      /**
       * Per-review hard cap on enrichment cost. The handler emits a
       * static pre-flight estimate; reviews where the estimate exceeds
       * this ceiling emit `entity.coach.enrichment_suppressed` and run
       * with the deterministic facts only.
       */
      maxCostCents: z.number().min(0).max(100).default(5),
      deadlineMs: z.number().int().min(500).max(60_000).default(8_000),
    })
    .default({}),

  coachEvidenceExploration: z
    .object({
      allowedTargetKinds: z
        .array(z.enum(['session', 'run', 'task']))
        .max(3)
        .default(['run']),
      maxListCallsPerReview: z.number().int().min(1).max(20).default(3),
      maxReadCallsPerReview: z.number().int().min(1).max(50).default(8),
      maxBytesPerRead: z.number().int().min(256).max(64_000).default(8_000),
    })
    .default({}),

  /** Coach-health aggregation and drift alert settings. */
  coachHealth: z
    .object({
      /** Rolling window duration (ms) for health aggregation. Default: 7 days. */
      window: z
        .number()
        .int()
        .min(60 * 60 * 1000)
        .default(7 * 24 * 60 * 60 * 1000),
      /** Ratification rate below which the drift alert fires. */
      driftRateFloor: z.number().min(0).max(1).default(0.3),
      /** Minimum sample size before drift alert can fire. */
      driftSampleFloor: z.number().int().min(1).default(5),
      /** Mute period (ms) after operator dismisses a drift alert. Default: 24h. */
      alertMutePeriod: z
        .number()
        .int()
        .min(0)
        .default(24 * 60 * 60 * 1000),
    })
    .default({}),

  /** Fixed sampling rate for the `sampled` coachSamplingPolicy (clean runs). */
  coachSampleRate: z.number().min(0).max(1).default(0.2),

  /**
   * Judge graduation-gate knobs (Plan 269 D11 — the gate itself is INERT in
   * V1: scorecards report distance to it; nothing graduates or demotes yet).
   */
  judgeTrust: z
    .object({
      /** κ bootstrap lower bound a judge must clear. 0.6 = the Landis–Koch 'substantial agreement' floor. */
      judgeTrustKappa: z.number().min(0).max(1).default(0.6),
      /** Validation labels required before the κ gate is evaluable at all. */
      judgeTrustMinLabels: z.number().int().min(1).default(50),
    })
    .default({}),

  /**
   * Consecutive completed batches a capability-tier case must fully pass
   * (pass^k) before batch reads flag it a graduation candidate (Plan 269
   * D12). The flag informs; the tier change stays an operator case-edit.
   */
  graduationConsecutiveBatches: z.number().int().min(1).default(3),
});

export type DirectiveLearningPolicy = z.infer<typeof DirectiveLearningPolicySchema>;

// ============================================================================
// Capability discovery
// ============================================================================

/**
 * Operator-tunable scope on what the Helmsman carries and what it may discover.
 *
 * `helmsmanOperations` is an op-level allow-list over the DISCOVERABLE tier:
 * - `undefined` (default) → the platform's curated preset applies.
 * - a list (including `[]`) → that list REPLACES the preset (the operator's
 *   explicit ceiling; `[]` = discovery off).
 * Enforced op-level at `catalog.tool.search` + `catalog.tool.promote`; the
 * awareness block stays a compact rollup + search regardless of list size.
 *
 * `bundlePlacements` decides, per capability bundle, whether its tools are
 * pinned every turn (`always_on`), reachable through discovery (`on_demand`),
 * or gone (`off`). An absent entry means the bundle's authored default. This is
 * the only setting that reaches the PINNED tier, which is where the tokens are.
 * Placement moves operations between the pinned list and the discovery ceiling;
 * only `off` removes authority, so `always_on` cannot widen what an agent may
 * do. Locked bundles ignore any value stored here.
 *
 * `connections` scopes which bound integrations this agent may reach:
 * - `undefined` (default) → every enabled binding in the space.
 * - a list (including `[]`) → only these, as an explicit allowlist.
 * The space keeps the binding either way; this is per-agent reach, so a
 * connection bound for a Runner need not be handed to the Helmsman. Each entry
 * also carries a `placement`, the tier control the bundles use: an `always_on`
 * connection is pinned every turn, so it survives across conversations instead
 * of having to be re-promoted in each one.
 */
/**
 * Derived from the integration allowlist entry rather than restated: a stored
 * directive that drifted from the contract it is resolved against would fail
 * silently, narrowing an agent's reach with no error anywhere. `toolNames` is
 * dropped because per-tool scoping belongs to the binding, not to which
 * connections an agent may see.
 */
export const DirectiveConnectionRefSchema = IntegrationDiscoveryAllowEntrySchema.pick({
  sourceKind: true,
  integrationId: true,
  bindingId: true,
}).extend({
  /**
   * Mirrors `CapabilityBundlePlacement`, minus `off`: a connection's REACH is
   * already governed by the allowlist this entry belongs to — removing the
   * entry is how a connection is taken away — so placement decides only which
   * TIER a reachable connection occupies and can never widen authority.
   *
   * `always_on` therefore holds only over an entry that names a `bindingId`.
   * Pinning an integration alone would hand the agent tools whose account the
   * executor re-resolves by scope, reaching a sibling binding this list
   * excludes; an entry without one stays on demand.
   */
  placement: z.enum(['always_on', 'on_demand']).default('on_demand'),
  /**
   * Which of the connection's tools occupy the pinned tier. Omitted, all of
   * them do.
   *
   * Deliberately NOT the sibling `toolNames` this entry could have picked up
   * from `IntegrationDiscoveryAllowEntry`: that field is reach, and narrowing
   * it would take the unlisted tools away entirely. This one is tier, so a tool
   * left out stays exactly as reachable as it was — the agent finds it through
   * search and promote, the way every connection worked before pinning existed.
   *
   * It earns its place from the cap: the pinned tier is bounded, and a
   * connection can hold more tools than an operator wants to spend on it every
   * turn. Without this the only way under the ceiling is to unpin the whole
   * connection.
   */
  pinnedToolNames: z.array(z.string().min(1).max(256)).max(50).optional(),
});

export type DirectiveConnectionRef = z.infer<typeof DirectiveConnectionRefSchema>;

export const DirectiveCapabilityDiscoverySchema = z.object({
  helmsmanOperations: z.array(z.string().min(1).max(128)).max(300).optional(),
  bundlePlacements: z
    .record(z.string().min(1).max(64), z.enum(['always_on', 'on_demand', 'off']))
    .optional(),
  connections: z.array(DirectiveConnectionRefSchema).max(50).optional(),
});

export type DirectiveCapabilityDiscovery = z.infer<typeof DirectiveCapabilityDiscoverySchema>;

// ============================================================================
// Entity Directives (top-level)
// ============================================================================

/**
 * Complete governance directives for a cybernetic entity.
 * Stored as JSONB in the `spaces.directives` column.
 * Presence of directives marks a space as cybernetic.
 */
export const EntityDirectivesSchema = z.object({
  /** Version for future migrations. */
  version: z.literal(1),

  /**
   * The mandate the entity exists to fulfill — its domain, the kinds of
   * tasks it handles, the outcomes it owns. Required; anchors every
   * Helmsman turn.
   */
  responsibility: z.string().min(1).max(2000),

  /**
   * Ordered tradeoff guidance (most important first). Use sparingly —
   * surfaced in the Helmsman's attention context on every turn.
   */
  priorities: z.array(z.string().max(500)).max(5).default([]),

  /**
   * Free-form communication voice guidance for operator-facing responses.
   * Optional. Hard rules belong in Guardrail Policies, not here.
   */
  style: z.string().max(1000).optional(),

  resourceBudget: DirectiveResourceBudgetSchema.default({}),
  modelDefaults: DirectiveModelDefaultsSchema.default({}),

  /**
   * Whether conversations in this space carry a synopsis under their name.
   *
   * On unless a space turns it off. It is rewritten at every committed reply,
   * so it is current whenever anyone is reading it — which is what makes it a
   * feature rather than groundwork, and what makes declining it the deliberate
   * act rather than the default one. Names are unaffected either way.
   *
   * Read through `conversationSummariesEnabled`, never directly: spaces
   * predating this field hold no value for it, and `undefined` there means the
   * space never chose, not that it chose no.
   */
  conversationSummaries: z.boolean().default(true),
  /**
   * Per-role reasoning effort override. Layered on top of the catalog model's
   * default — set when the operator wants to dial reasoning down (cheaper) or
   * up (better at hard reasoning) for a specific role. See
   * `resolveRoleReasoning()`. Empty/undefined per-role → use the catalog default
   * for whichever model that role resolves to.
   */
  reasoningDefaults: DirectiveReasoningDefaultsSchema.default({}),
  learningPolicy: DirectiveLearningPolicySchema.default({}),
  capabilityDiscovery: DirectiveCapabilityDiscoverySchema.default({}),
});

export type EntityDirectives = z.infer<typeof EntityDirectivesSchema>;

/**
 * Whether a space summarizes its conversations.
 *
 * The one reader of the setting, so the runtime and the checkbox cannot
 * disagree about what an unset value means. Directives are stored as raw
 * JSONB and read back without a parse on the hot path, so the schema's default
 * never lands on a space that predates the field — every such space would read
 * as opted out, which is not a choice anyone made.
 */
export function conversationSummariesEnabled(
  directives: { conversationSummaries?: boolean } | null | undefined,
): boolean {
  return directives?.conversationSummaries ?? true;
}
