import { z } from 'zod';

import { cappedText } from '../modelOutput/cappedText.js';

import {
  CatalogEntryKindSchema,
  CatalogIdSchema,
  ListingRequirementsSchema,
} from '../store/listingCore.js';
import { TaskContextSpecSchema } from './context.js';
import {
  WorkflowOutputDeclarationSchema,
  WorkflowStateVariableSchema,
  WorkflowTaskSchema,
  assertAuthoredTask,
  type AuthoredTaskLike,
} from '../operations/workflow.js';
import { GoldenCaseContentSchema } from '../eval/goldenCase.js';
import { StagedChangeKindSchema, type StagedChangeKind } from './directives.js';
import { SkillGoalSchema, CampaignContractFieldSchema } from './skill.js';
import { SkillDiagnosticSchema, SkillValiditySchema } from './skillValidity.js';
import { ReflectionFieldSchema } from './runnerReflection.js';

export {
  ComposedManifestSchema,
  ComposedWorkflowSchema,
  SkillComposeBundleSchema,
} from './stagedChangeSkillCompose.js';
export type {
  ComposedManifest,
  ComposedWorkflow,
  SkillComposeBundle,
} from './stagedChangeSkillCompose.js';

import { SkillComposeBundleSchema } from './stagedChangeSkillCompose.js';

// Re-export for convenience
export { StagedChangeKindSchema };
export type { StagedChangeKind };

// ============================================================================
// Staged Change Status
// ============================================================================

/** Lifecycle status of a staged change proposal. */
export const StagedChangeStatusSchema = z.enum([
  'proposed', // Learner has proposed, awaiting ratification
  'auto_applied', // Applied automatically (graduated authority: auto-apply tier)
  'ratified', // Executive or operator accepted
  'rejected', // Executive or operator rejected — teaches Coach via fingerprint suppression
  'dismissed',
  //             neutral signal, NO fingerprint suppression (Coach must keep
  //             surfacing the diagnostic until platform code is patched)
  'withdrawn', // Coach retracted its OWN still-proposed change (an
  //             approximation superseded by a platform_issue must
  //             not stand and confuse the operator). Neutral signal, NO
  //             fingerprint suppression — the Coach may re-propose properly.
  'expired', // TTL elapsed without action
]);

export type StagedChangeStatus = z.infer<typeof StagedChangeStatusSchema>;

// ============================================================================

/**
 * Where a proposal can be resolved. Distinct from `authorityLevel` — that
 * answers "how much approval does this change need?", whereas `resolutionRoute`
 * answers "who owns the mutable artifact?".
 *
 * - `tenant_ratification`: target lives in space-local memory; `proposal.ratify`
 *   may apply the ops in this space.
 * - `platform_issue`: target is a platform-owned artifact (e.g. workflows in
 *   `packages/platform-artifacts/`). The proposal is a structured diagnostic
 *   report for the platform team — it must NOT be ratified into tenant memory.
 *   Stored at `/coach/platform-issues/{id}.json` instead of `/coach/staged/`.
 */
export const StagedChangeResolutionRouteSchema = z.enum(['tenant_ratification', 'platform_issue']);

export type StagedChangeResolutionRoute = z.infer<typeof StagedChangeResolutionRouteSchema>;

// ============================================================================

/**
 * Stable reason codes for `RatificationApplyError`. The UI keys off these to
 * decide whether Retry is meaningful or whether the operator must reject.
 *
 * - `target_skill_missing`: the workflow / task / outcome the proposal targets
 *   no longer exists in the space. Retry won't change the outcome — the only
 *   recovery is to reject the proposal (or wait for the artifact to be
 *   restored).
 * - `workflow_not_found`: specific subset of `target_skill_missing` — the
 *   targeted workflow slug itself isn't in the space's catalog.
 * - `post_validation`: applied ops produced an invalid workflow / graph
 *   (schema or dependency violation). Almost always a Coach bug; rejecting is
 *   safer than retrying.
 * - `platform_artifact_read_only`: proposal targeted a platform-owned
 *   workflow but slipped past the `resolutionRoute === 'platform_issue'`
 *   gate. Should be rare; treat like `target_skill_missing`.
 * - `transient`: anything else — a retry is meaningful (e.g. upstream state
 *   could have changed since the last attempt).
 * - `unknown`: defensive escape hatch.
 */
export const RatificationApplyReasonSchema = z.enum([
  'target_skill_missing',
  'workflow_not_found',
  'post_validation',
  'platform_artifact_read_only',
  'precondition_missing',
  'transient',
  'unknown',
]);

export type RatificationApplyReason = z.infer<typeof RatificationApplyReasonSchema>;

// ============================================================================

/**
 * Authoring source for a StagedChange. Determines which validation rules
 * apply (Coach proposals require diagnosis + digest citations; other
 * sources have their own rationale shapes).
 */
export const StagedChangeSourceSchema = z.enum([
  'coach', // Authored by the Coach via learner.propose.workflow_change
  'compose_skill', // Authored by the compose-skill meta-skill (skill_compose op)
  'bind_capability', // Authored by the bind-capability skill (capability.* ops)
  'operator', // Operator-amended directive proposal (amend_directives)
  'agent_patch',
]);

export type StagedChangeSource = z.infer<typeof StagedChangeSourceSchema>;

export const IssueCategorySchema = z.enum([
  'procedure', // Wrong task decomposition, ordering, missing/redundant step
  'context_spec', // Wrong inputs, memory scope, or guidance to the Runner
  'tool_capability', // Wrong tool grants on a task, or capability needs binding
  'reasoning', // Right context+tools, but Runner reasoned poorly
  'eval_suite', // Eval missed something the run revealed, or scored noise as signal
  'platform', // Skill cannot fix this — runtime/infra/binding defect
  'environment', // External dependency failure outside the skill's control
]);

export type IssueCategory = z.infer<typeof IssueCategorySchema>;

/**
 * Derive a default `source` from `kind` for proposals that predate the
 * source field. Used by parse-time normalizers so existing in-memory docs
 * keep validating.
 */
export function inferSourceFromKind(kind: StagedChangeKind): StagedChangeSource {
  switch (kind) {
    case 'skill_compose':
      return 'compose_skill';
    case 'capability_binding':
    case 'store_install':
      return 'bind_capability';
    case 'eval_case_draft':
      return 'compose_skill';
    case 'directive_amendment':
      return 'operator';
    case 'workflow_refinement':
    case 'workflow_block':
    case 'context_strategy':
    case 'learning_merge':
    case 'pattern_flag':
    case 'eval_criterion_change':
    case 'platform_issue':
    case 'artifact_update':
      return 'coach';
  }
}

// ============================================================================
// Typed Change Operations (discriminated union)
// ============================================================================

/** Update a task's goal description. */
const UpdateTaskGoalOpSchema = z
  .object({
    op: z.literal('update_task_goal'),
    taskId: z.string(),
    newGoal: z.string().max(4000),
  })
  .strict();

/** Update a task's context specification. */
const UpdateTaskContextSpecOpSchema = z
  .object({
    op: z.literal('update_task_context_spec'),
    taskId: z.string(),
    contextSpec: TaskContextSpecSchema,
  })
  .strict();

