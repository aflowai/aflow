/**
 * Revision-pinned run launcher for the eval-batch engine (Plan 269 D5).
 *
 * Orchestrator-internal by construction: NOT a registry operation, absent
 * from every agent surface — the public `workflow.run.start` pins the
 * LATEST workflow and a revision override must never be agent-exposed.
 * This entry resolves an EXACT immutable revision (refusing when its
 * snapshot does not exist), validates inputs against THAT revision's
 * run-input surface, then joins the ordinary start pipeline
 * (`recordRunStart` → harness `startRun`) with the run marked frozen
 * (`workflow_runs.eval_batch_id`).
 *
 * The trimmed pipeline is deliberate, not an omission: no operator-cancel
 * restart gate, no concurrency gate, no budget gate, no startup-preflight
 * pause handoff — the batch engine owns dispatch policy (D17) and there is
 * no parked Helmsman step to hand a pause contract to. A trial that lacks
 * credentials pauses/fails at task level, which is itself a gradable
 * observation.
 */
import { randomUUID } from 'node:crypto';
import { resolveWorkflowForRunRevision, MissingPinnedRevisionError } from '@aflow/database';
import type {
  SessionId,
  SimulationRunInput,
  StepExecutionId,
  SystemRole,
  TaskTargetedInstructions,
  TenantId,
} from '@aflow/schemas';
import { normalizeInstructionsForStorage } from '@aflow/schemas';
import {
  emitRunUpdated,
  getCampaignById,
  hashWorkflowConfig,
  materializeAndValidateSkillConfig,
  recordRunStart,
  renderParentInputsValidationFailure,
  renderSkillDiagnostics,
  resolveEffectiveConcurrencyPolicy,
  resolveSkillForWorkflow,
  selectFirstTaskForParentInputs,
  validateInstructionTaskTargets,
  validateParentTaskInputs,
} from '@aflow/cybernetic-runtime';
import { setSessionState, serializeRunAccessGrant, HOT_STATE_TTL_SECONDS } from '@aflow/redis';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { startRun } from '../harness/startRun.js';
import { completeRun } from '../harness/pauseResume.js';
import type { HarnessDeps } from '../harness/types.js';
import { buildEvalTrialGrant } from './evalTrialGrant.js';
import type { LaunchableFixtureTier } from './frozenRunGate.js';

export interface StartWorkflowRunAtRevisionParams {
  tenantId: TenantId;
  /** Home space carrying the skill definition + revision snapshots. */
  spaceId: string;
  slug: string;
  /** Exact immutable revision every trial runs at — never "latest". */
  workflowRevision: number;
  inputs?: Record<string, unknown> | undefined;
  instructions?: TaskTargetedInstructions | undefined;
  campaignId?: string | undefined;
  /**
   * Case-declared campaign config, stamped on run metadata — frozen trials
   * resolve `campaign_input` bindings from THIS pinned copy, never the
   * live campaign row (D5 stationarity; the grader resolves `$campaign`
   * expectation params from the same source).
   */
  campaignConfig?: Record<string, unknown> | undefined;
  evalBatchId: string;
  /**
   * Trial identity stamped on run metadata (`evalTrial`) so a crashed
   * launch is reconcilable by ledger lookup — the D17 idempotency seam.
   */
  caseRevisionId: string;
  trial: number;
  /** Decides the run's grant posture: live = read-only in the home space. */
  fixtureTier: LaunchableFixtureTier;
  /**
   * Whose BYOK credentials the trial's model calls resolve against — the
   * operator who launched the batch. Authority is NOT derived from this
   * (that is the trial grant); a trial with no credential owner cannot
   * call a model at all, so the launch refuses rather than burning trials.
   */
  credentialOwnerId: string;
  /**
   * Space the trial RUN lives in (fixture space). Defaults to `spaceId`;
   * a distinct fixture space additionally requires the batch engine to have
   * materialized the pinned revision snapshot into it.
   */
  targetSpaceId?: string | undefined;
  /**
   * Pins the simulated worlds a sealed trial runs against. Set by the batch
   * from the CASE, never derived per run: a per-run seed would vary the world
   * between trials of one case, and their disagreement would then measure the
   * environment rather than the agent.
   */
  simulationRunInput?: SimulationRunInput | undefined;
  /** agentId → version, from the batch's manifest. */
  agentVersionPins?: Record<string, string> | undefined;
}

export type StartWorkflowRunAtRevisionResult =
  { ok: true; runId: string; evalSessionId: string } | { ok: false; code: string; detail: string };

