import { randomUUID } from 'node:crypto';
import {
  getDatabase,
  workflowDocPath,
  ensureWorkflowRevisionSnapshot,
  resolveWorkflowForStart,
  WorkflowRevisionDriftError,
} from '@aflow/database';
import type { Campaign, WorkflowRunStartInput } from '@aflow/schemas';
import {
  normalizeInstructionsForStorage,
  deriveGoalRef,
  resolveCampaignGoal,
} from '@aflow/schemas';
import {
  recordRunStart,
  listActiveRunsForWorkflowWithLiveness,
  deriveRunLivenessFromCounts,
  listRecentRuns,
  getRunStatistics,
  selectFirstTaskForParentInputs,
  validateParentTaskInputs,
  validateInstructionTaskTargets,
  renderParentInputsValidationFailure,
  materializeAndValidateSkillConfig,
  maybeTriggerValidityRepairReview,
  renderSkillDiagnostics,
  hashWorkflowConfig,
  resolveSkillForWorkflow,
  listCampaigns,
  ensureActiveCampaign,
  selectCampaignForRunStart,
  buildCampaignRequiredErrorDetails,
  describeCampaignContractFields,
  resolveConnectionForRepoCoordinate,
  RepoConnectionResolveError,
  findUnpinnedGithubApiTasks,
  emitRunUpdated,
  resolveEffectiveConcurrencyPolicy,
} from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, emitStepSuccess, parkInlineStepForWorkflowWait } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';
import { createContractedCampaign } from '../campaign/shared.js';
import { gateWorkflowOperationGrants } from '../../../../helpers/workflowGrantGate.js';
import {
  checkWorkflowCapabilityPreflight,
  checkWorkflowCredentialsPreflight,
  toBlockedBindingsForResumeContract,
} from '../../../../helpers/workflowCredentialsPreflight.js';
import {
  buildNeedsCapabilityStartupContract,
  buildNeedsCredentialsStartupContract,
  handoffStartupPreflightPause,
} from '../../../../helpers/workflowRunStartupPause.js';
import { getRepos, workflowPath } from '../shared.js';
import { wakeParkedStepWithFailure } from './wakeParked.js';