const AddTaskOpSchema = z
  .object({
    op: z.literal('add_task'),
    task: WorkflowTaskSchema,
    /**
     * Explicit acknowledgement that this op introduces a new source task —
     * one with no `dependsOn`. Required for source-task creation; absent
     * for any task that depends on existing tasks.
     */
    source: z.boolean().optional(),
  })
  .strict();

const ReplaceTaskOpSchema = z
  .object({
    op: z.literal('replace_task'),
    taskId: z.string(),
    task: WorkflowTaskSchema,
  })
  .strict();

/** Remove a task from the workflow. */
const RemoveTaskOpSchema = z
  .object({
    op: z.literal('remove_task'),
    taskId: z.string(),
  })
  .strict();

const ReorderTasksOpSchema = z
  .object({
    op: z.literal('reorder_tasks'),
    taskIds: z.array(z.string()),
  })
  .strict();

/**
 * Update a task's dependsOn — the only mutation that changes execution
 * order. Used together with `add_task` to insert a gate between two
 * existing tasks: add the gate with `dependsOn: ['upstream']`, then
 * rewrite the downstream task's dependsOn to include the gate.
 */
const UpdateTaskDependenciesOpSchema = z
  .object({
    op: z.literal('update_task_dependencies'),
    taskId: z.string(),
    /**
     * The full new `dependsOn` list. Replaces the prior list — this is a
     * SET, not a merge. An empty array detaches the task from upstreams,
     * which requires `source: true` to acknowledge that semantics.
     */
    dependsOn: z.array(z.string()).max(20),
    /**
     * Required when `dependsOn` is empty. Acknowledges the task is being
     * promoted to a workflow source task.
     */
    source: z.boolean().optional(),
  })
  .strict();

/** Update a workflow outcome threshold. */
const UpdateOutcomeThresholdOpSchema = z
  .object({
    op: z.literal('update_outcome_threshold'),
    outcomeId: z.string(),
    newTarget: z.number(),
  })
  .strict();

/** Update the workflow's activation hint. */
const UpdateActivationHintOpSchema = z
  .object({
    op: z.literal('update_activation_hint'),
    newHint: z.string().max(500),
  })
  .strict();

/** Add a trigger pattern for workflow activation matching. */
const AddTriggerPatternOpSchema = z
  .object({
    op: z.literal('add_trigger_pattern'),
    pattern: z.string().max(200),
  })
  .strict();

/** Update the workflow's iteration policy. */
const UpdateIterationPolicyOpSchema = z
  .object({
    op: z.literal('update_iteration_policy'),
    maxConsecutiveRuns: z.number().int().min(1).max(100).optional(),
    cooldownMs: z.number().int().nonnegative().optional(),
    stopOnOutcomesMet: z.boolean().optional(),
  })
  .strict();

const UpdateWorkflowContractOpSchema = z
  .object({
    op: z.literal('update_workflow_contract'),
    stateVariables: z.array(WorkflowStateVariableSchema).max(20).optional(),
    output: WorkflowOutputDeclarationSchema.nullable().optional(),
  })
  .strict();

/** Promote a task's context assembly strategy (curated -> scoped -> static). */
const PromoteContextStrategyOpSchema = z
  .object({
    op: z.literal('promote_context_strategy'),
    taskId: z.string(),
    from: z.enum(['curated', 'scoped', 'static']),
    to: z.enum(['curated', 'scoped', 'static']),
    newSpec: TaskContextSpecSchema,
  })
  .strict();

/** Flag a recurring pattern for Executive consideration (informational). */
const FlagPatternOpSchema = z
  .object({
    op: z.literal('flag_pattern'),
    patternDescription: z.string().max(500),
    suggestedScope: z.string().max(300).optional(),
  })
  .strict();

/** Block a workflow due to repeated failures or other issues. */
const BlockWorkflowOpSchema = z
  .object({
    op: z.literal('block_workflow'),
    reason: z.string().max(500),
  })
  .strict();

/** Unblock a previously blocked workflow. */
const UnblockWorkflowOpSchema = z
  .object({
    op: z.literal('unblock_workflow'),
  })
  .strict();

// -- Eval criterion ops (104e §4.7) --

/** Propose adding a new eval criterion to a skill's eval suite. */
const EvalCriterionAddOpSchema = z
  .object({
    op: z.literal('eval.criterion.add'),
    skillSlug: z.string().max(128),
    /** The criterion to add (opaque record; validated at apply time). */
    criterion: z.record(z.string(), z.unknown()),
    /** Placement scope for the new criterion. */
    targetScope: z.enum(['goal', 'trajectory', 'task']).default('goal'),
    /** Required when targetScope='task'. */
    taskId: z.string().max(128).optional(),
    rationale: z.string().max(1000),
    /** Required when the skill is at maxEvalCriteriaPerSkill — retire this one atomically. */
    replacedCriterionId: z.string().max(200).optional(),
  })
  .strict();

/** Propose removing an eval criterion from a skill's eval suite. */
const EvalCriterionRemoveOpSchema = z
  .object({
    op: z.literal('eval.criterion.remove'),
    skillSlug: z.string().max(128),
    criterionId: z.string().max(200),
    rationale: z.string().max(1000),
  })
  .strict();

/** Propose updating an eval criterion (rubric refinement, weight, threshold). */
const EvalCriterionUpdateOpSchema = z
  .object({
    op: z.literal('eval.criterion.update'),
    skillSlug: z.string().max(128),
    criterionId: z.string().max(200),
    /** Partial patch — merged into the existing criterion at apply time. */
    patch: z.record(z.string(), z.unknown()),
    rationale: z.string().max(1000),
  })
  .strict();

/** Coach flags a concern outside the skill's control (§4.7). */
const PlatformIssueOpSchema = z
  .object({
    op: z.literal('platform_issue'),
    subjectKind: z.enum(['skill', 'runtime', 'evalRunner', 'budget', 'other']),
    subjectId: z.string().max(256).optional(),
    summary: z.string().max(1000),
  })
  .strict();

/**
 * Aggregation cap for `StagedChange.occurrences` — one platform incident
 * accumulates at most this many run citations; older citations roll off
 * (the founding evidence stays on the doc's `evidence` block).
 */
export const PLATFORM_ISSUE_OCCURRENCE_CAP = 20;

/**
 * One observed occurrence of a platform issue (aggregation-on-propose).
 * When a Coach review re-raises an OPEN (`proposed`) platform_issue for the
 * same structural subject, the propose handler appends a citation here
 * instead of minting a second overlapping document.
 */
export const PlatformIssueOccurrenceSchema = z
  .object({
    /** The workflow run the Coach reviewed when raising this occurrence. */
    runId: z.string().optional(),
    observedAt: z.string().datetime(),
    /** One-line gloss of what this occurrence observed. */
    summary: z.string().max(1000),
  })
  .strict();
export type PlatformIssueOccurrence = z.infer<typeof PlatformIssueOccurrenceSchema>;

