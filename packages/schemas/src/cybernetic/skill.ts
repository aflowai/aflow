import { z } from 'zod';
import { WorkflowModeSchema } from '../operations/workflow.js';
import { stableHash } from '../utils/stableHash.js';
import { CAMPAIGN_FIELD_KEY_RE, CAMPAIGN_GOAL_DIRECTIONS, campaignParam } from './campaignRef.js';

// ============================================================================
// Skill mode (canonical source of truth in cybernetic spaces — 104i)
// ============================================================================

/**
 * Skill mode — how runs of this capability relate to each other over time.
 *
 * - `optimization`: runs are **attempts** against one target; later runs build on earlier ones
 * - `process`: runs are **isolated cases**; they share procedure and learnings, not state
 * - `project`: runs are **episodes** over shared state toward one ongoing objective
 *
 * Reuses the same value set as `WorkflowModeSchema` for compatibility.
 * In cybernetic spaces, `SkillManifest.mode` is canonical; `Workflow.mode`
 * is the authoring/compatibility surface.
 */
export const SkillModeSchema = WorkflowModeSchema;
export type SkillMode = z.infer<typeof SkillModeSchema>;

// ============================================================================
// Skill origin
// ============================================================================

export const SkillOriginSchema = z.enum(['platform', 'operator', 'helmsman', 'cloned']);

export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

// ============================================================================
// SkillConcurrencyPolicy (104d Phase 1)
// ============================================================================

/**
 * Concurrency policy for a skill (104d §4.1).
 *
 * Controls how many tasks can run in parallel within a single run of
 * this skill, how many concurrent runs are allowed, and what happens
 * when a task fails.
 */
/**
 * The policy default, named so a reader that has no declared policy resolves
 * to the same number the schema would have applied rather than inventing one.
 */
export const SKILL_DEFAULT_MAX_CONCURRENT_RUNS = 5;

export const SkillConcurrencyPolicySchema = z.object({
  /** Max tasks scheduled in parallel within a single run of this skill.
   *  Hard upper bound 20; effective limit is layered (space budget, executor, etc.). */
  maxParallelTasksPerRun: z.number().int().min(1).max(20).default(4),

  /** Max concurrent runs of this skill in a space.
   *  'unlimited' means only the space/entity cap applies. */
  maxConcurrentRuns: z
    .union([z.number().int().min(1).max(50), z.literal('unlimited')])
    .default(SKILL_DEFAULT_MAX_CONCURRENT_RUNS),

  /** Policy when a task fails: continue independent siblings, or cancel on first fail.
   *  Phase 4: default flipped from 'cancel_siblings' to 'isolate'.
   *  Existing manifests with schemaVersion=1 use 'cancel_siblings' via backfill. */
  failureMode: z.enum(['isolate', 'cancel_siblings']).default('isolate'),

  /** Per-user serialization: if set, a second run of this skill by the same user is rejected
   *  (not queued) while an earlier run of the same skill+user is still running. */
  perUserSerial: z.boolean().default(false),
});

export type SkillConcurrencyPolicy = z.infer<typeof SkillConcurrencyPolicySchema>;

// ============================================================================

export const SkillUiOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('artifact'),
    /** Stable bundle-scoped binding identifier (§4.3.1). The runtime
     *  resolves `(spaceId, bundleId, bindingId)` to a concrete artifact UUID
     *  via the `artifact_bindings` table. Skill manifests use the short,
     *  unqualified form; bundleId is injected from the skill's install
     *  origin. */
    bindingId: z.string().min(1).max(128),
  }),
  z.object({ kind: z.literal('surface') }),
]);

export type SkillUiOutput = z.infer<typeof SkillUiOutputSchema>;

// ============================================================================

/**
 * Minimal workflow task shape the uiOutput validator needs. Matches the
 * fields on `WorkflowTaskSchema` without forcing a cross-module import
 * of the full workflow schema (avoiding circular deps with operations/).
 *
 * `inputBindings` is shape-compatible with `WorkflowTaskInputBindingSchema`
 * (any binding kind); the validator only reads the `artifact_binding`
 * variant on the terminal task to cross-check bindingId alignment
 * against the manifest's `uiOutput.bindingId` (PR #355 review fix).
 */
export interface SkillUiOutputValidationTask {
  taskId: string;
  operation?: string;
  dependsOn?: string[];
  inputBindings?: Record<string, { kind: string; bindingId?: string }> | undefined;
}

export interface SkillUiOutputValidationError {
  kind:
    | 'missing_terminal_task'
    | 'wrong_operation'
    | 'ambiguous_terminal'
    | 'missing_binding'
    | 'mismatched_binding_id';
  detail: string;
}