export async function startWorkflowRunAtRevision(
  deps: HarnessDeps,
  params: StartWorkflowRunAtRevisionParams,
): Promise<StartWorkflowRunAtRevisionResult> {
  const { tenantId, spaceId, slug, workflowRevision, evalBatchId } = params;
  const tenantIdStr = tenantId as string;
  const runSpaceId = params.targetSpaceId ?? spaceId;
  const log = getOrchestratorLogger().child({
    component: 'EvalBatch:startWorkflowRunAtRevision',
    slug,
    evalBatchId,
  });

  let workflow;
  try {
    ({ workflow } = await resolveWorkflowForRunRevision(
      deps.db,
      tenantId,
      spaceId,
      slug,
      workflowRevision,
    ));
  } catch (err) {
    if (err instanceof MissingPinnedRevisionError) {
      return {
        ok: false,
        code: 'REVISION_NOT_FOUND',
        detail:
          `No immutable snapshot exists for workflow '${slug}' r${String(workflowRevision)} — ` +
          `a batch only ever runs a revision that was pinned when it existed.`,
      };
    }
    throw err;
  }
  if (workflow.revision !== workflowRevision) {
    return {
      ok: false,
      code: 'REVISION_MISMATCH',
      detail:
        `Snapshot for '${slug}' r${String(workflowRevision)} carries revision ` +
        `${String(workflow.revision)} — refusing to run a drifted snapshot.`,
    };
  }

  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables,
    output: workflow.output,
  });
  if (validity.status === 'invalid') {
    return {
      ok: false,
      code: 'SKILL_CONTRACT_INVALID',
      detail:
        `Skill '${slug}' r${String(workflowRevision)} has a broken contract:\n` +
        renderSkillDiagnostics(validity.diagnostics),
    };
  }
  const derivedWorkflow = { ...workflow, tasks: materializedTasks };

  if (params.instructions !== undefined) {
    const instructionTargets = validateInstructionTaskTargets(
      { slug, tasks: materializedTasks },
      params.instructions,
    );
    if (!instructionTargets.ok) {
      return { ok: false, code: 'INSTRUCTION_TARGETS_INVALID', detail: instructionTargets.message };
    }
  }

  const initialMetadata: Record<string, unknown> = {
    contractValidity: {
      status: validity.status,
      artifactHash: hashWorkflowConfig(workflow.tasks, workflow.stateVariables),
      validatedAt: validity.validatedAt,
    },
    evalTrial: { caseRevisionId: params.caseRevisionId, trial: params.trial },
    evalFixtureTier: params.fixtureTier,
  };
  if (params.instructions !== undefined) {
    initialMetadata['parentInstructions'] = normalizeInstructionsForStorage(params.instructions);
  }
  if (params.campaignConfig !== undefined) {
    initialMetadata['evalCampaignConfig'] = params.campaignConfig;
  }

  // Validate inputs against THIS revision's run-input surface — the pinned
  // entry task, not the latest one (same rules as the public start path).
  const providedInputs = params.inputs ?? {};
  const declaresRequiredRunInput = (workflow.runInputs ?? []).some((r) => r.required);
  if (Object.keys(providedInputs).length > 0 || declaresRequiredRunInput) {
    const entryTaskSelection = selectFirstTaskForParentInputs({
      slug: workflow.slug,
      tasks: materializedTasks,
    });
    if (!entryTaskSelection.ok) {
      return { ok: false, code: entryTaskSelection.code, detail: entryTaskSelection.message };
    }
    const validation = validateParentTaskInputs(
      entryTaskSelection.task,
      providedInputs,
      workflow.runInputs,
    );
    if (!validation.ok) {
      return {
        ok: false,
        code: 'PARENT_INPUTS_INVALID',
        detail: renderParentInputsValidationFailure(
          entryTaskSelection.task.taskId,
          validation.issues,
          validation.populatableBindAs,
        ),
      };
    }
    if (Object.keys(providedInputs).length > 0) {
      initialMetadata['parentTaskInputs'] = {
        taskId: entryTaskSelection.task.taskId,
        inputs: validation.validatedInputs,
      };
    }
  }

  if (params.campaignId !== undefined) {
    const campaign = await getCampaignById(deps.db, tenantIdStr, params.campaignId);
    if (campaign?.spaceId !== spaceId || campaign.workflowSlug !== slug) {
      return {
        ok: false,
        code: 'CAMPAIGN_NOT_FOUND',
        detail: `Campaign '${params.campaignId}' does not belong to '${slug}' in this space.`,
      };
    }
  }

  const runId = randomUUID();
  const evalSessionId = randomUUID();
  const now = new Date();

  // The eval trial grant (D5): inherited verbatim by every Runner the trial
  // spawns. Live tier = read-only in the home space — this grant is what
  // makes `live` tolerable at all. It rides the anchor's own state write
  // because that write DELs the hash the grant lives in (Plan 28 §P3).
  const trialGrant = buildEvalTrialGrant({ runSpaceId, fixtureTier: params.fixtureTier });

  // Anchor session: the frozen run's provenance-bearing parent. Dispatch
  // inherits spaceId, the eval trial grant, and `createdBy` from it;
  // `trigger: 'eval'` is the salvaged Plan 71 provenance the session-plane
  // exclusion seams key on.
  //
  // `createdBy` and `actorContextJson` are NOT interchangeable here, and the
  // difference is the whole reason a trial can run at all: `createdBy` is
  // whose BYOK credentials pay for the model call (`dispatchTask` derives
  // `credentialOwnerId` from it), while `actorContextJson` is what COMPILES
  // an operator grant. The anchor carries the former and never the latter,
  // so authority stays bounded by the read-only trial grant while the
  // agent turn can still resolve a model.
  //
  // Terminal from birth: it processes no steps and must never look like a
  // recoverable zombie to the session sweepers.
  await setSessionState(
    deps.redis,
    {
      sessionId: evalSessionId,
      tenantId: tenantIdStr,
      target: { kind: 'platform-role', systemRole: 'eval-batch' as SystemRole },
      agentVersion: '1',
      status: 'SUCCEEDED',
      createdAt: now.getTime(),
      endedAt: now.getTime(),
      spaceId: runSpaceId,
      trigger: 'eval',
      grantJson: serializeRunAccessGrant(trialGrant),
      createdBy: params.credentialOwnerId,
      lastUpdatedAt: now.getTime(),
    },
    HOT_STATE_TTL_SECONDS,
  );

  // The trial dispatches under the same per-run task limit as a production run
  // of this skill. The gates a trial skips are admission gates the batch engine
  // owns instead (D17); this one is not a gate but the shape of the execution
  // being measured, and a trial that fans out four tasks where production fans
  // out ten is grading a run the skill never performs. Resolved from the home
  // space: `runSpaceId` may be an ephemeral fixture space holding no manifest.
  const skill = await resolveSkillForWorkflow(
    { db: deps.db, tenantId: tenantIdStr, spaceId },
    slug,
  );
  const effectiveConcurrencyPolicy = skill
    ? resolveEffectiveConcurrencyPolicy(skill.manifest.concurrency)
    : undefined;

  await recordRunStart(deps.db, tenantIdStr, {
    spaceId: runSpaceId,
    workflowSlug: slug,
    runId,
    sessionId: evalSessionId,
    workflowRevision,
    startedAt: now,
    evalBatchId,
    ...(params.campaignId !== undefined ? { campaignId: params.campaignId } : {}),
    ...(effectiveConcurrencyPolicy !== undefined ? { effectiveConcurrencyPolicy } : {}),
    ...(params.simulationRunInput !== undefined
      ? { simulationRunInput: params.simulationRunInput }
      : {}),
    ...(params.agentVersionPins !== undefined ? { agentVersionPins: params.agentVersionPins } : {}),
    metadata: initialMetadata,
  });

  await emitRunUpdated(deps.redis, {
    tenantId: tenantIdStr,
    spaceId: runSpaceId,
    runId,
    workflowSlug: slug,
    status: 'running',
  });

  try {
    await startRun(deps, {
      tenantId,
      spaceId: runSpaceId,
      callingHelmsmanSessionId: evalSessionId as SessionId,
      callingHelmsmanStepExecutionId: randomUUID() as StepExecutionId,
      runId,
      workflow: derivedWorkflow,
    });
  } catch (err) {
    logOrchestratorError('[startWorkflowRunAtRevision] startRun escaped', err, {
      tenantId,
      runId,
    });
    try {
      await completeRun(deps, tenantId, runId, 'failed');
    } catch (completeErr) {
      logOrchestratorError(
        '[startWorkflowRunAtRevision] completeRun(failed) recovery also failed',
        completeErr,
        { tenantId, runId },
      );
    }
  }

  log.info(`[startWorkflowRunAtRevision] run=${runId} slug=${slug} r${String(workflowRevision)}`);
  return { ok: true, runId, evalSessionId };
}
