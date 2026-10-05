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
  catalogId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'The platform catalog skill the workflow at `slug` must be. The run starts only when it is that skill exactly as the Store installed it in this space; an edited copy, or another workflow holding the slug, is refused.',
    ),
  campaignId: z.string().uuid().optional(),
  campaignConfig: CampaignConfigRecordSchema.optional(),
  planNodeId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'The plan node this run serves. The run shows under that node in every conversation’s attention block, the runs it starts serve the same node, and when it ends it links itself — and the pull request it opened — to the node. Absent, a run started by another run serves that run’s node.',
    ),
  instructions: TaskTargetedInstructionsSchema.optional(),
  inputs: ParentInputsRecordSchema.optional(),
  wait: z
    .enum(['until_pause', 'until_complete', 'none'])
    .default('until_pause')
    .describe(
      '`until_pause` and `until_complete` hold this call until the run pauses or ends and return its outcome. ' +
        '`none` returns the run id at once; the outcome arrives later as an event on this conversation.',
    ),
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

const WorkflowRunStartWaitingOutputSchema = z.object({
  kind: z.literal('waiting_on_workflow_run'),
  runId: z.string().uuid(),
  slug: z.string(),
  status: WorkflowRunStatusSchema,
});

export const WorkflowRunStartedOutputSchema = z
  .object({
    status: z.literal('started'),
    runId: z.string().uuid(),
    slug: z.string(),
  })
  .describe(
    'The run is under way. Its outcome arrives as an event on this conversation when the run ' +
      'pauses or ends — nothing more needs to be called to receive it.',
  );
export type WorkflowRunStartedOutput = z.infer<typeof WorkflowRunStartedOutputSchema>;

export const WorkflowRunStartOutputSchema = z.union([
  WorkflowRunStartWaitingOutputSchema,
  WorkflowRunStartedOutputSchema,
]);
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

/**
 * `WorkflowRunWakeup` session-event metadata. The envelope itself rides the
 * event's `outputRef`, as a tool result's output does, so the event log never
 * carries a run's promoted outputs inline.
 */
export const WorkflowRunWakeupEventMetadataSchema = z.object({
  runId: z.string(),
  outcome: WaiterNotifiedOutcomeSchema,
  waiterId: z.string(),
});
export type WorkflowRunWakeupEventMetadata = z.infer<typeof WorkflowRunWakeupEventMetadataSchema>;

/**
 * A run the session started without waiting, reporting that it paused or
 * ended. Keyed by the event that carried it, so a turn handed the recent
 * window takes each one exactly once.
 */
export const WorkflowRunWakeupEntrySchema = z.object({
  eventId: z.string(),
  envelope: WorkflowRunWakeupEnvelopeSchema,
});
export type WorkflowRunWakeupEntry = z.infer<typeof WorkflowRunWakeupEntrySchema>;

/** How many of a session's most recent run wakeups one turn reads. */
export const WORKFLOW_RUN_WAKEUP_MAX_ENTRIES = 20;
