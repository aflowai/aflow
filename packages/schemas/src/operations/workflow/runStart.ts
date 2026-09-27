import { z } from 'zod';
import { ActorKindSchema } from '../../identity/actorContext.js';
import { SimulationRunInputSchema } from '../../simulation/runContext.js';
import {
  ParentInputsRecordSchema,
  TaskTargetedInstructionsSchema,
} from '../../runtime/parentInstructions.js';
import {
  WaiterNotifiedOutcomeSchema,
  WorkflowRunWakeupCancellationSchema,
} from '../../runtime/workflowRun.js';
import { WorkflowRunStatusSchema } from './enums.js';
import { WorkflowRunResultSchema } from './runResult.js';
import { WorkflowHumanDecisionSchema } from './taskHuman.js';
import { CampaignConfigRecordSchema } from './campaignOps.js';

// --- workflow.run.start ---

const workflowRunStartFields = {
  slug: z.string().min(1).max(64),
  campaignId: z.string().uuid().optional(),
  campaignConfig: CampaignConfigRecordSchema.optional(),
  instructions: TaskTargetedInstructionsSchema.optional(),
  inputs: ParentInputsRecordSchema.optional(),
  wait: z.enum(['until_pause', 'until_complete']).default('until_pause'),
  /**
   * How to handle existing active (running/paused) runs of the same
   * workflow at start time:
   *
   *   - `fail_if_active` (default): refuse to start; emit
   *     `CONCURRENCY_LIMIT_EXCEEDED` with `data.activeRunIds` so the
   *     caller can decide (resume? cancel? pick a different slug?).
   *   - `replace_active`: cancel every active run server-side via the
   *     harness `cancelRun` primitive (cascades cancel_run to Runners,
   *     marks remaining task rows cancelled, wakes waiters, writes
   *     attention) BEFORE registering the new run. Atomic from the
   *     agent's POV.
   *   - `allow_concurrent`: skip the check entirely; multiple runs of
   *     the same slug coexist. Use sparingly — the workflow must be
   *     designed for it. Ignored when the skill's manifest declares a
   *     concurrency policy: a manifest `maxConcurrentRuns` is a hard cap
   *     the caller cannot exceed.
   */
  concurrency: z
    .enum(['fail_if_active', 'replace_active', 'allow_concurrent'])
    .default('fail_if_active'),
  acknowledgeOperatorCancel: z.boolean().default(false),
  /**
   * What this run pins its simulated worlds to, keyed by simulationId.
   *
   * The handle that makes a simulated integration measurable rather than merely
   * usable: the same skill, the same call sequence, run as a different caller,
   * against a fixed baseline, or through a different model — and the journal
   * records which, so two runs are comparable rather than merely different.
   *
   * Set by whoever STARTS the run, which is the operator or their proxy. The
   * skill's own Runner never sees this operation, so a subject cannot choose
   * the environment it is measured in.
   */
  simulationRunInput: SimulationRunInputSchema.optional(),
};

// Strict, not strip: a misnamed key (silently dropped) starts the run without
// its intended inputs and fails far downstream — reject it here with the
// allowed keys instead.
export const WorkflowRunStartInputSchema = z
  .object(workflowRunStartFields)
  .strict(`Allowed keys: ${Object.keys(workflowRunStartFields).join(', ')}.`);
export type WorkflowRunStartInput = z.infer<typeof WorkflowRunStartInputSchema>;

export const WorkflowRunStartOutputSchema = z.object({
  kind: z.literal('waiting_on_workflow_run'),
  runId: z.string().uuid(),
  slug: z.string(),
  status: WorkflowRunStatusSchema,
});
export type WorkflowRunStartOutput = z.infer<typeof WorkflowRunStartOutputSchema>;

export const WorkflowRunWakeupHumanDecisionSchema = WorkflowHumanDecisionSchema.extend({
  taskId: z.string(),
  label: z.string(),
});
export type WorkflowRunWakeupHumanDecision = z.infer<typeof WorkflowRunWakeupHumanDecisionSchema>;

