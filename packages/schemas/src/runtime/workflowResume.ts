import { z } from 'zod';
import { ContractErrorSchema } from './contractError.js';
import { SubagentHandoffPayloadSchema } from './subagentHandoff.js';
import { TaskTargetedInstructionsSchema, ParentInputsRecordSchema } from './parentInstructions.js';
import {
  OAuthConsentIntegrationKindSchema,
  OAuthConsentOwnerScopeSchema,
  OAuthConsentReasonSchema,
} from './sessionBlockedOn.js';

// ============================================================================
// Pause cause enum
// ============================================================================

export const WorkflowRunPauseReasonSchema = z.enum([
  /** A grant points at a binding with empty auth_json. Resolution: acknowledge after fixing at /integrations. */
  'needs_credentials',
  /** A task explicitly requested user input. Resolution: replace_output with the decision. */
  'needs_decision',
  /** A binding/MCP server got disabled mid-run. Resolution: acknowledge after re-enabling. */
  'needs_capability',
  /**
   * Task output failed validate_output / route_result and the contract router
   * had no explicit `producer: 'fail'` rule. Resolution: replace_output (per-port
   * patch matching `replaceOutputSchema`) or re_execute (instructions to runner).
   * This is the new default for unrouted contract violations — see §4.2.
   */
  'task_contract_violation',
  /** A task hit maxProducerReruns. Resolution: author intervention + acknowledge. */
  'retry_budget_exceeded',
  /**
   * Network/AI-provider hiccup. Phase-1 scope: pause + surface (manual resume).
   * Phase 4 may add capped auto-resume, but in this milestone it's manual.
   */
  'transient_error',
  /** A sub-skill paused with a structured handoff (compose-skill style). Resolution: acknowledge. */
  'subagent_handoff',
  /**
   * A pinned-owner OAuth tool/API call has no usable token. Resolution: the
   * pinned owner completes consent (the OAuth callback); the run resumes when
   * the callback lands, not via a structured-output replacement. The typed
   * cause is carried in `oauthConsent`.
   */
  'needs_oauth_consent',
  /** Operator/Helmsman explicitly paused. Resolution: author-defined. */
  'manual',
]);
export type WorkflowRunPauseReason = z.infer<typeof WorkflowRunPauseReasonSchema>;

/**
 * Typed cause carried on a `needs_oauth_consent` run pause — the run-plane
 * mirror of the step-plane `SessionBlockedOn` member. Surfaced verbatim into
 * the "Connect {provider}" Action Center item (Stage B) and consumed by the
 * callback resume routing (Stage C). Reuses the shared `OAuthConsent*` enums.
 */
export const OAuthConsentPauseCauseSchema = z.object({
  integrationKind: OAuthConsentIntegrationKindSchema,
  /** Logical provider key — serverId (MCP) | apiId (API), NOT the binding. */
  resourceKey: z.string(),
  bindingId: z.string(),
  ownerScope: OAuthConsentOwnerScopeSchema,
  /** Where consent can be initiated for this binding (server-relative path). */
  consentUrlHint: z.string().optional(),
  /** `never_connected` = no stored token; `expired` = token unusable, no refresh. */
  reason: OAuthConsentReasonSchema,
});
export type OAuthConsentPauseCause = z.infer<typeof OAuthConsentPauseCauseSchema>;

// ============================================================================
// Resolution modes (resolve the `resolution` arg to workflow.run.resume)
// ============================================================================

const ReplaceOutputResolutionSchema = z.object({
  mode: z.literal('replace_output'),
  /**
   * Per-port patch matching the contract's `replaceOutputSchema` (a subset
   * of the task's outputContract.schema covering only failed ports).
   * Engine merges this onto the existing task output, validates the merged
   * full output against outputContract.schema, then persists the merged
   * output as the task's authoritative result. See §4.5.2 step 6.
   */
  output: z.unknown(),
});
export type ReplaceOutputResolution = z.infer<typeof ReplaceOutputResolutionSchema>;

const ReExecuteResolutionSchema = z.object({
  mode: z.literal('re_execute'),
  instructions: TaskTargetedInstructionsSchema.optional(),
  correctedInput: z.unknown().optional(),
  remediationConfirmed: z.boolean().optional(),
});
export type ReExecuteResolution = z.infer<typeof ReExecuteResolutionSchema>;

const AcknowledgeResolutionSchema = z.object({
  mode: z.literal('acknowledge'),
});
export type AcknowledgeResolution = z.infer<typeof AcknowledgeResolutionSchema>;

const ProvideInputResolutionSchema = z.object({
  mode: z.literal('provide_input'),
  /**
   * Workflow task id (NOT step execution id) whose `paused` row gets
   * re-dispatched with the new inputs. Must match a task in `paused`
   * status on the run; the commit fails otherwise.
   */
  taskId: z.string().min(1).max(64),
  /** Keyed by `bindAs`. Validated against the task's `inputContract`. */
  inputs: ParentInputsRecordSchema,
});
export type ProvideInputResolution = z.infer<typeof ProvideInputResolutionSchema>;