const AmendDirectivesOpSchema = z
  .object({
    op: z.literal('amend_directives'),
    /** Dotted paths within EntityDirectives that differ from the current state. */
    changedPaths: z.array(z.string().min(1).max(200)).min(1).max(40),
    /**
     * Proposed full directives payload. Stored as an opaque record rather
     * than `EntityDirectivesSchema` to avoid circular imports; callers
     * re-parse with `EntityDirectivesSchema.safeParse()` at apply time.
     */
    proposedDirectives: z.record(z.string(), z.unknown()),
    /**
     * Snapshot of the current directives at propose time. Stored so the
     * Theater can render a faithful diff even if the live directives
     * change between propose and approval (concurrent amendments).
     */
    priorDirectives: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

// ============================================================================
// 104f — Skill Compose Bundle (atomic skill creation)
// ============================================================================

/** Skill compose op — atomic bundled skill creation (104f). */
const SkillComposeOpSchema = z
  .object({
    op: z.literal('skill_compose'),
    bundle: SkillComposeBundleSchema,
    /** Which skill produced this bundle (e.g. 'compose-skill'). */
    authoredBySkillId: z.string().min(1).max(128),
  })
  .strict();

// ============================================================================
// 301 — a drafted golden case
// ============================================================================

/**
 * One case an authoring skill drafted, for an operator to ratify.
 *
 * The payload is the case CONTENT and nothing else. Every rule about whether
 * the case is any good — that its checks can fail, that its claims name
 * declared requirements, that its reference is satisfiable — already lives in
 * `validateGoldenCase` on the write path, so ratification runs the same
 * gate an operator writing by hand would meet. A skill cannot write here
 * directly: `eval.*` is the measurement plane and the subject does not see the
 * ruler, which is why this arrives as a proposal at all.
 */
const EvalCaseDraftOpSchema = z
  .object({
    op: z.literal('eval_case_draft'),
    /** The skill this case measures. */
    workflowSlug: z.string().min(1).max(128),
    content: GoldenCaseContentSchema,
    /** Which skill produced it (e.g. 'eval-suite-design'). */
    authoredBySkillId: z.string().min(1).max(128),
  })
  .strict();

// ============================================================================
// 104g — Capability Binding (external API definition)
// ============================================================================

/**
 * Suggested egress policy fields a bind-capability draft can author. Mirrors
 * the existing `SuggestedEgressPolicySchema` (`packages/schemas/src/models/
 * apiDefinition.ts`) but redeclared here to keep the cybernetic IR self-
 * contained and to give the bind-capability runner a tighter set of authoring
 * fields. Used at apply time to:
 *   - On NEW api_definitions rows: stamped onto `definition_json` so future
 *     binding creations inherit the hints.
 *   - On EXISTING api_bindings rows: merged into the binding's
 *     `egress_policy_json` so the bind-capability skill can fix
 *     "redirect to disallowed host" type issues without operator-UI access.
 */
const SuggestedEgressPolicyDraftSchema = z
  .object({
    /**
     * Allow HTTP redirects to a different host (e.g., Kaggle API redirects to
     * `storage.googleapis.com` for file downloads). Default: false. Set to
     * true ONLY when the API genuinely uses cross-host redirects and the
     * receiving host is in `additionalHosts`.
     */
    allowCrossHostRedirects: z.boolean().optional(),
    /**
     * Hosts to allow beyond the API's `baseUrl` host (e.g.,
     * `["storage.googleapis.com"]` for Kaggle). The binding's
     * `allowedHosts` becomes the union of `[baseUrl host] ∪ additionalHosts`.
     */
    additionalHosts: z.array(z.string().min(1).max(256)).max(20).optional(),
    /**
     * HTTP methods needed beyond the default `['GET', 'POST']` (e.g.,
     * `['GET', 'POST', 'PUT']` if the API uses signed upload URLs).
     */
    allowedMethods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']))
      .optional(),
    /**
     * Suggested minimum for `maxResponseBodyBytes` (e.g., 100 MB for
     * file-download APIs). The applied binding's value uses
     * `max(existing, this)` so we never shrink a tighter operator-set limit.
     */
    minResponseBodyBytes: z.number().int().positive().max(524_288_000).optional(),
    /**
     * Suggested minimum timeout in ms (e.g., 60_000 for large transfers).
     * Same `max(existing, this)` merge semantics.
     */
    minTimeoutMs: z.number().int().positive().max(300_000).optional(),
  })
  .strict();
export type SuggestedEgressPolicyDraft = z.infer<typeof SuggestedEgressPolicyDraftSchema>;

export const ApiEndpointDraftQueryParamSchema = z.object({
  /** Query-parameter name as it appears in the URL (e.g., 'symbols', 'timeframe'). */
  name: z.string().min(1).max(128),
  /** Whether the API requires this param. Omitted = optional. */
  required: z.boolean().optional(),
  /** Short human description for operator review. */
  description: z.string().max(500).optional(),
  /** Optional sample value (annotation only — see schema comment above). */
  exampleValue: z.string().max(500).optional(),
});
export type ApiEndpointDraftQueryParam = z.infer<typeof ApiEndpointDraftQueryParamSchema>;

/**
 * A draft schema must stand on its own, because nothing will resolve it later.
 *
 * The bind-capability path lowers a draft STRAIGHT into a stored definition, and
 * no spec travels with it. A pasted `{"$ref": "#/components/schemas/Order"}`
 * therefore reaches the endpoint intact, where Ajv refuses to compile it and
 * every call returns API_ENDPOINT_SCHEMA_INVALID. Rejecting it at authoring time
 * turns a runtime failure nobody can act on into a submit_output error the
 * Runner can fix on its next attempt.
 *
 * `#/$defs/...` is allowed: it points inside the schema being stored, which is
 * how a recursive shape stays self-contained.
 */
/** Whether a `#/$defs/...` JSON Pointer names something the schema carries. */
function resolvesWithin(ref: string, root: Record<string, unknown>): boolean {
  if (!ref.startsWith('#/$defs/')) return false;
  const segments = ref
    .slice(2)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || typeof current !== 'object') return false;
    const container = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(container, seg)) return false;
    current = container[seg];
  }
  return current !== undefined;
}

function unresolvableRefPaths(
  node: unknown,
  root: Record<string, unknown>,
  path: string[] = [],
): string[] {
  if (Array.isArray(node))
    return node.flatMap((item, i) => unresolvableRefPaths(item, root, [...path, String(i)]));
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const found: string[] = [];
  const ref = obj['$ref'];
  if (typeof ref === 'string') {
    // A `#/$defs/` prefix is a promise, not proof. `#/$defs/Missing` names
    // nothing and fails Ajv exactly like a pointer into a spec, so the target
    // has to BE there rather than merely be addressed — and it is a JSON
    // Pointer, so `#/$defs/Node/properties/id` is as legitimate as `#/$defs/Node`
    // and resolves segment by segment, `~1`/`~0` escapes included.
    if (!resolvesWithin(ref, root)) found.push(`${path.join('.') || '(root)'} → ${ref}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$ref') continue;
    found.push(...unresolvableRefPaths(value, root, [...path, key]));
  }
  return found;
}

export function assertSelfContainedSchema(
  schema: Record<string, unknown>,
  ctx: z.RefinementCtx,
  field: string,
): void {
  const refs = unresolvableRefPaths(schema, schema);
  if (refs.length === 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field],
    message:
      `Schema references ${refs.length === 1 ? 'a definition' : 'definitions'} it does not carry: ` +
      `${refs.slice(0, 3).join('; ')}${refs.length > 3 ? `; +${String(refs.length - 3)} more` : ''}. ` +
      'Nothing resolves these later — this draft is stored as-is, so a `$ref` into a spec ' +
      'produces an endpoint that fails every call. Inline the referenced shape, or carry it in ' +
      "the schema's own `$defs` and point at `#/$defs/<name>`.",
  });
}