export async function handleWorkflowRunStart(
  args: InlineHandlerArgs,
  input: WorkflowRunStartInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getRepos(args.context.tenantId);
  const slug = input.slug;

  const db = getDatabase();
  const workflow = await resolveWorkflowForStart(db, args.context.tenantId, spaceId, slug);
  if (!workflow) {
    const archivedDoc = await docRepo.getByPath(workflowDocPath(slug), spaceId, {
      includeDeleted: true,
    });
    if (archivedDoc && archivedDoc.deletedAt !== null) {
      await emitStepError(
        args,
        'WORKFLOW_ARCHIVED',
        `Workflow "${slug}" is archived (skill was archived at ${archivedDoc.deletedAt.toISOString()}). Unarchive the skill before starting a new run.`,
        startTime,
        'validation',
      );
      return;
    }
    await emitStepError(
      args,
      'WORKFLOW_NOT_FOUND',
      `No workflow found with slug "${slug}".`,
      startTime,
      'validation',
    );
    return;
  }
  if (workflow.status !== 'approved') {
    await emitStepError(
      args,
      'WORKFLOW_NOT_APPROVED',
      `Workflow "${slug}" is in "${workflow.status}" status. Must be "approved" to start a run.`,
      startTime,
      'validation',
    );
    return;
  }

  // Resolve the skill once (reused for campaign resolution below) — its
  // manifest carries the campaign contract that scopes the operator-cancel gate.
  const skill = await resolveSkillForWorkflow(
    { db, tenantId: args.context.tenantId as string, spaceId },
    slug,
  );

  // The operator-cancel restart gate applies ONLY to campaign-contracted skills:
  // a deliberate stop of an iterating campaign must not auto-restart it. Transient
  // meta-workflows (compose-skill, bind-capability) and any non-campaign skill have
  // no continuing identity — each run is an independent invocation, so a prior
  // operator cancel must not block the next one.
  if (!input.acknowledgeOperatorCancel && skill?.manifest.campaign !== undefined) {
    const [mostRecentRun] = await listRecentRuns(
      db,
      args.context.tenantId as string,
      spaceId,
      slug,
      {
        limit: 1,
      },
    );
    if (mostRecentRun?.status === 'cancelled' && mostRecentRun.cancelledBy === 'operator') {
      await emitStepError(
        args,
        'OPERATOR_CANCEL_RESTART_BLOCKED',
        `Run ${mostRecentRun.runId} of "${slug}" was cancelled by the operator` +
          (mostRecentRun.cancelReason ? ` (reason: ${mostRecentRun.cancelReason})` : '') +
          `. An operator cancel is a deliberate stop, not a transient failure — do NOT auto-restart. ` +
          `Check with the user: ask why they stopped it and what they want to change. ` +
          `Only once the user has EXPLICITLY asked to run it again, retry with acknowledgeOperatorCancel: true.`,
        startTime,
        'validation',
        false,
        {
          lastRunId: mostRecentRun.runId,
          cancelledBy: mostRecentRun.cancelledBy,
          ...(mostRecentRun.cancelReason ? { cancelReason: mostRecentRun.cancelReason } : {}),
        },
      );
      return;
    }
  }

  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables,
    output: workflow.output,
    runInputs: workflow.runInputs,
  });
  if (validity.status === 'invalid') {
    await emitStepError(
      args,
      'SKILL_CONTRACT_INVALID',
      `Skill "${slug}" has a broken contract and cannot run:\n${renderSkillDiagnostics(validity.diagnostics)}`,
      startTime,
      'validation',
      false,
      { diagnostics: validity.diagnostics },
    );
    try {
      await maybeTriggerValidityRepairReview({
        db,
        redis: args.redis,
        payloadStore: args.payloadStore,
        tenantId: args.context.tenantId as string,
        spaceId,
        workflowSlug: slug,
        diagnostics: validity.diagnostics,
        anchorRunId: args.context.runId,
      });
    } catch (err) {
      getOrchestratorLogger().warn(
        `[handleWorkflowRunStart] validity repair trigger failed for "${slug}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return;
  }
  const derivedWorkflow = { ...workflow, tasks: materializedTasks };

  if (input.instructions !== undefined) {
    const instructionTargets = validateInstructionTaskTargets(
      { slug, tasks: materializedTasks },
      input.instructions,
    );
    if (!instructionTargets.ok) {
      await emitStepError(
        args,
        'INSTRUCTION_TARGETS_INVALID',
        instructionTargets.message,
        startTime,
        'validation',
        false,
        {
          unknownTaskIds: instructionTargets.unknownTaskIds,
          nonAgentTaskIds: instructionTargets.nonAgentTaskIds,
          agentTaskIds: instructionTargets.agentTaskIds,
        },
      );
      return;
    }
  }

  const contractArtifactHash = hashWorkflowConfig(workflow.tasks, workflow.stateVariables);

  const tenantIdStr = args.context.tenantId as string;

  let campaignId: string | undefined;
  // Retained for the P3c coding-run connection pin: the resolved campaign's
  // `config.repo` coordinate is what the GitHub connection is resolved from.
  let campaign: Campaign | undefined;
  {
    const rawGoal = skill?.manifest.goal;
    const campaignContract = skill?.manifest.campaign;
    // Campaigns track a NUMERIC goal (the Kaggle bar) OR an OBJECTIVE goal (a
    // process campaign scored on completion). A subjective goal — and a skill
    // with no goal — has nothing to campaign over, so no campaign machinery runs.
    const goal = rawGoal !== undefined && rawGoal.type !== 'subjective' ? rawGoal : undefined;
    // A contract makes campaign membership mandatory for EVERY run; an explicit
    // campaignId also routes through the create-on-identity / select-active path.
    // Both numeric and objective go through it — only the score columns differ
    // (createContractedCampaign resolves them from the goal).
    const hasContractOrExplicit =
      goal !== undefined && (campaignContract !== undefined || input.campaignId !== undefined);
    if (campaignContract !== undefined && goal !== undefined) {
      if (input.campaignConfig !== undefined && input.campaignId === undefined) {
        // Create-on-first-run, selected by IDENTITY. Caller-supplied config is
        // resolved/created against the campaign's identity (createContractedCampaign
        // is idempotent-on-identity), so it takes precedence over implicit
        // selection: naming a second competition while one campaign is active
        // runs THAT competition, not the active one. A matching identity returns
        // the existing campaign; differing mutable config is a CAMPAIGN_CONFIG_CONFLICT.
        const created = await createContractedCampaign(db, tenantIdStr, {
          spaceId,
          slug,
          goal,
          contract: campaignContract,
          config: input.campaignConfig,
        });
        if (!created.ok) {
          await emitStepError(
            args,
            created.code,
            created.message,
            startTime,
            'validation',
            false,
            created.details,
          );
          return;
        }
        campaign = created.campaign;
        campaignId = created.campaign.campaignId;
      }
    }
    if (campaignId === undefined && hasContractOrExplicit) {
      const activeCampaigns = await listCampaigns(db, tenantIdStr, {
        spaceId,
        workflowSlug: slug,
        status: 'active',
      });
      const selection = selectCampaignForRunStart({
        workflowSlug: slug,
        ...(input.campaignId !== undefined ? { explicitCampaignId: input.campaignId } : {}),
        activeCampaigns,
        hasCampaignContract: campaignContract !== undefined,
      });
      if (!selection.ok) {
        const details =
          selection.code === 'CAMPAIGN_REQUIRED' && campaignContract
            ? buildCampaignRequiredErrorDetails(slug, campaignContract)
            : selection.code === 'CAMPAIGN_AMBIGUOUS'
              ? {
                  activeCampaigns: selection.activeCampaigns.map((c) => ({
                    campaignId: c.campaignId,
                    goalRef: c.goalRef,
                    ...(c.config !== undefined ? { config: c.config } : {}),
                  })),
                }
              : undefined;
        // Make the agent-facing message self-contained: the structured
        // contract rides `details` and the field names + enum values are also
        // inlined here (derived, never drifts) so the message alone suffices.
        const message =
          selection.code === 'CAMPAIGN_REQUIRED' && campaignContract
            ? `Skill "${slug}" requires a campaign. Provide campaignConfig with these fields: ${describeCampaignContractFields(campaignContract)}. Collect them from the operator once (e.g. human.chat.ask), then re-call workflow.run.start with campaignConfig — it creates the campaign and starts the run in one call.`
            : selection.message;
        await emitStepError(args, selection.code, message, startTime, 'validation', false, details);
        return;
      } else if (selection.campaign) {
        campaign = selection.campaign;
        campaignId = selection.campaign.campaignId;
      }
    }
    if (campaignId === undefined && campaignContract === undefined && goal?.type === 'numeric') {
      // Numeric goal, no campaign contract, no explicit selection — config-less
      // campaign ensured at run start (one creation site, one timing). An
      // OBJECTIVE goal WITHOUT a contract creates NO campaign (it is just a
      // process skill with no continuing identity to iterate).
      const materialized = resolveCampaignGoal({ goal }, {});
      if (!materialized.ok || materialized.goal.type !== 'numeric') {
        await emitStepError(
          args,
          'CAMPAIGN_GOAL_UNRESOLVED',
          `Skill "${slug}"'s goal could not be materialized for campaign creation` +
            (materialized.ok ? '.' : `: ${materialized.reason}.`) +
            ' A $campaign-parameterized goal requires a campaign contract — fix the skill ' +
            '(workflow.manage.get surfaces the contract diagnostics).',
          startTime,
          'validation',
        );
        return;
      }
      const concreteGoal = materialized.goal;
      const ensured = await ensureActiveCampaign(db, tenantIdStr, {
        spaceId,
        workflowSlug: slug,
        goalRef: deriveGoalRef(slug, concreteGoal, {}),
        scoreMetricKey: concreteGoal.metricKey,
        direction: concreteGoal.direction,
      });
      campaign = ensured;
      campaignId = ensured.campaignId;
    }
  }

  // Plan 222 P3c — resolve + PIN the GitHub connection for a coding/campaign run.
  // The github `api.http.call` tasks dispatch from the pinned `(slug,revision)`
  // snapshot (shared across concurrent campaigns), so the coordinate→connection
  // mapping is resolved ONCE here from the campaign's `config.repo` and pinned on
  // THIS run's metadata — never baked into the snapshot, which different repos'
  // campaigns share and would clobber. Only a coding run carries a `repo`
  // coordinate; every other run no-ops (no pin, no failure). The pin lands before
  // `recordRunStart`, hence before any task dispatch reads it.
  let connectionBindingId: string | undefined;
  // `repo` is the load-bearing campaign-config field for a coding campaign: it both
  // signals "this is a coding run" and carries the coordinate the connection resolves
  // through. A coding skill that named this field anything else would bypass the pin
  // AND this guard — the dispatch-time `connection_binding` resolver still fails
  // closed for a freshly-converted skill (throws with no pin), but the convention is
  // relied on here and in `resolveConnectionForRepoCoordinate`, so keep it `repo`.
  const repoCoordinate = campaign?.config?.['repo'];
  if (typeof repoCoordinate === 'string') {
    try {
      connectionBindingId = await resolveConnectionForRepoCoordinate(
        db,
        tenantIdStr,
        spaceId,
        repoCoordinate,
      );
    } catch (err) {
      if (err instanceof RepoConnectionResolveError) {
        // Fail FAST + legible at run-start instead of failing deep at code.agent.run.
        await emitStepError(args, err.code, err.message, startTime, 'validation', false);
        return;
      }
      throw err;
    }

    // Frozen-skill drift guard (Plan 222 P3d): github `api.http.call` tasks pin
    // the connection via a `connection_binding` inputTemplate. A FROZEN installed
    // skill copied BEFORE the connection model carries no such pin, so the api
    // executor would scope-resolve an arbitrary GitHub account at dispatch (fail
    // OPEN) even though we just pinned the connection. Fail this coding run closed
    // with a legible remedy rather than dispatch against an unintended account.
    // Inspect `materializedTasks` — the exact array dispatched below as
    // `derivedWorkflow.tasks` — so the guard provably checks what the run runs.
    const unpinnedGithubTasks = findUnpinnedGithubApiTasks(materializedTasks);
    if (unpinnedGithubTasks.length > 0) {
      await emitStepError(
        args,
        'CODING_SKILL_PREDATES_CONNECTION_MODEL',
        `This installed coding skill predates the GitHub-connection model: its github ` +
          `task(s) [${unpinnedGithubTasks.join(', ')}] do not pin the repo's connection, so they ` +
          `would resolve an arbitrary GitHub account. Update the skill from its Store listing ` +
          `(Store → the skill → Update), then start the run again.`,
        startTime,
        'validation',
        false,
        { taskIds: unpinnedGithubTasks },
      );
      return;
    }
  }

  // 104d Phase 3: Cross-run concurrency gate. The skill's declared policy is
  // authoritative: a manifest-pinned `maxConcurrentRuns` is a hard cap the
  // caller's `concurrency` knob cannot exceed — `allow_concurrent` bypasses
  // the gate only for skills that declare no policy (default limit 1). The
  // knob otherwise decides what happens when the gate trips (fail/replace).
  const declaredMaxConcurrentRuns = skill?.manifest.concurrency?.maxConcurrentRuns;
  const maxConcurrentRuns =
    typeof declaredMaxConcurrentRuns === 'number' ? declaredMaxConcurrentRuns : 1;
  const concurrencyGateBypassed =
    declaredMaxConcurrentRuns === 'unlimited' ||
    (declaredMaxConcurrentRuns === undefined && input.concurrency === 'allow_concurrent');
  if (!concurrencyGateBypassed) {
    // Discount runs whose work is actually dead (stalled). A durable
    // `running`/`paused` row whose execution is gone must not pin the
    // concurrency slot — otherwise a zombie deadlocks every future start
    // until an operator cancels it. The orphaned-run reconciler fails such
    // runs shortly; this filter is the in-band guard so the gate never
    // trips on one in the meantime.
    const activeRunsWithLiveness = await listActiveRunsForWorkflowWithLiveness(
      db,
      tenantIdStr,
      spaceId,
      slug,
      { limit: 50 },
    );
    const activeRunsForSlug = activeRunsWithLiveness.filter(
      (r) =>
        deriveRunLivenessFromCounts({
          status: r.status,
          startedAt: r.startedAt,
          schedulerCursorAt: r.schedulerCursorAt,
          liveTasks: r.liveTasks,
          scheduledTasks: r.scheduledTasks,
          pausedTasks: r.pausedTasks,
          succeededTasks: r.succeededTasks,
          totalTasks: r.totalTasks,
        }) !== 'stalled',
    );
    if (activeRunsForSlug.length >= maxConcurrentRuns) {
      if (input.concurrency === 'replace_active') {
        // Server-side atomic teardown of every active run before the new
        // one starts. Harness `cancelRun` cascades cancel_run to live
        // Runners, marks remaining task rows cancelled (preserving
        // completed tasks as evidence), wakes any parked waiters, and
        // writes the canonical attention row. Sequential — concurrent
        // cancels of unrelated runIds don't conflict, but the loop keeps
        // the failure surface simple.
        const { cancelRun } = await import('../../../../../cybernetic/WorkflowRunHarness.js');
        for (const r of activeRunsForSlug) {
          try {
            await cancelRun(
              { db, redis: args.redis, payloadStore: args.payloadStore },
              args.context.tenantId,
              r.runId,
              { cancelledBy: 'agent', reason: `replaced_by_new_run:${slug}` },
            );
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            getOrchestratorLogger().error(
              `[handleWorkflowRunStart] replace_active: cancelRun failed for runId=${r.runId}`,
              err instanceof Error ? err : undefined,
              { tenantId: tenantIdStr, slug, runId: r.runId },
            );
            await emitStepError(
              args,
              'REPLACE_ACTIVE_CANCEL_FAILED',
              `Could not cancel existing active run ${r.runId} for "${slug}" before starting a new one: ${detail}. ` +
                `Run workflow.run.cancel({ runId: "${r.runId}" }) yourself, or retry workflow.run.start.`,
              startTime,
              'internal',
              false,
              { activeRunIds: activeRunsForSlug.map((x) => x.runId), failedRunId: r.runId },
            );
            return;
          }
        }
        // Fall through to recordRunStart with no active runs remaining.
      } else {
        // 'fail_if_active' (default).
        const activeRunForSlug = activeRunsForSlug[0]!;
        await emitStepError(
          args,
          'CONCURRENCY_LIMIT_EXCEEDED',
          `Workflow "${slug}" has ${String(activeRunsForSlug.length)} active run(s) (limit: ${String(maxConcurrentRuns)}). ` +
            `Inspect with workflow.run.detail({ runId: "${activeRunForSlug.runId}" }) to see live state and (if paused) the resume contract. ` +
            `To replace it, retry with concurrency: "replace_active", or call workflow.run.cancel({ runId: "${activeRunForSlug.runId}" }) and start again.`,
          startTime,
          'validation',
          false,
          { activeRunIds: activeRunsForSlug.map((r) => r.runId) },
        );
        return;
      }
    }
  }

  // Check budget (relational — 104c Phase 2)
  if (workflow.budget?.maxRuns) {
    const stats = await getRunStatistics(db, tenantIdStr, spaceId, slug, { windowDays: 36500 });
    if (stats.totalRuns >= workflow.budget.maxRuns) {
      await emitStepError(
        args,
        'BUDGET_EXCEEDED',
        `Workflow "${slug}" has reached its maximum of ${workflow.budget.maxRuns} runs.`,
        startTime,
        'validation',
      );
      return;
    }
  }

  // Snapshot current revision (drift-aware, idempotent — see plan 113).
  // Platform-origin workflows are defined by the in-code registry — a stale
  // snapshot from a prior run at the same revision is just cache, so overwrite
  // it (a code edit shouldn't require a manual revision bump). Tenant-authored
  // definitions keep the strict 'throw' invariant: two definitions sharing one
  // revision is a real violation there (their revision is DB-incremented).
  try {
    await ensureWorkflowRevisionSnapshot({
      docRepo,
      dirRepo,
      slug,
      revision: workflow.revision,
      spaceId,
      workflow: workflow as unknown as Record<string, unknown>,
      actor: 'system:run-start',
      onDrift: workflow.origin === 'platform' ? 'overwrite' : 'throw',
    });
  } catch (err) {
    if (err instanceof WorkflowRevisionDriftError) {
      await emitStepError(
        args,
        'WORKFLOW_REVISION_DRIFT',
        `Workflow "${slug}" cannot start: the pinned snapshot for revision ${String(workflow.revision)} no longer matches its stored definition — an out-of-band edit changed the task graph under a fixed revision. ` +
          `Do NOT rewrite or re-put the workflow to work around this — that risks corrupting the graph. ` +
          `Ask the operator to reconcile: re-pin the revision snapshot or re-install the skill, then start again.`,
        startTime,
        'validation',
        false,
        { slug, revision: workflow.revision },
      );
      return;
    }
    throw err;
  }

  // Create run in relational table (104c Phase 2)
  const runId = randomUUID();
  const now = new Date();
  // 104d Phase 3: populate initiatedByUserId from session's createdBy.
  let initiatedByUserId: string | undefined;
  try {
    const { getSessionState: getState } = await import('@aflow/redis');
    const sessionState = await getState(args.redis, args.context.tenantId, args.context.runId);
    if (sessionState?.createdBy) {
      initiatedByUserId = sessionState.createdBy;
    }
  } catch {
    // Best effort — NULL is acceptable for system-initiated runs
  }

  const initialMetadata: Record<string, unknown> = {};
  initialMetadata['contractValidity'] = {
    status: validity.status,
    artifactHash: contractArtifactHash,
    validatedAt: validity.validatedAt,
  };
  if (input.instructions !== undefined) {
    initialMetadata['parentInstructions'] = normalizeInstructionsForStorage(input.instructions);
  }
  if (connectionBindingId !== undefined) {
    initialMetadata['connectionBindingId'] = connectionBindingId;
  }

  // Validate the caller's `inputs` against the entry task's declared run-input
  // surface. This runs even when NO inputs were passed: a skill that declares a
  // REQUIRED run input (e.g. literature-scan's `topic`) must be rejected up front
  // with a naming error, not started only to fail deep at task resolution
  // (`run_input.topic` unavailable). `materializedTasks` is the array actually
  // dispatched, so the entry task and its bindings match what executes.
  const providedInputs = input.inputs ?? {};
  const declaresRequiredRunInput = (workflow.runInputs ?? []).some((r) => r.required);
  if (Object.keys(providedInputs).length > 0 || declaresRequiredRunInput) {
    const entryTaskSelection = selectFirstTaskForParentInputs({
      slug: workflow.slug,
      tasks: materializedTasks,
    });
    if (!entryTaskSelection.ok) {
      await emitStepError(
        args,
        entryTaskSelection.code,
        entryTaskSelection.message,
        startTime,
        'validation',
        false,
        entryTaskSelection.rootTaskIds
          ? { rootTaskIds: entryTaskSelection.rootTaskIds }
          : undefined,
      );
      return;
    }
    const validation = validateParentTaskInputs(
      entryTaskSelection.task,
      providedInputs,
      workflow.runInputs,
    );
    if (!validation.ok) {
      const message = renderParentInputsValidationFailure(
        entryTaskSelection.task.taskId,
        validation.issues,
        validation.populatableBindAs,
      );
      await emitStepError(args, 'PARENT_INPUTS_INVALID', message, startTime, 'validation', false, {
        firstTaskId: entryTaskSelection.task.taskId,
        populatableBindAs: validation.populatableBindAs,
        issues: validation.issues,
      });
      return;
    }
    if (Object.keys(providedInputs).length > 0) {
      initialMetadata['parentTaskInputs'] = {
        taskId: entryTaskSelection.task.taskId,
        inputs: validation.validatedInputs,
      };
    }
  }

  // Frozen alongside `workflowRevision`: dispatch reads the pinned policy, so a
  // manifest edit landing mid-run cannot change this run's limits. A run with no
  // manifest leaves the column NULL and readers fall back to the schema defaults.
  const effectiveConcurrencyPolicy = skill
    ? resolveEffectiveConcurrencyPolicy(skill.manifest.concurrency)
    : undefined;

  await recordRunStart(db, tenantIdStr, {
    spaceId,
    workflowSlug: slug,
    runId,
    sessionId: args.context.runId,
    workflowRevision: workflow.revision,
    startedAt: now,
    initiatedByUserId,
    ...(campaignId !== undefined ? { campaignId } : {}),
    ...(effectiveConcurrencyPolicy !== undefined ? { effectiveConcurrencyPolicy } : {}),
    ...(Object.keys(initialMetadata).length > 0 ? { metadata: initialMetadata } : {}),
    ...(input.simulationRunInput ? { simulationRunInput: input.simulationRunInput } : {}),
  });

  // Space-level signal so the Workbench run feed shows the new run without a poll.
  await emitRunUpdated(args.redis, {
    tenantId: tenantIdStr,
    spaceId,
    runId,
    workflowSlug: slug,
    status: 'running',
  });

  // Create run artifact directory
  await dirRepo.mkdir({ path: `${workflowPath(slug)}/runs/${runId}`, scope: { spaceId } });

  // The preflights validate the PERSISTED workflow (pre-dispatch). A grant deferred
  // to the run's connection (`binding.kind === 'connection'`, e.g. pr-shepherd
  // `rehydrate`) carries no fixed binding; the credentials preflight resolves it to
  // the run's pinned `connectionBindingId` so the real connection's credential is
  // checked — exactly what dispatch will use. The capability preflight keys on
  // `capabilityId` (binding-agnostic), so it reads the raw workflow.
  const credentialsPreflight = await checkWorkflowCredentialsPreflight(
    db,
    args.context.tenantId,
    workflow,
    spaceId,
    connectionBindingId,
  );
  if (!credentialsPreflight.ok) {
    await handoffStartupPreflightPause({
      args,
      db,
      redis: args.redis,
      payloadStore: args.payloadStore,
      tenantId: args.context.tenantId,
      tenantIdStr,
      spaceId,
      runId,
      slug,
      startTime,
      contract: buildNeedsCredentialsStartupContract(
        runId,
        toBlockedBindingsForResumeContract(credentialsPreflight.missingBindings),
      ),
    });
    return;
  }

  const capabilityPreflight = await checkWorkflowCapabilityPreflight(
    db,
    args.context.tenantId,
    workflow,
    spaceId,
  );
  if (!capabilityPreflight.ok) {
    await handoffStartupPreflightPause({
      args,
      db,
      redis: args.redis,
      payloadStore: args.payloadStore,
      tenantId: args.context.tenantId,
      tenantIdStr,
      spaceId,
      runId,
      slug,
      startTime,
      contract: buildNeedsCapabilityStartupContract(runId, capabilityPreflight.missingCapabilities),
    });
    return;
  }

  /**
   * Fail the just-created run so a refusal leaves no recoverable orphan.
   * Never throws: a terminalize failure must not mask the refusal that
   * called it, and the orphan sweeper remains the backstop.
   */
  const terminalizeRefusedRun = async (): Promise<void> => {
    try {
      const { completeRun } = await import('../../../../../cybernetic/WorkflowRunHarness.js');
      await completeRun(
        { db, redis: args.redis, payloadStore: args.payloadStore },
        args.context.tenantId,
        runId,
        'failed',
      );
    } catch (completeErr) {
      getOrchestratorLogger().error(
        `[handleWorkflowRunStart] completeRun(failed) after an authority refusal failed for run=${runId}`,
        completeErr instanceof Error ? completeErr : undefined,
        { tenantId: tenantIdStr, runId, slug },
      );
    }
  };

  // Plan 302: the Runner's grant compiles from the same actor context as this
  // session's, so this session's grant is the authority the run will execute
  // under — full fidelity including per-user grants and the tenant ceiling.
  // Checked over the MATERIALIZED tasks (the executed artifact, Plan 190):
  // an operation the grant refuses would otherwise vanish from the Runner's
  // toolbox silently, mid-run, on every attempt. The stored copy can be up
  // to its TTL stale in both directions — an operator who just performed the
  // remediation this pause names must not be paused again by the old compile
  // — so run start renews it against current policy first.
  const grantGate = await gateWorkflowOperationGrants({
    db,
    redis: args.redis,
    tenantId: args.context.tenantId,
    sessionId: args.context.runId,
    workflow: derivedWorkflow,
  });
  if (grantGate.kind === 'authority_revoked' || grantGate.kind === 'authority_unavailable') {
    // `recordRunStart` already landed, so refusing by erroring alone would
    // leave a `running` row with no tasks and no waiter — precisely the shape
    // `reconcileOrphanedRuns` treats as recoverable, and it recovers by
    // calling `dispatchNextOrTerminate`. Operation tasks bypass step gating,
    // so that reconciliation would dispatch the very work this refused: a
    // fail-closed decision reopening on a delay. Terminalize BEFORE reporting
    // — the terminalize cannot throw out, so an `emitStepError` failure can
    // never strand the run in `running`.
    await terminalizeRefusedRun();
    await (grantGate.kind === 'authority_revoked'
      ? emitStepError(
          args,
          'RUN_ACCESS_REVOKED',
          `Cannot start "${slug}": the access this run would execute under is no longer held — ${grantGate.detail}. ` +
            `Ask a tenant admin to restore the principal's access to this space, then start the run again.`,
          startTime,
          'permission',
          false,
        )
      : emitStepError(
          args,
          'RUN_ACCESS_UNAVAILABLE',
          `Cannot start "${slug}": this run carries an execution principal but its current access grant ` +
            `could not be established — ${grantGate.detail}. This does not mean the access was withdrawn, ` +
            `only that it could not be read. Starting meanwhile would dispatch its operation tasks on an ` +
            `unverified snapshot, since they never pass step gating. Retry once the tenant's capability ` +
            `configuration resolves.`,
          startTime,
          'permission',
          false,
        ));
    return;
  }
  if (grantGate.kind === 'ungranted') {
    await handoffStartupPreflightPause({
      args,
      db,
      redis: args.redis,
      payloadStore: args.payloadStore,
      tenantId: args.context.tenantId,
      tenantIdStr,
      spaceId,
      runId,
      slug,
      startTime,
      contract: buildNeedsCapabilityStartupContract(
        runId,
        grantGate.ungrantedOperations.map((op) => `${op.operationId} — ${op.reason}`),
      ),
    });
    return;
  }

  const launch = async (): Promise<void> => {
    try {
      const { startRun } = await import('../../../../../cybernetic/WorkflowRunHarness.js');
      await startRun(
        { db, redis: args.redis, payloadStore: args.payloadStore },
        {
          tenantId: args.context.tenantId,
          spaceId,
          callingHelmsmanSessionId: args.context.runId,
          callingHelmsmanStepExecutionId: args.stepExecutionId,
          runId,
          workflow: derivedWorkflow,
        },
      );
    } catch (err) {
      // recordRunStart already landed; the run row is in 'running' and
      // the waiter row exists. startRun's internal failure-collection
      // path (Phase 2.2.2c) catches dispatchTask failures and drives
      // applyFailureMode → notifyWaiters wakes the waiter.
      // Anything that escapes here is an unexpected harness error.
      // Drive completeRun(failed) so the waiter we just inserted gets
      // notified.
      const errMsg = err instanceof Error ? err.message : String(err);
      getOrchestratorLogger().error(
        `[handleWorkflowRunStart] startRun escaped its failure-collection path for run=${runId} — failing run`,
        err instanceof Error ? err : undefined,
        { tenantId: tenantIdStr, runId, slug, error: errMsg },
      );
      try {
        const { completeRun } = await import('../../../../../cybernetic/WorkflowRunHarness.js');
        await completeRun(
          { db, redis: args.redis, payloadStore: args.payloadStore },
          args.context.tenantId,
          runId,
          'failed',
        );
      } catch (completeErr) {
        // Last-resort log; the sweeper recovers in Phase 5+.
        getOrchestratorLogger().error(
          `[handleWorkflowRunStart] completeRun(failed) recovery also failed for run=${runId}`,
          completeErr instanceof Error ? completeErr : undefined,
          { tenantId: tenantIdStr, runId, slug },
        );
      }
    }
  };

  if (input.wait === 'none') {
    // The session is the waiter and no step parks: the run's pauses and its
    // end reach the conversation as events.
    try {
      const { addWaiter } = await import('@aflow/cybernetic-runtime');
      await addWaiter(db, tenantIdStr, { runId, waiterSessionId: args.context.runId });
    } catch (waiterErr) {
      const errMsg = waiterErr instanceof Error ? waiterErr.message : String(waiterErr);
      getOrchestratorLogger().error(
        `[handleWorkflowRunStart] addWaiter failed for run=${runId}: ${errMsg}`,
        waiterErr instanceof Error ? waiterErr : undefined,
        { tenantId: tenantIdStr, runId, slug },
      );
      await terminalizeRefusedRun();
      await emitStepError(
        args,
        'WORKFLOW_RUN_START_WAITER_INSERT_FAILED',
        `Run ${runId} was not started: this conversation could not be registered to hear its outcome (${errMsg}).`,
        startTime,
      );
      return;
    }
    await launch();
    await emitStepSuccess(args, { status: 'started', runId, slug }, startTime);
    return;
  }

  await parkInlineStepForWorkflowWait(args, {
    kind: 'waiting_on_workflow_run' as const,
    runId,
    slug,
    status: 'running' as const,
  });

  // Step 2 — insert waiter row BEFORE startRun. This is the durable
  // pivot: any harness-side failure after this point can wake the
  // Helmsman via notifyWaiters; before this point, the step is
  // PAUSED but no row exists for the wake to target.
  try {
    const { addWaiter } = await import('@aflow/cybernetic-runtime');
    await addWaiter(db, tenantIdStr, {
      runId,
      waiterSessionId: args.context.runId,
      waiterStepExecutionId: args.stepExecutionId,
    });
  } catch (waiterErr) {
    // Waiter insert failed (e.g., DB connectivity, unique constraint
    // collision). The step is PAUSED. Wake it explicitly with FAILED
    // since notifyWaiters has no row to target.
    const errMsg = waiterErr instanceof Error ? waiterErr.message : String(waiterErr);
    getOrchestratorLogger().error(
      `[handleWorkflowRunStart] addWaiter failed for run=${runId}: ${errMsg}`,
      waiterErr instanceof Error ? waiterErr : undefined,
      { tenantId: tenantIdStr, runId, slug },
    );
    // Wake the parked step directly — write a FAILED result that
    // applyResult treats as a step failure (it will need PAUSED
    // → STARTED reset first since the step is already PAUSED).
    await wakeParkedStepWithFailure(
      args,
      'WORKFLOW_RUN_START_WAITER_INSERT_FAILED',
      `Failed to register Helmsman as workflow run waiter: ${errMsg}`,
    );
    return;
  }

  await launch();
}