export const WorkflowRunWakeupPauseContextSchema = z.object({
  taskId: z.string().optional(),
  pauseCause: z.string().optional(),
  reason: z.string().optional(),
  allowedResumeModes: z.array(z.string()).optional(),
  suggestedResumeCall: z.record(z.unknown()).optional(),
  pausedTaskInputContract: z.record(z.unknown()).optional(),
  // The single directive for what the woken caller should do next, decided by
  // the harness from the pause cause — so the agent does not re-derive it from
  // the prompt. `operator_resolves_on_run_surface` means the operator resolves
  // this pause directly on the run surface; the agent must NOT fire
  // `suggestedResumeCall` (that would steal the decision) — it ends its turn
  // with a brief pointer. `fire_suggested_resume_call` means the agent is the
  // resumer: invoke `suggestedResumeCall`, then end the turn.
  nextStep: z.enum(['operator_resolves_on_run_surface', 'fire_suggested_resume_call']).optional(),
});
export type WorkflowRunWakeupPauseContext = z.infer<typeof WorkflowRunWakeupPauseContextSchema>;

/**
 * Handoff block of the waiter wake-up envelope (`outcome: 'handed_off'`).
 * Produced only by an explicit takeover (`workflow.run.resume` with
 * `takeOver: true`); resolving a pause without takeover leaves existing
 * waiters registered and never emits this block.
 */
export const WorkflowRunWakeupHandoffSchema = z.object({
  resumedBy: z.string().uuid().describe('Session id of the new driver that took over the run.'),
  actorKind: ActorKindSchema.optional().describe(
    "Actor kind behind the new driver's session, when derivable from its actor context — " +
      '`human` means an operator-backed session took over.',
  ),
  runStatusAtHandoff: WorkflowRunStatusSchema.optional().describe(
    'Run status at the moment the takeover landed — typically `running`; the run itself did not terminate.',
  ),
  nextStep: z
    .literal('released_do_not_poll')
    .describe(
      'Your wait on this run is released. Do not poll run detail or re-attach — the new driver sees the run through.',
    ),
});
export type WorkflowRunWakeupHandoff = z.infer<typeof WorkflowRunWakeupHandoffSchema>;

/**
 * The waiter wakeup envelope — the SECOND output of `workflow.run.start` /
 * `workflow.run.resume`: when the awaited run transitions, `notifyWaiters`
 * synthesizes a SUCCEEDED step result whose output is this envelope,
 * overwriting the initial `waiting_on_workflow_run` payload. This schema is
 * the structural contract for that tool result (the orchestrator's
 * `buildWaiterOutputRef` constructs it as this type).
 *
 *   - `result` — structured "what did this run produce" block
 *     (`WorkflowRunResult`): promoted outputs, score vs target, deterministic
 *     outcome checks, summary, artifact pointer, declared guidance.
 *   - `humanDecisions` — operator decisions resolved while the caller slept.
 *   - `pause` — which task paused, why, and the ready-to-copy resume call
 *     (`outcome: 'paused'` only).
 *   - `cancellation` — actor + retry affordance (`outcome: 'cancelled'` only).
 *   - `handoffPayload` — who took over (`outcome: 'handed_off'` only).
 *   - `payloadRef` — full resume-contract payload for callers that need the
 *     complete structured contract beyond the inlined `pause` block.
 */
export const WorkflowRunWakeupEnvelopeSchema = z.object({
  runId: z.string(),
  outcome: WaiterNotifiedOutcomeSchema,
  waiterId: z.string(),
  result: WorkflowRunResultSchema.optional(),
  payloadRef: z.string().optional(),
  handoffPayload: WorkflowRunWakeupHandoffSchema.optional(),
  humanDecisions: z.array(WorkflowRunWakeupHumanDecisionSchema).optional(),
  cancellation: WorkflowRunWakeupCancellationSchema.optional(),
  pause: WorkflowRunWakeupPauseContextSchema.optional(),
});
export type WorkflowRunWakeupEnvelope = z.infer<typeof WorkflowRunWakeupEnvelopeSchema>;