export const ApiEndpointDraftBodySchema = z
  .object({
    contentType: z
      .enum(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'])
      .default('application/json'),
    /** Short operator-facing description of the request body shape. */
    description: z.string().max(500).optional(),
    /**
     * JSON Schema describing the body shape — the typed body contract. It
     * becomes the promoted tool's `body` input schema and is validated against
     * the request body at call time, so a caller can no longer guess field
     * names. Put per-field guidance in each property's `description` (the tool
     * mapper uses this schema in place of the body's prose `description`), and
     * set `additionalProperties: false` for an exact field contract.
     */
    schema: z.record(z.unknown()),
  })
  .strict()
  .superRefine((body, ctx) => {
    assertSelfContainedSchema(body.schema, ctx, 'schema');
  });
export type ApiEndpointDraftBody = z.infer<typeof ApiEndpointDraftBodySchema>;

/**
 * The success response an endpoint promises — the other half of the contract
 * `ApiEndpointDraftBodySchema` starts.
 *
 * It exists so a definition authored from a brief can be SIMULATED rather than
 * only called. A simulation with nothing authored answers by generating against
 * the endpoint's response schema, so a draft that cannot express one produces a
 * definition no world can answer: every endpoint reads `contract_missing` and
 * the mock is unrunnable until someone edits the stored definition by hand
 * (Plan 293 §5.10).
 *
 * One schema rather than a status-class map, mirroring the request side. The
 * 2xx shape is what an agent can state from a brief and what generation needs;
 * error shapes are a later, separate act of authoring.
 */
export const ApiEndpointDraftResponseSchema = z
  .object({
    /** Short operator-facing description of what a successful call returns. */
    description: z.string().max(500).optional(),
    /**
     * JSON Schema describing the success body. Put per-field guidance in each
     * property's `description` — a simulation generating an answer reads them,
     * so a well-described schema is the difference between a plausible mock and
     * a useful one.
     */
    schema: z.record(z.unknown()),
  })
  .strict()
  .superRefine((response, ctx) => {
    assertSelfContainedSchema(response.schema, ctx, 'schema');
  });
export type ApiEndpointDraftResponse = z.infer<typeof ApiEndpointDraftResponseSchema>;

/**
 * API definition draft — structural data only, no credentials.
 * Shape kept minimal for V1; expanded as API mesh matures.
 */
export const ApiDefinitionDraftSchema = z
  .object({
    /**
     * The EXISTING definition's apiId when this draft edits one (extend /
     * egress update) — copy it verbatim from api.definition.list. Omit for a
     * NEW API: the id is derived from `name`. Without it, an edit whose
     * name-slug differs from the stored id ratifies into a DUPLICATE
     * definition instead of updating the target.
     */
    apiId: z.string().min(1).max(128).optional(),
    /** Human-readable name for this API. */
    name: z.string().min(1).max(200),
    /**
     * Concrete, variable-free base URL for the API. Set EITHER this OR
     * baseUrlTemplate — never both, never neither.
     *
     * The `.regex()` rejects a raw `{placeholder}` (the founding "Invalid URI"
     * bug where `https://{domain}.atlassian.net` shipped literally). It is a
     * `.regex()` (not a `.refine()`) so `zod-to-json-schema` encodes it as a
     * JSON Schema `pattern` and the constraint rides into
     * `DRAFT_API_DEFINITION_OUTPUT_SCHEMA` — enforced at the runner's
     * `submit_output` Ajv check, not only at apply-time Zod parse. For a
     * per-tenant host, use baseUrlTemplate + variables[] instead.
     */
    baseUrl: z
      .string()
      .min(1)
      .max(2000)
      .regex(/^[^{}]*$/, {
        message:
          'baseUrl is a CONCRETE URL and must not contain a {placeholder}. For a per-tenant host (e.g. a JIRA subdomain), set baseUrlTemplate "https://{domain}.atlassian.net" and declare each placeholder in variables[].',
      })
      .optional(),
    /**
     * Base URL TEMPLATE with {name} placeholders declared in variables[]
     * (e.g. 'https://{domain}.atlassian.net'). Substituted from the binding's
     * NON-SECRET variableValues at call time. Set EITHER baseUrl OR this.
     */
    baseUrlTemplate: z.string().max(2000).optional(),
    /**
     * NON-SECRET per-tenant variables (subdomain/region/account-id) declared
     * for baseUrlTemplate. Each {name} placeholder in baseUrlTemplate MUST be
     * declared here. NEVER tokens/passwords — secrets stay in credentials.
     */
    variables: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
              message:
                'Variable name must be a valid identifier ([A-Za-z_][A-Za-z0-9_]*) so it can be referenced as {name} in baseUrlTemplate.',
            }),
          description: z.string().max(500),
          example: z.string().max(256).optional(),
          required: z.boolean().default(true),
        }),
      )
      .max(20)
      .optional(),
    /** Auth kind hint (e.g. 'bearer', 'api_key', 'oauth2', 'none'). No secrets. */
    authKind: z
      .enum(['bearer', 'api_key', 'api_key_pair', 'oauth2', 'basic', 'none'])
      .default('none'),
    /**
     * How the binding is called. 'endpoint' (default) declares endpoints[].
     * 'direct_url' is an egress-allowlist-only binding for signed/dynamic
     * cross-host URLs (api.http.call apiId + bindingId + url) — NO endpoints, and
     * authKind MUST be 'none' (auth is never applied in direct-URL mode).
     */
    callMode: z.enum(['endpoint', 'direct_url']).default('endpoint'),
    /** Endpoint summaries for operator review. */
    endpoints: z
      .array(
        z.object({
          /**
           * URL path TEMPLATE only — must NOT contain a query string (`?…`).
           * Query params are declared on `queryParams` below; the synthesizer
           * is the single source of truth for assembling them onto the URL.
           *
           * Implemented with `.regex()` (not `.refine()`) so `zod-to-json-schema`
           * encodes it as JSON Schema `pattern`. This matters because the
           * bind-capability runner's `submit_output` validates against the
           * derived JSON Schema (`DRAFT_API_DEFINITION_OUTPUT_SCHEMA`) and
           * `zod-to-json-schema` drops `.refine()` predicates. Using `.regex()`
           * means the constraint is enforced at THREE places: (1) Ajv at the
           * runner's `submit_output`, (2) Zod parse at apply time, (3) the
           * prompt instruction in §5. Defense-in-depth.
           */
          path: z
            .string()
            .min(1)
            .max(500)
            .regex(/^[^?]+$/, {
              message:
                "Endpoint path must not contain a query string ('?'). Declare query params on `queryParams[]` instead.",
            }),
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
          endpointId: z.string().min(1).max(128).optional(),
          /**
           * Short display label for the endpoint (≤256). Distinct from
           * `summary` (the longer operator-facing prose, ≤500): the synthesizer
           * maps `name → ApiEndpoint.name` and `summary → ApiEndpoint.description`.
           * When omitted, `name` falls back to a clamped `summary`.
           */
          name: z.string().min(1).max(256).optional(),
          summary: z.string().max(500).optional(),
          queryParams: z
            .array(ApiEndpointDraftQueryParamSchema)
            .max(50)
            .refine((arr) => new Set(arr.map((qp) => qp.name)).size === arr.length, {
              message: 'queryParams[].name must be unique within an endpoint.',
            })
            .optional(),
          body: ApiEndpointDraftBodySchema.optional(),
          response: ApiEndpointDraftResponseSchema.optional(),
          /**
           * Names a PLATFORM-OWNED response transform preset (e.g.
           * arxiv_atom_papers) as the endpoint's curated default — plumbing so
           * bundle-carried connector endpoints keep their normalization
           * through install. Not an authoring surface: there is no free-form
           * mapping language, and an id the executor does not recognize fails
           * the call loud (API_RESPONSE_TRANSFORM_FAILED).
           */
          responseTransformPresetId: z.string().max(128).optional(),
        }),
      )
      .max(200)
      .default([]),
    /** Optional OpenAPI spec URL for reference. */
    specUrl: z.string().max(2000).optional(),
    /**
     * Optional egress policy hints. When set on the draft, the apply handler
     * (a) stamps them into the api_definitions row's definition_json so future
     * binding creations inherit the suggestions, AND (b) **propagates them to
     * an existing `${apiId}-default` binding's egress_policy_json** — replacing
     * the legacy `ON CONFLICT DO NOTHING` no-op behavior. This is how
     * bind-capability covers egress policy edits (e.g., adding
     * `storage.googleapis.com` to `allowedHosts` to unblock a Kaggle redirect).
     * The proposal still requires operator ratification, preserving the
     * security boundary.
     */
    suggestedEgressPolicy: SuggestedEgressPolicyDraftSchema.optional(),
  })
  .superRefine((def, ctx) => {
    // Enforced at apply-time Zod parse (zod-to-json-schema drops superRefine, so
    // this is not in the runner's submit_output JSON Schema — apply is the gate).
    // The baseUrl-no-placeholder rule ALSO rides the field's `.regex()` so it
    // reaches the runner's submit_output Ajv check; here we add the relational
    // rules a single-field regex cannot express.
    const hasBaseUrl = def.baseUrl !== undefined;
    const hasTemplate = def.baseUrlTemplate !== undefined;
    if (hasBaseUrl && hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrlTemplate'],
        message:
          'Set EITHER baseUrl (a concrete variable-free URL) OR baseUrlTemplate (with declared variables[]) — not both.',
      });
    } else if (!hasBaseUrl && !hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message:
          'An API definition must set exactly one of baseUrl or baseUrlTemplate. Use baseUrl for a fixed host, or baseUrlTemplate (e.g. "https://{domain}.atlassian.net") with declared variables[] for a per-tenant host.',
      });
    }
    if (hasBaseUrl && def.variables !== undefined && def.variables.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variables'],
        message:
          'variables[] only substitute into baseUrlTemplate. A definition with a concrete baseUrl must not declare variables[] — use baseUrlTemplate instead.',
      });
    }
    if (hasTemplate) {
      const declared = new Set((def.variables ?? []).map((v) => v.name));
      const placeholders = new Set<string>();
      for (const match of def.baseUrlTemplate!.matchAll(/\{([^}]+)\}/g)) {
        if (match[1] !== undefined) placeholders.add(match[1]);
      }
      for (const placeholder of placeholders) {
        if (!declared.has(placeholder)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['variables'],
            message: `baseUrlTemplate references {${placeholder}} but it is not declared in variables[]. Add a variable named "${placeholder}" (non-secret: subdomain/region/account-id).`,
          });
        }
      }
    }
    if (def.callMode === 'direct_url') {
      if (def.endpoints.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints'],
          message:
            "A direct_url binding declares NO endpoints — it is called via api.http.call direct-URL mode (apiId + bindingId + url). Remove the endpoints or set callMode to 'endpoint'.",
        });
      }
      if (def.authKind !== 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authKind'],
          message:
            "A direct_url binding must use authKind 'none' — direct-URL mode never attaches binding credentials, so a non-none auth profile is a false expectation. Use a credential-less binding for third-party blob hosts.",
        });
      }
    } else if (def.endpoints.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints'],
        message:
          "An endpoint-mode API definition must declare at least one endpoint (or set callMode to 'direct_url').",
      });
    }
    // Anti-pattern guard: an endpoint path is a TEMPLATE relative
    // to baseUrl — never a full URL. A signed/dynamic cross-host URL the API
    // returns at runtime (e.g. a GCS upload URL) is NOT an endpoint; it belongs
    // in the skill as an api.http.call against a callMode:'direct_url' binding.
    def.endpoints.forEach((ep, i) => {
      if (ep.path.includes('://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', i, 'path'],
          message: `Endpoint path "${ep.path}" contains a full URL. Paths are relative templates under baseUrl. If this is a signed/dynamic cross-host URL the API returns at runtime, do NOT model it as an endpoint — add a callMode:'direct_url' binding and call it via api.http.call (apiId + bindingId + url).`,
        });
      }
    });
  });