const FailTaskResolutionSchema = z.object({
  mode: z.literal('fail'),
  /** Human-readable rejection reason; surfaced on the task row. */
  reason: z.string().min(1).max(500),
});
export type FailTaskResolution = z.infer<typeof FailTaskResolutionSchema>;

/**
 * `reject` resolution mode — an operator's "no" on an approval gate.
 *
 * Distinct from `fail`: rejection marks the approve task and its **`when`-gated
 * descendant branch** (the conditional action the approval guards) as
 * **skipped**, NOT blocked. A skipped upstream satisfies `dependsOn`, so the
 * approve task's always-on (when-less) descendants — learning / cleanup tasks —
 * still run, with their `task_output` bindings to the skipped branch resolving
 * to ABSENT. This is "reject-but-learn": the gated action does not happen, but
 * the iteration is still recorded.
 *
 * Like an approval, reject must NOT produce a succeeded outcome a downstream op
 * could `$ref`-bind — the rejected branch never executes.
 */
const RejectTaskResolutionSchema = z.object({
  mode: z.literal('reject'),
  /** Optional operator note; surfaced on the skipped task row's decision. */
  comment: z.string().max(2000).optional(),
});
export type RejectTaskResolution = z.infer<typeof RejectTaskResolutionSchema>;

const RetryFailedTaskResolutionSchema = z.object({
  mode: z.literal('retry_failed_task'),
  /** Workflow task id of the failed task being retried. */
  taskId: z.string().min(1).max(64),
  /**
   * CAS token half 1 — must match the failed `workflow_run_tasks` row's
   * `failed_at`. ISO 8601 datetime string.
   */
  failedAt: z.string().datetime(),
  attempt: z.number().int().positive(),
  remediationNote: z.string().max(2000).optional(),
  /**
   * Asserts the operator fixed the root cause (and, for unsafe/unknown tasks,
   * verified external state), granting one in-place retry past a spent attempt
   * budget instead of forcing a fresh run. Ignored while budget remains.
   */
  remediationConfirmed: z.boolean().optional(),
});
export type RetryFailedTaskResolution = z.infer<typeof RetryFailedTaskResolutionSchema>;

export const WorkflowResumeResolutionSchema = z.discriminatedUnion('mode', [
  ReplaceOutputResolutionSchema,
  ReExecuteResolutionSchema,
  AcknowledgeResolutionSchema,
  ProvideInputResolutionSchema,
  FailTaskResolutionSchema,
  RejectTaskResolutionSchema,
  RetryFailedTaskResolutionSchema,
]);
export type WorkflowResumeResolution = z.infer<typeof WorkflowResumeResolutionSchema>;

export const ResumeResolutionModeSchema = z.enum([
  'replace_output',
  're_execute',
  'acknowledge',
  'provide_input',
  'fail',
  'reject',
  'retry_failed_task',
]);
export type ResumeResolutionMode = z.infer<typeof ResumeResolutionModeSchema>;

// ============================================================================

export const PausedTaskInputContractSchema = z.object({
  /**
   * JSON Schema of the expected resume-args inner payload (the shaped
   * value, not the full op input). For `acknowledge` and the failure-
   * event-side `retry_failed_task` slot, this is the empty object `{}`.
   */
  schema: z.record(z.unknown()),
  prompt: z.string().max(2000).optional(),
  /** Which resolution mode this contract is shaped for. */
  resolutionMode: z.enum([
    'provide_input',
    'replace_output',
    'acknowledge',
    'retry_failed_task',
    're_execute',
    'fail',
    // Operator rejection of an approval gate (skip the gated branch).
    'reject',
  ]),
});
export type PausedTaskInputContract = z.infer<typeof PausedTaskInputContractSchema>;

// ============================================================================
// Resume contract — harness payload
// ============================================================================

/**
 * JSON Schema is structurally `Record<string, unknown>` at the type level
 * (we don't bring an Ajv-aware Schema type into the universal schemas pkg).
 * Validation is performed by Ajv at runtime in the resume handler.
 */
const JSONSchemaShape = z.record(z.unknown());