/**
 * Validate that a skill manifest's `uiOutput` declaration matches its
 * workflow's terminal task. Pure function: no I/O, no DB. Caller decides
 * how to report errors (throw at apply time, surface as
 * StagedChange validations, etc.).
 *
 * Returns an empty array on success; one or more errors on failure.
 *
 * Rules:
 *   - `kind: 'none'` (or absent) — always valid.
 *   - `kind: 'artifact'` — exactly one terminal task whose `operation`
 *     is `'ui.artifact.render'`.
 *   - `kind: 'surface'`  — exactly one terminal task whose `operation`
 *     is `'ui.surface.visualize'`.
 *
 * Terminal task: a task that no other task lists in its `dependsOn`.
 * Workflows with multiple terminals require manual reconciliation —
 * `compose-skill` and bundle install reject them.
 *
 * Binding-existence is OUT OF SCOPE here — that's a runtime concern
 * (`resolveArtifactBinding` returns null and the renderer surfaces the
 * config error). Bundle install checks the binding is in `artifactSeed[]`
 * separately, since that's a build-time invariant.
 */
export function validateSkillUiOutputShape(
  uiOutput: SkillUiOutput | undefined,
  tasks: readonly SkillUiOutputValidationTask[],
): SkillUiOutputValidationError[] {
  if (!uiOutput || uiOutput.kind === 'none') return [];

  const expectedOperation =
    uiOutput.kind === 'artifact' ? 'ui.artifact.render' : 'ui.surface.visualize';

  // Identify terminal tasks: any task not in some other task's dependsOn.
  const downstream = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) downstream.add(dep);
  }
  const terminals = tasks.filter((t) => !downstream.has(t.taskId));

  if (terminals.length === 0) {
    return [
      {
        kind: 'missing_terminal_task',
        detail: 'workflow has no terminal task (every task is a dependency of another)',
      },
    ];
  }
  if (terminals.length > 1) {
    return [
      {
        kind: 'ambiguous_terminal',
        detail: `uiOutput requires exactly one terminal task, found ${String(
          terminals.length,
        )}: [${terminals.map((t) => t.taskId).join(', ')}]`,
      },
    ];
  }

  const terminal = terminals[0]!;
  if (terminal.operation !== expectedOperation) {
    return [
      {
        kind: 'wrong_operation',
        detail:
          `uiOutput.kind='${uiOutput.kind}' requires terminal task '${terminal.taskId}' to ` +
          `call '${expectedOperation}', got '${terminal.operation ?? '<none>'}'`,
      },
    ];
  }

  if (uiOutput.kind === 'artifact') {
    const artifactIdBinding = terminal.inputBindings?.['artifactId'];
    if (artifactIdBinding?.kind !== 'artifact_binding') {
      return [
        {
          kind: 'missing_binding',
          detail:
            `uiOutput.kind='artifact' requires terminal task '${terminal.taskId}' to declare ` +
            `inputBindings.artifactId with kind='artifact_binding', got ` +
            `kind='${artifactIdBinding?.kind ?? '<none>'}'`,
        },
      ];
    }
    if (artifactIdBinding.bindingId !== uiOutput.bindingId) {
      return [
        {
          kind: 'mismatched_binding_id',
          detail:
            `manifest.uiOutput.bindingId='${uiOutput.bindingId}' does not match ` +
            `terminal task '${terminal.taskId}' inputBindings.artifactId.bindingId=` +
            `'${artifactIdBinding.bindingId ?? '<none>'}' — a typo here would silently ` +
            `pass install and fail at runtime in the resolver`,
        },
      ];
    }
  }

  return [];
}

// ============================================================================

export const ObjectiveCriterionSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(300),
});
export type ObjectiveCriterion = z.infer<typeof ObjectiveCriterionSchema>;

/** Direction of a numeric goal — derived from the shared campaign-slot vocabulary. */
export const SkillGoalDirectionSchema = z.enum(CAMPAIGN_GOAL_DIRECTIONS);
export type SkillGoalDirection = z.infer<typeof SkillGoalDirectionSchema>;

const objectiveGoalVariant = z.object({
  type: z.literal('objective'),
  criteria: z.array(ObjectiveCriterionSchema).min(1).max(20),
});
const subjectiveGoalVariant = z.object({
  type: z.literal('subjective'),
  // Entry ceiling is 1000 to preserve the legacy prose-goal max — a bundle
  // goal up to 1000 chars lifts to a single rubric entry without failing parse.
  rubric: z.array(z.string().min(1).max(1000)).min(1).max(20),
});

export const SkillGoalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('numeric'),
    metricKey: z.string().min(1).max(128),
    direction: campaignParam(SkillGoalDirectionSchema),
  }),
  objectiveGoalVariant,
  subjectiveGoalVariant,
]);
export type SkillGoal = z.infer<typeof SkillGoalSchema>;

export const MaterializedSkillGoalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('numeric'),
    metricKey: z.string().min(1).max(128),
    direction: SkillGoalDirectionSchema,
  }),
  objectiveGoalVariant,
  subjectiveGoalVariant,
]);
export type MaterializedSkillGoal = z.infer<typeof MaterializedSkillGoalSchema>;

// ============================================================================