export type ApiDefinitionDraft = z.infer<typeof ApiDefinitionDraftSchema>;

/**
 * What the bind-capability `draft-definition` task submits.
 *
 * The wrapper is the unit a validator sees — a registered validatorRef is handed
 * the task's whole output — so it lives beside the draft rather than being
 * restated at each use, where the two could drift apart and the validator would
 * start rejecting every valid submission.
 */
export const DraftApiDefinitionOutputSchema = z.object({
  apiDefinition: ApiDefinitionDraftSchema,
});
export type DraftApiDefinitionOutput = z.infer<typeof DraftApiDefinitionOutputSchema>;

/** Author or replace an API definition (structural only; no credentials). */
const CapabilityDefinitionUpsertOpSchema = z
  .object({
    op: z.literal('capability.definition.upsert'),
    kind: z.literal('api'), // pre-widened for future MCP: z.enum(['api', 'mcp'])
    apiId: z.string().min(1).max(128),
    definition: ApiDefinitionDraftSchema,
    rationale: z.string().max(2048),
  })
  .strict();

/** Detach a binding from the space (definition may linger). */
const CapabilityBindingRemoveOpSchema = z
  .object({
    op: z.literal('capability.binding.remove'),
    bindingId: z.string().min(1).max(128),
    rationale: z.string().max(2048),
  })
  .strict();

/**
 * Install a store listing into the space. Always operator-gated: the agent
 * proposes, ratification performs the install through the shared store-install
 * execution (which re-validates `expectedVersion` against the live catalog —
 * a listing that changed since propose fails ratification instead of
 * installing something the operator never reviewed).
 */
const StoreInstallOpSchema = z
  .object({
    op: z.literal('store_install'),
    catalogId: CatalogIdSchema,
    /** Listing version pinned at propose time; ratification fails on a mismatch. */
    expectedVersion: z.number().int().min(1),
    /**
     * Listing summary snapshot for the operator's review card (name,
     * what-you'll-need). Display-only: the install always executes from the
     * live catalog entry, never from this snapshot.
     */
    listing: z
      .object({
        name: z.string().min(1).max(200),
        kind: CatalogEntryKindSchema,
        tagline: z.string().min(1).max(300),
        requirements: ListingRequirementsSchema,
      })
      .strict(),
  })
  .strict();