export const SuggestedResumeCallSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('workflow.run.resume'),
    args: z.object({
      runId: z.string().uuid(),
      /**
       * Surfaced from the live workflow_runs row; absent in the stored
       * payload, required in the surfaced view. See §4.5.1.
       */
      pauseVersion: z.number().int().nonnegative().optional(),
      resolution: WorkflowResumeResolutionSchema,
    }),
  }),
  z.object({
    op: z.literal('agent.control.resume'),
    args: z.object({
      /** Driver session id from `workflow_runs.session_id`. */
      childSessionId: z.string(),
      /**
       * The agent fills this with the user's reply before invoking. Empty
       * in the stored contract (no user input yet at pause time).
       */
      message: z.string().optional(),
      wait: z.enum(['until_complete', 'until_pause']).optional(),
    }),
  }),
  z.object({
    op: z.literal('human.action_center.focus'),
    args: z.object({
      /**
       * Action Center item id (prefixed `proposal:` / `step:` / `gate:` /
       * `settings:`). Surface this to the operator inline; their click in
       * the rendered card resumes the workflow.
       */
      itemId: z.string(),
    }),
  }),
]);
export type SuggestedResumeCall = z.infer<typeof SuggestedResumeCallSchema>;

export const WorkflowResumeContractSchema = z
  .object({
    pauseCause: WorkflowRunPauseReasonSchema,

    /**
     * Which `workflow.run.resume` resolution modes are valid for this pause.
     * Only meaningful when `suggestedResumeCall.op === 'workflow.run.resume'`;
     * absent when the suggested op is `agent.control.resume` (HUMAN-task
     * pauses don't have a `resolution` concept — the Driver session is
     * waiting for input, not for a structured output replacement).
     */
    allowedResumeModes: z.array(ResumeResolutionModeSchema).optional(),

    /** Human-readable explanation. Always present. */
    resumePrompt: z.string().min(1),

    /**
     * JSON Schema for `resolution.output` when mode is 'replace_output'. For
     * `task_contract_violation` this is a per-port patch (Q10): properties
     * for the FAILED ports only. The resume handler merges the patch onto
     * the existing task output, then validates against the full
     * outputContract.schema.
     */
    replaceOutputSchema: JSONSchemaShape.optional(),

    /** JSON Schema for the `re_execute` resolution payload. */
    reExecuteSchema: JSONSchemaShape.optional(),

    // ── Harness fields ──────────────────────────────────────────────
    /** The task's id. Stable across retries. */
    failedTaskId: z.string().optional(),
    /** The actual output that failed validation (truncated to 16KB). */
    failedOutputPreview: z.unknown().optional(),
    /** The exact contract errors (Ajv issues) from validate_output. */
    contractErrors: z.array(ContractErrorSchema).optional(),
    /** What the resolution must produce (= the failed task's full outputContract.schema). */
    expectedTaskOutputSchema: JSONSchemaShape.optional(),
    /** What the failed task received as input (truncated to 16KB). */
    lastTaskInputPreview: z.unknown().optional(),
    /** Outputs of upstream tasks the failed task consumes. */
    upstreamOutputsPreview: z.record(z.unknown()).optional(),
    /** Number of resume attempts made on this pause already. */
    attemptCount: z.number().int().nonnegative().optional(),
    suggestedResumeCall: SuggestedResumeCallSchema.optional(),

    pausedTaskInputContract: PausedTaskInputContractSchema.optional(),

    // ── Cause-specific fields ──────────────────────────────────────
    // needs_decision:
    missingVariables: z.array(z.string()).optional(),
    decisionPrompt: z.string().optional(),
    // needs_credentials:
    blockedBindings: z
      .array(
        z.object({
          bindingId: z.string(),
          bindingName: z.string(),
          missingFields: z.array(z.string()),
        }),
      )
      .optional(),
    // needs_capability:
    disabledCapabilities: z.array(z.string()).optional(),
    /** Per disabled capability: what it means and what closes it. */
    capabilityRemedies: z
      .array(z.object({ capability: z.string(), remedy: z.string() }))
      .optional(),
    // subagent_handoff:
    handoffPayload: SubagentHandoffPayloadSchema.optional(),
    // transient_error:
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    // needs_oauth_consent:
    oauthConsent: OAuthConsentPauseCauseSchema.optional(),
  })
  .passthrough();
export type WorkflowResumeContract = z.infer<typeof WorkflowResumeContractSchema>;

// ============================================================================
// Resume CAS error codes
// ============================================================================

export const ResumeCasErrorCodeSchema = z.enum([
  /** Run isn't in 'paused' state — already resumed, cancelled, or running. */
  'RUN_NOT_PAUSED',
  /** Caller's pauseVersion mismatched the live row — they're acting on a stale snapshot. */
  'STALE_PAUSE_VERSION',
  /** Another resumer holds an unexpired lease — try again after expires_at. */
  'RESUME_IN_PROGRESS',
]);
export type ResumeCasErrorCode = z.infer<typeof ResumeCasErrorCodeSchema>;

/** Default lease duration for a single resume attempt. Heartbeat-extendable. */
export const RESUME_CLAIM_DEFAULT_TTL_MS = 60_000;
/** Cap on consecutive `replace_output` attempts before escalating to `retry_budget_exceeded`. */
export const RESUME_REPLACE_OUTPUT_ATTEMPT_CAP = 3;