export const CampaignContractFieldSchema = z
  .object({
    /** JSON Schema for the field value (e.g. `{ type: 'string', minLength: 1 }`). */
    schema: z.record(z.unknown()),
    /** Participates in campaign identity (default false). Identity fields are immutable. */
    identity: z.boolean().optional(),
    /** Operator-facing label (SchemaForm / chat collection). */
    label: z.string().min(1).max(120),
    /** Shown in SchemaForm / chat collection. */
    description: z.string().max(500).optional(),
    /**
     * May be changed mid-campaign via `workflow.campaign.update`. Defaults to
     * true for non-identity fields; identity fields are always immutable
     * (declaring `identity: true, mutable: true` is rejected).
     */
    mutable: z.boolean().optional(),
  })
  .strict();
export type CampaignContractField = z.infer<typeof CampaignContractFieldSchema>;

export const SkillCampaignContractSchema = z
  .object({
    fields: z.record(z.string().min(1).max(64), CampaignContractFieldSchema),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const entries = Object.entries(contract.fields);
    if (entries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields'],
        message:
          'campaign contract must declare at least one field — omit `campaign` entirely for config-less skills.',
      });
    }
    for (const [key, field] of entries) {
      if (!CAMPAIGN_FIELD_KEY_RE.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', key],
          message:
            `campaign field key "${key}" must match ${String(CAMPAIGN_FIELD_KEY_RE)} — ` +
            'keys are referenced from `$campaign` refs and `campaign_input` binding paths.',
        });
      }
      if (field.identity === true && field.mutable === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', key, 'mutable'],
          message:
            `campaign field "${key}" declares identity: true and mutable: true — identity fields ` +
            'are immutable for the life of a campaign (different identity values are a different ' +
            'campaign). Drop `mutable: true` or make the field non-identity.',
        });
      }
    }
  });
export type SkillCampaignContract = z.infer<typeof SkillCampaignContractSchema>;

/**
 * Effective mutability of a contract field: identity fields are never
 * mutable; non-identity fields default to mutable unless `mutable: false`.
 */
export function isCampaignFieldMutable(field: CampaignContractField): boolean {
  if (field.identity === true) return false;
  return field.mutable !== false;
}

export function extractCampaignIdentityValues(
  contract: SkillCampaignContract,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(contract.fields)) {
    if (field.identity === true && config[key] !== undefined) {
      out[key] = config[key];
    }
  }
  return out;
}

export function hashCampaignIdentity(identityValues: Record<string, unknown>): string {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(identityValues)) {
    if (value !== undefined) defined[key] = value;
  }
  return stableHash(defined).slice(0, 16);
}

export function hashCampaignContract(contract: SkillCampaignContract): string {
  return stableHash(contract.fields);
}

export function deriveGoalRef(
  skillSlug: string,
  goal: MaterializedSkillGoal,
  identityValues: Record<string, unknown>,
): string {
  const hasIdentity = Object.values(identityValues).some((v) => v !== undefined);
  const suffix = hasIdentity ? `:${hashCampaignIdentity(identityValues)}` : '';
  switch (goal.type) {
    case 'numeric':
      return `${skillSlug}:numeric:${goal.metricKey}:${goal.direction}${suffix}`;
    case 'objective':
      return `${skillSlug}:objective${suffix}`;
    case 'subjective':
      return `${skillSlug}:subjective${suffix}`;
  }
}

// ============================================================================
// SkillManifest
// ============================================================================

export const SkillManifestSchema = z.object({
  /** Schema version: 1 = Phase 1 (cancel_siblings default), 2 = Phase 4 (isolate default). */
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(2),
  skillId: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  goal: SkillGoalSchema,
  campaign: SkillCampaignContractSchema.optional(),
  /** 104i: Canonical skill mode — how runs relate to each other over time.
   *  Optional for backward compat with pre-104i manifests — read paths fall
   *  back to `workflow.mode` when absent. New manifests must always set this. */
  mode: SkillModeSchema.optional(),
  origin: SkillOriginSchema,
  workflowSlug: z.string().min(1).max(128),
  evalSuiteRef: z.string().optional(),
  activationRef: z.string().optional(),
  /** 104d Phase 1: concurrency policy for this skill. */
  concurrency: SkillConcurrencyPolicySchema.optional(),
  /**
   * 104g: capability prefixes this skill depends on (e.g., ['stripe', 'github']).
   * Derived deterministically by the platform from task `operation` + `context.tools`
   * fields, excluding unconditionally-available platform prefixes.
   * Used by SkillProjectionReconciler to compute `activationStatus`.
   */
  requiredCapabilities: z.array(z.string().min(1).max(128)).max(20).default([]),

  // --------------------------------------------------------------------------

  sourceCatalogId: z.string().min(1).max(128).optional(),
  sourceVersion: z.number().int().min(1).optional(),
  installedAt: z.string().datetime().optional(),

  uiOutput: SkillUiOutputSchema.optional(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