const UpdateArtifactOpSchema = z
  .object({
    op: z.literal('update_artifact'),
    /** UUID of the existing published artifact whose new draft this
     *  proposal publishes. Must already exist; the apply path rejects
     *  mismatches between `draft.artifact_id` and this id (Coach
     *  attribution drift guard). */
    artifactId: z.string().uuid(),
    /** Draft id from the prior `ui.artifact.generate` call. The draft
     *  carries the new source + compiled HTML + dataSchema + validation
     *  report; the apply path promotes those onto the new version row
     *  and hard-deletes the draft (mirroring `ui.artifact.publish`). */
    draftId: z.string().uuid(),
    /** Short rationale describing what changed and why. Shown in the
     *  operator's staged-change list and the diff view. */
    diffSummary: z.string().min(1).max(2048),
    /** Optional pointer back to the run / reflection that surfaced the
     *  defect. Lets the operator audit the trigger. */
    triggeringRunId: z.string().uuid().optional(),
  })
  .strict();

// ============================================================================
// Manifest ops (Plan 217 — edit the skill's goal + campaign contract on the
// staged → preconditioned → diff → ratified path, alongside workflow/eval ops)
// ============================================================================

/** Replace the skill's goal (the whole discriminated `SkillGoal`). */
const UpdateGoalOpSchema = z
  .object({
    op: z.literal('update_goal'),
    goal: SkillGoalSchema,
    rationale: z.string().max(1000).optional(),
  })
  .strict();

/** Add a campaign-contract field. */
const CampaignFieldAddOpSchema = z
  .object({
    op: z.literal('campaign.field.add'),
    fieldKey: z.string().min(1).max(64),
    field: CampaignContractFieldSchema,
    rationale: z.string().max(1000).optional(),
  })
  .strict();

/** Replace an existing campaign-contract field (full-field, not a partial patch). */
const CampaignFieldUpdateOpSchema = z
  .object({
    op: z.literal('campaign.field.update'),
    fieldKey: z.string().min(1).max(64),
    field: CampaignContractFieldSchema,
    rationale: z.string().max(1000).optional(),
  })
  .strict();

/** Remove a campaign-contract field. Removing the last one clears the contract. */
const CampaignFieldRemoveOpSchema = z
  .object({
    op: z.literal('campaign.field.remove'),
    fieldKey: z.string().min(1).max(64),
    rationale: z.string().max(1000).optional(),
  })
  .strict();

// ============================================================================
// Discriminated Union
// ============================================================================

/**
 * Ops a Coach proposal may carry.
 *
 * This is the union the Coach's tool schema inlines, so an op that no Coach can
 * emit belongs in `StagedChangeOpSchema` below and not here — every member is
 * paid for in prompt tokens on every Coach call.
 */
const COACH_PROPOSABLE_OP_SCHEMAS = [
  // Task-level
  UpdateTaskGoalOpSchema,
  UpdateTaskContextSpecOpSchema,
  AddTaskOpSchema,
  ReplaceTaskOpSchema,
  RemoveTaskOpSchema,
  ReorderTasksOpSchema,
  UpdateTaskDependenciesOpSchema,
  // Workflow-level
  UpdateOutcomeThresholdOpSchema,
  UpdateActivationHintOpSchema,
  AddTriggerPatternOpSchema,
  UpdateIterationPolicyOpSchema,
  UpdateWorkflowContractOpSchema,
  // Context strategy
  PromoteContextStrategyOpSchema,
  // Pattern (informational)
  FlagPatternOpSchema,
  // Block/unblock
  BlockWorkflowOpSchema,
  UnblockWorkflowOpSchema,
  AmendDirectivesOpSchema,
  // Eval criterion ops (Coach-authored; 104e §4.7)
  EvalCriterionAddOpSchema,
  EvalCriterionRemoveOpSchema,
  EvalCriterionUpdateOpSchema,
  // Manifest ops (goal + campaign contract)
  UpdateGoalOpSchema,
  CampaignFieldAddOpSchema,
  CampaignFieldUpdateOpSchema,
  CampaignFieldRemoveOpSchema,
  // Platform issue (Coach-authored; 104e §4.7)
  PlatformIssueOpSchema,
  // Skill compose (104f — atomic bundled skill creation)
  SkillComposeOpSchema,
  // Capability binding (104g — external API definition)
  CapabilityDefinitionUpsertOpSchema,
  CapabilityBindingRemoveOpSchema,
  StoreInstallOpSchema,
  UpdateArtifactOpSchema,
] as const;

function assertAuthoredTaskOp(
  data: { op: string; task?: AuthoredTaskLike },
  ctx: z.RefinementCtx,
): void {
  if (data.op === 'add_task' || data.op === 'replace_task') {
    if (data.task) assertAuthoredTask(data.task, ctx, ['task']);
  }
}

/** The subset of change operations a Coach proposal may carry. */
export const CoachProposableOpSchema = z
  .discriminatedUnion('op', COACH_PROPOSABLE_OP_SCHEMAS)
  .superRefine(assertAuthoredTaskOp);

/**
 * Discriminated union of all typed change operations — everything the staged
 * change rail can store and ratify, including ops only an authoring skill
 * proposes.
 */
export const StagedChangeOpSchema = z
  .discriminatedUnion('op', [...COACH_PROPOSABLE_OP_SCHEMAS, EvalCaseDraftOpSchema])
  .superRefine(assertAuthoredTaskOp);

export type StagedChangeOp = z.infer<typeof StagedChangeOpSchema>;

// ============================================================================

export {
  TargetDescriptorSchema,
  TARGET_HASH_PRESENT_SENTINEL,
  PreconditionEntrySchema,
  RebaseStateSchema,
  PreconditionConflictSchema,
} from './stagedChangePreconditions.js';
export type {
  TargetDescriptor,
  PreconditionEntry,
  RebaseState,
  PreconditionConflict,
} from './stagedChangePreconditions.js';

import {
  PreconditionEntrySchema,
  RebaseStateSchema,
  PreconditionConflictSchema,
} from './stagedChangePreconditions.js';

// ============================================================================
// Staged Change Schema
// ============================================================================

/**
 * A staged change proposal from the Learner.
 *
 * The Learner produces typed change operations (not JSON Patch) because
 * LLM-produced JSON patches against structured schemas are brittle (wrong paths,
 * dropped required fields). Typed ops give validation + operator review UI for free.
 *
 * AUTHORITY TIER PER OP KIND:
 *
 * The key distinction: ops that modify what evals measure (outcome thresholds,
 * eval criteria, identity) CANNOT be eval-gated -- evals can't gate changes to
 * their own success criteria. These always go through staging.
 *
 * | Op                                          | Max Authority    | Gate                          |
 * |---------------------------------------------|------------------|-------------------------------|
 * | update_task_goal, update_task_context_spec   | auto_apply       | Eval + confidence + directives|
 * | promote_context_strategy                     | auto_apply       | Eval + confidence             |
 * | update_activation_hint, add_trigger_pattern  | auto_apply       | Eval + confidence             |
 * | add_task, remove_task, reorder_tasks         | auto_apply       | Eval + higher confidence      |
 * | update_iteration_policy                      | auto_apply       | Eval + confidence             |
 * | unblock_workflow                             | auto_apply       | Restores state, low risk      |
 * | update_outcome_threshold                     | stage_for_review | Evals can't gate themselves   |
 * | block_workflow                               | stage_for_review | User-impacting                |
 * | directive_amendment (kind, not op)           | require_operator | Constitutional                |
 * | flag_pattern                                 | N/A              | Informational only            |
 * | eval.criterion.add/remove/update             | require_operator | Evals can't gate themselves   |
 * | platform_issue                               | require_operator | Informational, no runtime mut |
 *
 * Operators can tighten any op to stage_for_review/require_operator via directives.
 */
export const DigestCitationSchema = z.object({
  runId: z.string(),
  taskId: z.string().optional(),
  attemptId: z.string().optional(),
  sessionId: z.string().optional(),
  stepExecutionId: z.string().optional(),
  locator: z.string().max(256).optional(),
});

export type DigestCitation = z.infer<typeof DigestCitationSchema>;

export const StagedChangeSchema = z.object({
  /** Unique identifier for this staged change. */
  id: z.string().uuid(),

  /** The kind of change being proposed. */
  kind: StagedChangeKindSchema,

  source: StagedChangeSourceSchema.optional(),

  /** Current lifecycle status. */
  status: StagedChangeStatusSchema,

  /** Target workflow slug (null for pattern_flag, directive_amendment). */
  targetWorkflowSlug: z.string().optional(),

  /** Target task ID within the workflow (null for workflow-level changes). */
  targetTaskId: z.string().optional(),

  /** The proposed change details. */
  proposal: z.object({
    /** Human-readable description of the change. */
    summary: z.string().max(500),
    /** Why the Learner proposes this change. */
    rationale: z.string().max(8000),
    /** Learner's confidence in this proposal. */
    confidence: z.enum(['low', 'medium', 'high']),
    /** Typed change operations (1-10 per proposal). */
    /**
     * What a proposal may carry. The ceiling is storage, not taste: a Coach
     * change is a handful of ops, but a drafted eval suite is one op per case
     * and `eval.case.propose` accepts twenty — a stored record narrower than
     * what its writers accept refuses whole suites for being thorough.
     */
    ops: z.array(StagedChangeOpSchema).min(1).max(50),
    validations: z
      .object({
        contract: SkillValiditySchema,
        capability: z
          .object({
            issues: z.array(z.string().max(500)).max(20).default([]),
            warnings: z.array(z.string().max(500)).max(20).default([]),
          })
          .strict(),
      })
      .strict()
      .optional(),
  }),

  /** Evidence trail supporting this proposal. */
  evidence: z.object({
    /** Session IDs that informed this proposal. */
    sourceSessionIds: z.array(z.string().uuid()),
    /** Aggregate statistics across reviewed sessions. */
    aggregate: z
      .object({
        totalSessionsReviewed: z.number().int().nonnegative(),
        matchingPattern: z.number().int().nonnegative(),
        timeWindow: z.number().int().nonnegative(),
      })
      .optional(),
    /** Arbitrary metrics supporting the proposal. */
    metrics: z.record(z.string(), z.unknown()).optional(),
    /** Reflection-origin references cited by this proposal (104e §4.1). Present when
     *  the Coach built the proposal from Runner reflection fields. */
    reflectionRefs: z
      .array(
        z.object({
          runId: z.string(),
          taskId: z.string(),
          reflectionField: ReflectionFieldSchema,
          excerpt: z.string().max(500),
        }),
      )
      .max(10)
      .optional(),
    digestRef: z.string().max(512).optional(),
    /**
     * Content-addressed sha256 of the persisted digest at proposal time.
     * Operators auditing a proposal months later verify this hash to detect
     * tampering or accidental drift.
     */
    digestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    digestCitations: z.array(DigestCitationSchema).max(20).optional(),
    diagnosis: z
      .object({
        issueCategory: IssueCategorySchema,
      })
      .optional(),
    validityDiagnostics: z.array(SkillDiagnosticSchema).max(200).optional(),
    warrant: z
      .object({
        /** What the Coach claims must change (e.g. "Task X needs declared state var Y"). */
        claim: z.string().min(1).max(500),
        /** ≤3 sentences pointing at facts + digest. */
        evidenceSummary: z.string().min(1).max(1000),
        /** Why the evidence implies the claim (e.g. "promotion to undeclared state var fails apply"). */
        warrant: z.string().min(1).max(500),
        /**
         * Whether the cause was directly observed in the run evidence
         * (`observed`) or inferred from a symptom without direct proof
         * (`inferred`). An inferred cause on a graph/goal/task edit needs a
         * `confirmation` step or it is recorded as an observation, not a change.
         */
        causeStatus: z.enum(['observed', 'inferred']),
        /** How to cheaply verify an inferred cause (a test, a try-and-revert step). */
        confirmation: z.string().min(1).max(500).optional(),
        /** What the Coach expects to happen after apply (e.g. "next run succeeds at task Z"). */
        expectedEffect: z.string().min(1).max(500),
        metric: z.string().min(1).max(128).optional(),
        evaluationWindowMs: z
          .number()
          .int()
          .min(60 * 1000)
          .optional(),
        /** Known risk of the change, when applicable. */
        risk: z.string().max(500).optional(),
        /** How to roll back if the expected effect doesn't materialize. */
        rollback: z.string().max(500).optional(),
      })
      .optional(),
    applyPreview: z
      .object({
        attempted: z.literal(true),
        result: z.literal('ok'),
        previewedAt: z.string().datetime(),
        /** Post-apply workflow revision (`pinnedRevision + 1`); `null` for eval-only proposals. */
        workflowRevisionAtPreview: z.number().int().nullable(),
      })
      .strict()
      .optional(),
    artifactRefs: z
      .array(
        z
          .object({
            targetKind: z.enum(['session', 'run', 'task']),
            targetId: z.string().min(1).max(200),
            path: z.string().min(1).max(300),
            note: cappedText(
              800,
              'A short gloss linking this slice to the proposal claim.',
            ).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  }),

  /** Authority level that applies to this change. */
  authorityLevel: z.enum(['auto_apply', 'stage_for_review', 'require_operator']),

  resolutionRoute: StagedChangeResolutionRouteSchema,

  /** When this change was proposed (ISO 8601). */
  proposedAt: z.string().datetime(),

  /** When this change was resolved (ISO 8601). */
  resolvedAt: z.string().datetime().optional(),

  /** Who resolved this change: 'coach' (auto), 'helmsman', or operator userId. */
  resolvedBy: z.string().optional(),

  /** Why the Coach withdrew this proposal (status 'withdrawn' only). */
  withdrawReason: z.string().max(2000).optional(),

  /** When this proposal expires if unresolved (ISO 8601). */
  expiresAt: z.string().datetime(),

  /** The Coach session that produced this proposal. */
  coachSessionId: z.string().uuid(),

  lastRatificationError: z
    .object({
      reason: RatificationApplyReasonSchema,
      op: z.string().max(120),
      detail: z.string().max(500),
      at: z.string().datetime(),
    })
    .optional(),

  pinnedRevision: z.number().int().nonnegative().optional(),

  preconditions: z.array(PreconditionEntrySchema).optional(),

  rebaseState: RebaseStateSchema.optional(),

  staleDetails: z
    .object({
      detectedAt: z.string().datetime(),
      conflictingOpIndices: z.array(z.number().int().nonnegative()),
      conflicts: z.array(PreconditionConflictSchema),
    })
    .strict()
    .optional(),

  occurrences: z.array(PlatformIssueOccurrenceSchema).max(PLATFORM_ISSUE_OCCURRENCE_CAP).optional(),
});

export type StagedChange = z.infer<typeof StagedChangeSchema>;

// ============================================================================

export function resolveStagedChangeSource(sc: StagedChange): StagedChangeSource {
  return sc.source ?? inferSourceFromKind(sc.kind);
}

export interface CoachProposalValidationIssue {
  field: string;
  message: string;
}

export function validateCoachAuthoredProposal(sc: StagedChange): CoachProposalValidationIssue[] {
  const issues: CoachProposalValidationIssue[] = [];
  const source = resolveStagedChangeSource(sc);
  if (source !== 'coach') return issues;

  const ev = sc.evidence;

  if (!ev.diagnosis?.issueCategory) {
    issues.push({
      field: 'evidence.diagnosis.issueCategory',
      message: 'Coach-authored proposals must include evidence.diagnosis.issueCategory.',
    });
  }
  const isStructuralRepair =
    sc.kind === 'workflow_refinement' && (ev.validityDiagnostics?.length ?? 0) > 0;
  if (!isStructuralRepair) {
    // Citations point at stable run/task/session ids read from the run (there
    // is no persisted digest); digestRef/digestSha256 are no longer required.
    if (!ev.digestCitations || ev.digestCitations.length === 0) {
      issues.push({
        field: 'evidence.digestCitations',
        message:
          'Coach-authored proposals must cite at least one stable evidence ref in evidence.digestCitations (runId, plus taskId/sessionId/stepExecutionId as applicable).',
      });
    } else if (
      !ev.digestCitations.every((c) => typeof c.runId === 'string' && c.runId.length > 0)
    ) {
      issues.push({
        field: 'evidence.digestCitations[].runId',
        message: 'Each citation must include runId.',
      });
    }
  }

  // Reject ops the Coach may not author. Capability definition/binding ops flow
  // through the bind-capability skill; flag_pattern is advisory (cross-run
  // patterns / capability gaps are observations, not per-run skill edits).
  for (const op of sc.proposal.ops) {
    if (
      op.op === 'capability.definition.upsert' ||
      op.op === 'capability.binding.remove' ||
      op.op === 'store_install'
    ) {
      issues.push({
        field: 'proposal.ops',
        message: `Coach proposals may not author '${op.op}'. Use update_task_context_spec to change task capability grants; capability definitions/bindings flow through the bind-capability skill.`,
      });
    }
    if (op.op === 'flag_pattern') {
      issues.push({
        field: 'proposal.ops',
        message:
          "Coach proposals may not author 'flag_pattern' — it is advisory, not a skill edit. Record an observation_only instead.",
      });
    }
  }

  if (kindRequiresWarrant(sc.kind) && !ev.warrant) {
    issues.push({
      field: 'evidence.warrant',
      message:
        'Coach-authored workflow / eval proposals must include evidence.warrant (claim, evidenceSummary, warrant, expectedEffect).',
    });
  }

  if (kindRequiresApplyPreview(sc.kind)) {
    if (!ev.applyPreview) {
      issues.push({
        field: 'evidence.applyPreview',
        message:
          'Coach-authored workflow / eval proposals must include evidence.applyPreview (run previewProposalApply before persistence).',
      });
    }
    // Note: `evidence.applyPreview.result` is `z.literal('ok')` on the
    // schema, so a non-`ok` value would already fail Zod parse and never
    // reach this validator. Non-ok previews surface synchronously to the
  }

  // Category-to-op coherence: eval_suite category requires eval.criterion.* ops.
  if (ev.diagnosis?.issueCategory === 'eval_suite') {
    const allEval = sc.proposal.ops.every(
      (op) =>
        op.op === 'eval.criterion.add' ||
        op.op === 'eval.criterion.remove' ||
        op.op === 'eval.criterion.update',
    );
    if (!allEval) {
      issues.push({
        field: 'evidence.diagnosis.issueCategory',
        message:
          "issueCategory='eval_suite' requires the proposal ops to be eval.criterion.* only.",
      });
    }
  }

  return issues;
}

// ============================================================================

/**
 * A graph/goal/task edit to the skill itself — the kinds where an unconfirmed
 * causal guess would durably mutate the workflow. Eval-suite, block, and
 * informational kinds are out of scope: they don't rewrite the procedure.
 */
export function kindIsWorkflowChange(kind: StagedChange['kind']): boolean {
  return kind === 'workflow_refinement' || kind === 'context_strategy';
}

/**
 * Detects the cause-status downgrade condition: a graph/goal/task edit whose
 * warrant asserts an `inferred` cause with no `confirmation` step. Such a
 * proposal must be recorded as an observation, not created as a change — an
 * unconfirmed causal guess should not durably mutate the workflow. Returns
 * `null` when the proposal passes through as a normal change (`observed`
 * cause, or `inferred` with a confirmation step, or a non-workflow-change
 * kind). The propose handler routes on this; the message is surfaced verbatim.
 */
export function detectInferredCauseDowngrade(sc: StagedChange): { message: string } | null {
  if (resolveStagedChangeSource(sc) !== 'coach') return null;
  if (!kindIsWorkflowChange(sc.kind)) return null;
  const warrant = sc.evidence.warrant;
  if (warrant?.causeStatus !== 'inferred') return null;
  if (warrant.confirmation && warrant.confirmation.trim().length > 0) return null;
  return {
    message:
      'Recorded as an observation because the cause is inferred without a confirmation step. ' +
      'An unconfirmed causal guess must not become a change proposal. ' +
      'Confirm the cause cheaply (a test, a try-and-revert step), add it as warrant.confirmation, then propose the change.',
  };
}

export function kindRequiresWarrant(kind: StagedChange['kind']): boolean {
  switch (kind) {
    case 'workflow_refinement':
    case 'eval_criterion_change':
    case 'context_strategy':
    case 'learning_merge':
      return true;
    case 'pattern_flag':
    case 'platform_issue':
    case 'workflow_block':
    case 'directive_amendment':
    case 'skill_compose':
    case 'capability_binding':
    case 'store_install':
    case 'artifact_update':
    case 'eval_case_draft':
      // A drafted case states what it requires and carries checks that must
      // survive the authoring gate. That IS its evidence; a causal warrant is
      // what a Coach-inferred change to a running skill needs, and this is not
      // one.
      return false;
    default: {
      const exhaustive: never = kind;
      void exhaustive;
      return false;
    }
  }
}

export function kindRequiresApplyPreview(kind: StagedChange['kind']): boolean {
  return kind === 'workflow_refinement' || kind === 'eval_criterion_change';
}
