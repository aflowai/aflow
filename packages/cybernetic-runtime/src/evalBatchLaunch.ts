/**
 * The trusted eval-batch launcher (Plan 269 D5/D17): VALIDATE-then-persist.
 * It freezes the dataset membership, pins the skill revision snapshot, runs
 * the cost preflight against the caller's ceiling, assembles the provenance
 * manifest, and hands the queued batch to the durable worker — it never
 * dispatches a trial itself. Both trusted surfaces — the Helmsman
 * `eval.batch.run` op and the operator Measurement REST route — call this
 * one function, so refusal codes and teaching messages are identical.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDirRepository,
  createMemoryDocRepository,
  createTenantContext,
  ensureWorkflowRevisionSnapshot,
  resolveWorkflowForStart,
  apiDefinitions,
  simulationBaselines,
  simulations,
  withTenantSchema,
  WorkflowRevisionDriftError,
} from '@aflow/database';
import {
  EvalBatchProvenanceManifestSchema,
  EvalBatchRunOutputSchema,
  resolveRoleModel,
  sealedSourceKey,
  stableHash,
  type CaseRubric,
  type EvalBatchProvenanceManifest,
  type EvalBatchRunInput,
  type EvalBatchRunOutput,
  type GoldenCase,
  type TenantId,
} from '@aflow/schemas';
import {
  computeCostPreflight,
  resolveBatchDispatchCap,
  type CostPreflight,
} from './evalBatchPlan.js';
import { createEvalBatch, listRecentRunCostsForWorkflow } from './evalBatchStore.js';
import { deriveSubjectModels, deriveBatchJudgeVersions } from './evalBatchJudge.js';
import { deriveValidationSliceSize } from './evalLabelQueue.js';
import { loadGoldenDatasetBundle } from './goldenDatasetStore.js';
import { loadEvalSuite } from './evalRunner.js';
import { loadSpaceDirectives } from './modelResolution.js';
import { resolveSkillForWorkflow } from './skill.js';
import { EVAL_TRIAL_GRADER_VERSION } from './evalTrialGrader.js';
import {
  hashWorkflowConfig,
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
} from './skillValidity/skillValidity.js';

const DEFAULT_TRIALS_PER_CASE = 1;
const COST_PREFLIGHT_SAMPLE_LIMIT = 20;

export type EvalBatchLaunchRefusalCode =
  | 'EVAL_BATCH_NO_CREDENTIAL_OWNER'
  | 'EVAL_BATCH_JUDGE_CREDENTIAL_UNRESOLVED'
  | 'EVAL_BATCH_WORKFLOW_NOT_FOUND'
  | 'EVAL_BATCH_CONTRACT_INVALID'
  | 'EVAL_DATASET_VERSION_NOT_FOUND'
  | 'EVAL_DATASET_NOT_FOUND'
  | 'EVAL_BATCH_EMPTY_DATASET'
  | 'EVAL_BATCH_UNREADABLE_CASE'
  | 'EVAL_BATCH_SEALED_UNBOUND'
  | 'EVAL_BATCH_SEALED_LIVE_BINDING'
  | 'EVAL_BATCH_COST_PREFLIGHT_EXCEEDS_CEILING'
  | 'WORKFLOW_REVISION_DRIFT';

export type EvalBatchLaunchResult =
  | { ok: true; output: EvalBatchRunOutput }
  | { ok: false; code: EvalBatchLaunchRefusalCode; message: string };

export async function launchEvalBatch(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  input: EvalBatchRunInput;
  createdByUserId?: string | undefined;
  /**
   * Whether the space can obtain a client for the judge model, supplied by the
   * caller because the BYOK factory lives outside this package.
   *
   * Grading is space-owned background work and carries no credential owner, so
   * the judge resolves at SPACE scope only — a personal key that makes the
   * model work everywhere else does nothing here. Without this probe the batch
   * runs every trial, pays for every agent turn, and produces no judge verdict
   * at all.
   */
  probeJudgeCredential?: (model: string) => Promise<{ ok: boolean; message?: string }>;
}): Promise<EvalBatchLaunchResult> {
  const { db, tenantId, spaceId, input } = params;
  const slug = input.workflowSlug;

  // Every trial's agent turn resolves its model against the launching
  // operator's BYOK credentials. Without one, each trial fails at its first
  // agent step and grades as a fail for a reason that has nothing to do
  // with the skill — a corrupt measurement is worse than no measurement,
  // so refuse before any trial row exists.
  if (params.createdByUserId === undefined || params.createdByUserId.length === 0) {
    return {
      ok: false,
      code: 'EVAL_BATCH_NO_CREDENTIAL_OWNER',
      message:
        'This batch has no launching operator, so its trials could not resolve model credentials ' +
        'and every one would fail for an authorization reason rather than a measured one. Launch it ' +
        'as a signed-in operator (the Measurement tab, or an authenticated Helmsman session).',
    };
  }

  const workflow = await resolveWorkflowForStart(db, tenantId, spaceId, slug);
  if (!workflow) {
    return {
      ok: false,
      code: 'EVAL_BATCH_WORKFLOW_NOT_FOUND',
      message: `No skill '${slug}' exists in this space — a batch measures an existing skill.`,
    };
  }

  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: workflow.tasks,
    stateVariables: workflow.stateVariables,
    output: workflow.output,
    runInputs: workflow.runInputs,
  });
  if (validity.status === 'invalid') {
    return {
      ok: false,
      code: 'EVAL_BATCH_CONTRACT_INVALID',
      message:
        `Skill '${slug}' has a broken contract — every trial would refuse to start. Repair the skill first:\n` +
        renderSkillDiagnostics(validity.diagnostics),
    };
  }

  const loaded = await loadGoldenDatasetBundle(db, tenantId, {
    spaceId,
    workflowSlug: slug,
    version: input.datasetVersion,
  });
  if (!loaded.ok) {
    if (loaded.code === 'version_not_found') {
      return {
        ok: false,
        code: 'EVAL_DATASET_VERSION_NOT_FOUND',
        message:
          `Dataset version ${String(input.datasetVersion)} does not exist for skill '${slug}' — ` +
          `the dataset is at version ${String(loaded.currentVersion)}. Omit 'datasetVersion' for the latest.`,
      };
    }
    return {
      ok: false,
      code: 'EVAL_DATASET_NOT_FOUND',
      message:
        `No golden dataset exists for skill '${slug}' in this space — there is nothing to measure against. ` +
        'The operator adds cases (or ratifies promoted drafts) first.',
    };
  }
  const { bundle } = loaded;
  // Refused, not skipped. A read that survives a malformed row is what keeps
  // one bad case from failing every batch for a skill; running anyway is what
  // turns it into a suite that measures less than it says it does, with the
  // shortfall invisible in the result. The operator repairs or removes the
  // case, and the number the batch reports is the number it ran.
  if (bundle.unreadable.length > 0) {
    const named = bundle.unreadable
      .slice(0, 5)
      .map((u) => `'${u.title}' (${u.caseId}): ${u.reason}`)
      .join('; ');
    const rest = bundle.unreadable.length - Math.min(5, bundle.unreadable.length);
    return {
      ok: false,
      code: 'EVAL_BATCH_UNREADABLE_CASE',
      message:
        `${String(bundle.unreadable.length)} case(s) in '${slug}' cannot be read and the batch ` +
        `would silently measure the rest: ${named}${rest > 0 ? ` (+${String(rest)} more)` : ''}. ` +
        'Repair or remove them, then launch again.',
    };
  }
  if (bundle.cases.length === 0) {
    return {
      ok: false,
      code: 'EVAL_BATCH_EMPTY_DATASET',
      message:
        `The golden dataset for '${slug}' has no active cases at version ${String(bundle.resolvedVersion)}. ` +
        'Drafts are not part of any version — the operator ratifies them first.',
    };
  }

  // A sealed case names the simulation that answers each of its integrations,
  // and the batch provisions a copy into every trial's fixture space. Refused
  // HERE when it names nothing, because a sealed case with no bindings is a
  // live case wearing the wrong tier: it would reach real services while
  // reading as though it could not.
  // `live_readonly` names an integration a sealed case wants left real, and
  // there is nothing here that can leave it real: a trial runs in a fixture
  // space, `createTrialFixtureSpace` copies no bindings into it, and the
  // executor loads bindings only from the space the run is in. The call would
  // fail as unbound while the case read as sealed and provisioned. Refused
  // until a genuinely read-only live binding can be provisioned, rather than
  // accepted and quietly broken.
  const liveInSealed = bundle.cases.filter(
    (c) =>
      c.case.fixture.tier === 'sealed' &&
      (c.case.fixture.bindings ?? []).some((binding) => binding.mode === 'live_readonly'),
  );
  if (liveInSealed.length > 0) {
    return {
      ok: false,
      code: 'EVAL_BATCH_SEALED_LIVE_BINDING',
      message:
        `${String(liveInSealed.length)} sealed-fixture case(s) ` +
        `(${liveInSealed.map((c) => c.case.title).join('; ')}) declare a 'live_readonly' binding. ` +
        'A sealed trial runs in a fixture space that carries only the bindings this tier provisions, so a live integration is not reachable from it — the call would fail as unbound rather than reaching the real service. Seal that integration too, or re-tier the case to seeded.',
    };
  }

  const unboundSealed = bundle.cases.filter(
    (c) => c.case.fixture.tier === 'sealed' && (c.case.fixture.bindings ?? []).length === 0,
  );
  if (unboundSealed.length > 0) {
    return {
      ok: false,
      code: 'EVAL_BATCH_SEALED_UNBOUND',
      message:
        `The dataset contains ${String(unboundSealed.length)} sealed-fixture case(s) ` +
        `(${unboundSealed.map((c) => c.case.title).join('; ')}) that declare no bindings. ` +
        'A sealed case seals its integrations by naming them — one that names none would run against live services under a tier that says it does not.',
    };
  }

  const trialsPerCase = input.trialsPerCase ?? DEFAULT_TRIALS_PER_CASE;
  const recentCosts = await listRecentRunCostsForWorkflow(db, tenantId, {
    spaceId,
    workflowSlug: slug,
    limit: COST_PREFLIGHT_SAMPLE_LIMIT,
  });
  const preflight = computeCostPreflight({
    recentRunCostsCents: recentCosts,
    caseCount: bundle.cases.length,
    trialsPerCase,
    costCeilingCents: input.costCeilingCents,
  });
  if (preflight.exceedsCeiling) {
    return {
      ok: false,
      code: 'EVAL_BATCH_COST_PREFLIGHT_EXCEEDS_CEILING',
      message:
        `Estimated cost ${String(preflight.estimatedCostCents)}¢ ` +
        `(median ${String(preflight.perRunMedianCents)}¢/run over ${String(preflight.sampleSize)} recent runs × ` +
        `${String(bundle.cases.length)} cases × ${String(trialsPerCase)} trials) exceeds the ` +
        `${String(input.costCeilingCents)}¢ ceiling. Raise the ceiling, lower trialsPerCase, or run a smaller dataset version.`,
    };
  }

  // Pin the revision snapshot NOW — the batch outlives any later skill
  // edit, and the trial launcher refuses a missing snapshot.
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);
  try {
    await ensureWorkflowRevisionSnapshot({
      docRepo,
      dirRepo,
      slug,
      revision: workflow.revision,
      spaceId,
      workflow: workflow as unknown as Record<string, unknown>,
      actor: 'system:eval-batch-launch',
      onDrift: workflow.origin === 'platform' ? 'overwrite' : 'throw',
    });
  } catch (err) {
    if (err instanceof WorkflowRevisionDriftError) {
      return {
        ok: false,
        code: 'WORKFLOW_REVISION_DRIFT',
        message:
          `Skill '${slug}' revision ${String(workflow.revision)} no longer matches its pinned snapshot — ` +
          'an out-of-band edit changed the definition under a fixed revision. Ask the operator to reconcile before measuring.',
      };
    }
    throw err;
  }

  const skill = await resolveSkillForWorkflow({ db, tenantId: tenantId as string, spaceId }, slug);
  const totalTrials = bundle.cases.length * trialsPerCase;
  const maxConcurrentTrials = resolveBatchDispatchCap(
    skill?.manifest.concurrency?.maxConcurrentRuns,
    totalTrials,
    bundle.cases.some((c) => c.case.fixture.tier === 'live'),
  );

  const directives = await loadSpaceDirectives(db, tenantId as string, spaceId);
  // A task delegating to a custom agent is measured on THAT agent's model, and
  // it is only discoverable through the agent's own definition.
  // The judge resolves at SPACE scope — grading carries no credential owner —
  // so a personal key that works everywhere else buys nothing here. Probe it
  // before any trial runs: without this the batch pays for every agent turn
  // and then produces no verdict, which is how 28c bought a batch of
  // `judge_client_unavailable`.
  const spaceJudgeModel = resolveRoleModel(directives?.modelDefaults, 'judge');
  const caseCarriesRubric = bundle.cases.some((c) => c.case.rubrics.length > 0);
  if (
    params.probeJudgeCredential !== undefined &&
    caseCarriesRubric &&
    typeof spaceJudgeModel === 'string' &&
    spaceJudgeModel.length > 0
  ) {
    const probe = await params.probeJudgeCredential(spaceJudgeModel);
    if (!probe.ok) {
      return {
        ok: false,
        code: 'EVAL_BATCH_JUDGE_CREDENTIAL_UNRESOLVED',
        message:
          `This space cannot obtain a client for the judge model '${spaceJudgeModel}'` +
          (probe.message !== undefined ? ` (${probe.message})` : '') +
          '. Grading runs as space-owned background work and carries no credential owner, so the ' +
          'judge needs a SPACE-scoped key for that provider — a personal key will not be read. ' +
          'Add one under the space Integrations settings, or set the Judge role to a model this ' +
          'space already holds a key for. Every trial would otherwise run and be paid for, and ' +
          'come back with no judge verdict at all.',
      };
    }
  }

  const resolvedAgentTasks = await resolveAgentTasks(
    db,
    tenantId,
    spaceId,
    workflow.tasks,
    typeof (workflow as { assignedAgent?: unknown }).assignedAgent === 'string'
      ? ((workflow as { assignedAgent?: string }).assignedAgent ?? undefined)
      : undefined,
  );
  const boundApiIds = new Set(
    bundle.cases.flatMap((c) => (c.case.fixture.bindings ?? []).map((b) => b.integrationId)),
  );
  const apiContractHash = await resolveApiContractHash(db, tenantId, spaceId, boundApiIds);
  const agentTaskModels = agentTaskModelsFrom(resolvedAgentTasks);
  const productionSuite = await loadEvalSuite(db, tenantId as string, spaceId, slug);
  const provenanceManifest: EvalBatchProvenanceManifest = EvalBatchProvenanceManifestSchema.parse({
    workflow: {
      slug,
      revision: workflow.revision,
      configHash: hashWorkflowConfig(materializedTasks, workflow.stateVariables),
    },
    dataset: {
      datasetId: bundle.dataset.datasetId,
      datasetVersion: bundle.resolvedVersion,
    },
    subjectModels: deriveSubjectModels(
      workflow.tasks,
      resolveRoleModel(directives?.modelDefaults, 'runner'),
      agentTaskModels,
    ),
    platform: {
      ...(process.env['PHOENIX_BUILD_VERSION']
        ? { buildVersion: process.env['PHOENIX_BUILD_VERSION'] }
        : {}),
      nodeVersion: process.version,
    },
    caseFixtureHashes: Object.fromEntries(
      bundle.cases.map((c) => [c.revisionId, stableHash(c.case.fixture)]),
    ),
    // Everything that decides the case, not the fixture alone: an edited
    // expectation changes what was measured and leaves the fixture hash equal.
    caseContentHashes: Object.fromEntries(
      bundle.cases.map((c) => [
        c.revisionId,
        stableHash({
          expectations: c.case.expectations,
          rubrics: c.case.rubrics,
          fixture: c.case.fixture,
        }),
      ]),
    ),
    agentVersions: agentVersionsFrom(resolvedAgentTasks),
    ...(apiContractHash !== undefined ? { apiContractHash } : {}),
    sealedSources: await resolveSealedSources(db, tenantId, spaceId, bundle.cases),
    graderVersion: EVAL_TRIAL_GRADER_VERSION,
    judgeVersions: deriveBatchJudgeVersions({
      cases: bundle.cases.map((c) => ({ revisionId: c.revisionId, rubrics: c.case.rubrics })),
      suite: productionSuite,
      spaceJudgeModel: resolveRoleModel(directives?.modelDefaults, 'judge'),
    }),
  });

  const { batchId } = await createEvalBatch(db, tenantId, {
    spaceId,
    workflowSlug: slug,
    datasetId: bundle.dataset.datasetId,
    datasetVersion: bundle.resolvedVersion,
    workflowRevision: workflow.revision,
    trialsPerCase,
    maxConcurrentTrials,
    costCeilingCents: input.costCeilingCents,
    validationSliceSize: deriveValidationSliceSize({
      caseCount: bundle.cases.length,
      trialsPerCase,
      requested: input.validationSliceSize,
    }),
    provenanceManifest,
    notes: input.notes,
    caseRevisionIds: bundle.cases.map((c) => c.revisionId),
    createdByUserId: params.createdByUserId,
  });

  const estimateText =
    preflight.estimatedCostCents !== null
      ? `Estimated cost ${String(preflight.estimatedCostCents)}¢ against the ${String(input.costCeilingCents)}¢ ceiling ` +
        `(median ${String(preflight.perRunMedianCents)}¢/run over ${String(preflight.sampleSize)} recent runs).`
      : `No recent cost history exists for this skill, so there is no estimate — the ${String(input.costCeilingCents)}¢ ceiling still halts dispatch if crossed.`;
  const output = EvalBatchRunOutputSchema.parse({
    batchId,
    workflowSlug: slug,
    workflowRevision: workflow.revision,
    datasetId: bundle.dataset.datasetId,
    datasetVersion: bundle.resolvedVersion,
    caseCount: bundle.cases.length,
    trialsPerCase,
    totalTrials,
    status: 'queued',
    preflight: {
      perRunMedianCents: preflight.perRunMedianCents,
      sampleSize: preflight.sampleSize,
      estimatedCostCents: preflight.estimatedCostCents,
      costCeilingCents: input.costCeilingCents,
    },
    summary:
      `Queued eval batch ${batchId}: ${String(bundle.cases.length)} case(s) × ${String(trialsPerCase)} trial(s) ` +
      `of '${slug}' r${String(workflow.revision)} at dataset v${String(bundle.resolvedVersion)}. ${estimateText} ` +
      'The batch engine runs trials asynchronously; check progress with eval.batch.get.',
  });
  return { ok: true, output };
}

// ============================================================================
// Pre-launch estimate — the Measurement form echoes it before any spend
// ============================================================================

export type EvalBatchPreflightEstimate =
  | {
      ok: true;
      caseCount: number;
      resolvedVersion: number;
      preflight: CostPreflight & {
        models?: { subject: Array<{ scope: string; modelRef: string }>; judges: string[] };
      };
    }
  | {
      ok: false;
      code: 'EVAL_DATASET_NOT_FOUND' | 'EVAL_DATASET_VERSION_NOT_FOUND';
      message: string;
    };

export async function computeEvalBatchPreflightEstimate(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    workflowSlug: string;
    trialsPerCase: number;
    datasetVersion?: number | undefined;
    costCeilingCents?: number | undefined;
  },
): Promise<EvalBatchPreflightEstimate> {
  const loaded = await loadGoldenDatasetBundle(db, tenantId, {
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
    version: params.datasetVersion,
  });
  if (!loaded.ok) {
    if (loaded.code === 'version_not_found') {
      return {
        ok: false,
        code: 'EVAL_DATASET_VERSION_NOT_FOUND',
        message: `Dataset version ${String(params.datasetVersion)} does not exist — the dataset is at version ${String(loaded.currentVersion)}.`,
      };
    }
    return {
      ok: false,
      code: 'EVAL_DATASET_NOT_FOUND',
      message: `No golden dataset exists for skill '${params.workflowSlug}' in this space.`,
    };
  }
  const recentCosts = await listRecentRunCostsForWorkflow(db, tenantId, {
    spaceId: params.spaceId,
    workflowSlug: params.workflowSlug,
    limit: COST_PREFLIGHT_SAMPLE_LIMIT,
  });
  const preflight = computeCostPreflight({
    recentRunCostsCents: recentCosts,
    caseCount: loaded.bundle.cases.length,
    trialsPerCase: params.trialsPerCase,
    // The estimate is ceiling-independent; `exceedsCeiling` is meaningful
    // only when the caller supplied the ceiling it is about to submit.
    costCeilingCents: params.costCeilingCents ?? Number.MAX_SAFE_INTEGER,
  });
  return {
    ok: true,
    caseCount: loaded.bundle.cases.length,
    resolvedVersion: loaded.bundle.resolvedVersion,
    preflight: { ...preflight, models: await resolvePreflightModels(db, tenantId, params, loaded) },
  };
}

/**
 * The models this batch would use, resolved from the three places they are set.
 *
 * Best-effort: an unreadable workflow or agent costs the caller the model
 * names, never the estimate they came for.
 */
async function resolvePreflightModels(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug: string },
  loaded: { bundle: { cases: ReadonlyArray<{ case: { rubrics: readonly CaseRubric[] } }> } },
): Promise<{ subject: Array<{ scope: string; modelRef: string }>; judges: string[] }> {
  const directives = await loadSpaceDirectives(db, tenantId as string, params.spaceId).catch(
    () => null,
  );
  const spaceJudgeModel = resolveRoleModel(directives?.modelDefaults, 'judge');

  const judges = new Set<string>();
  for (const revision of loaded.bundle.cases) {
    for (const rubric of revision.case.rubrics) {
      if (rubric.kind === 'case_local') judges.add(rubric.criterion.model ?? spaceJudgeModel);
      else judges.add(spaceJudgeModel);
    }
  }

  let subject: Array<{ scope: string; modelRef: string }> = [];
  try {
    const workflow = await resolveWorkflowForStart(
      db,
      tenantId,
      params.spaceId,
      params.workflowSlug,
    );
    if (workflow !== null) {
      subject = [
        ...deriveSubjectModels(
          workflow.tasks,
          resolveRoleModel(directives?.modelDefaults, 'runner'),
          agentTaskModelsFrom(
            await resolveAgentTasks(
              db,
              tenantId,
              params.spaceId,
              workflow.tasks,
              typeof (workflow as { assignedAgent?: unknown }).assignedAgent === 'string'
                ? ((workflow as { assignedAgent?: string }).assignedAgent ?? undefined)
                : undefined,
            ),
          ),
        ),
      ];
    }
  } catch {
    // The estimate stands without the subject's model names.
  }

  return { subject, judges: [...judges] };
}

/**
 * Fix the world every sealed trial is provisioned from, before any of them run.
 *
 * Both halves of the source are mutable in the home space, so resolving them
 * per trial lets an operator move the world underneath a batch already running.
 * The baseline a case does not pin resolves to the head HERE and stays there;
 * the artifact revision is recorded so provisioning can refuse a batch whose
 * subject was edited mid-flight — simulations keep no revision history, so an
 * older artifact cannot be reconstructed, and a loud refusal is the only honest
 * answer left.
 */
async function resolveSealedSources(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  cases: ReadonlyArray<{ revisionId: string; case: GoldenCase }>,
): Promise<
  Record<
    string,
    { simulationRevision: number; baselineVersion: number; definitionHash?: string | undefined }
  >
> {
  const sources: Record<
    string,
    { simulationRevision: number; baselineVersion: number; definitionHash?: string | undefined }
  > = {};
  const sealed = cases.filter((entry) => entry.case.fixture.tier === 'sealed');
  if (sealed.length === 0) return sources;

  const tenantCtx = createTenantContext(tenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    for (const entry of sealed) {
      for (const binding of entry.case.fixture.bindings ?? []) {
        if (binding.mode !== 'stub' || binding.simulationId === undefined) continue;
        const simulationId = binding.simulationId;

        const simulationRows = await tx
          .select({ revision: simulations.revision })
          .from(simulations)
          .where(and(eq(simulations.simulationId, simulationId), eq(simulations.spaceId, spaceId)))
          .limit(1);
        const revision = simulationRows[0]?.revision;
        if (revision === undefined) continue;

        let baselineVersion = binding.baselineVersion;
        if (baselineVersion === undefined) {
          const baselineRows = await tx
            .select({ version: simulationBaselines.version })
            .from(simulationBaselines)
            .where(
              and(
                eq(simulationBaselines.spaceId, spaceId),
                eq(simulationBaselines.simulationId, simulationId),
              ),
            )
            .orderBy(desc(simulationBaselines.version))
            .limit(1);
          baselineVersion = baselineRows[0]?.version;
        }
        if (baselineVersion === undefined) continue;

        const definitionRows = await tx
          .select({ definitionJson: apiDefinitions.definitionJson })
          .from(apiDefinitions)
          .where(
            and(
              eq(apiDefinitions.apiId, binding.integrationId),
              eq(apiDefinitions.spaceId, spaceId),
            ),
          )
          .limit(1);
        const definitionJson = definitionRows[0]?.definitionJson;

        sources[sealedSourceKey(entry.revisionId, simulationId)] = {
          simulationRevision: revision,
          baselineVersion,
          ...(definitionJson !== undefined
            ? {
                definitionHash: stableHash(
                  apiSurfaceFor([{ apiId: binding.integrationId, definitionJson }]),
                ),
              }
            : {}),
        };
      }
    }
  });

  return sources;
}

/**
 * The model each agent-typed task will actually answer on.
 *
 * Read from the agent's latest published definition rather than assumed from
 * the space's role defaults, which govern the Helmsman and Coach and reach a
 * custom agent nowhere. An unresolvable agent contributes no entry: recording a
 * model that is not running is worse than recording none, because the
 * judge-equals-subject rule decides from this list.
 */

/**
 * Hash the API surface as the AGENT sees it, not as the row stores it.
 *
 * `mapApiEndpointToToolSpec` builds a tool from an endpoint's name,
 * description and derived input schema, so those three fields are the contract
 * under test. Changing a description to see whether the agent picks the tool
 * better is the experiment this product exists for, and no other manifest
 * field moves when it happens — `catalogVersion` names the platform catalog,
 * and a definition's own `version` is operator-set and need not be bumped.
 *
 * Endpoints are sorted so a reordering of the stored array is not a change.
 */
async function resolveApiContractHash(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  /**
   * The integrations the dataset's cases actually bind. Hashing every enabled
   * definition in the space marked otherwise identical batches as having a
   * changed contract because an unrelated API was edited, and the agent under
   * measurement never sees those.
   */
  boundApiIds: ReadonlySet<string>,
): Promise<string | undefined> {
  if (boundApiIds.size === 0) return undefined;
  const { apiDefinitions, createTenantContext, withTenantSchema } = await import('@aflow/database');
  const { eq, and } = await import('drizzle-orm');
  try {
    const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
      tx
        .select()
        .from(apiDefinitions)
        .where(and(eq(apiDefinitions.spaceId, spaceId), eq(apiDefinitions.enabled, 1))),
    );
    const bound = rows.filter((row) => boundApiIds.has(row.apiId));
    if (bound.length === 0) return undefined;
    return stableHash(apiSurfaceFor(bound));
  } catch {
    // A space with no readable integration surface pins nothing rather than
    // pinning a hash of an error.
    return undefined;
  }
}

/**
 * The API surface as the agent reads it, projected for hashing.
 *
 * Exported so a test can assert that an edit the agent WOULD see moves the
 * hash. The first version of this read `queryParams`/`pathParams`/`bodyParams`,
 * none of which an endpoint carries, so every parameter edit hashed identically
 * while looking thorough.
 */
export function apiSurfaceFor(
  rows: ReadonlyArray<{ apiId: string; definitionJson: unknown }>,
): unknown {
  return rows
    .map((row) => {
      const endpoints = (
        row.definitionJson as { endpoints?: Array<Record<string, unknown>> } | null
      )?.endpoints;
      return {
        apiId: row.apiId,
        endpoints: (endpoints ?? [])
          .map((ep) => ({
            endpointId: ep['endpointId'],
            name: ep['name'],
            description: ep['description'],
            // The description falls back to `{method} {pathTemplate} ({api})`
            // when absent, so both reach the agent.
            method: ep['method'],
            pathTemplate: ep['pathTemplate'],
            // `params` is the whole parameter list, and it is what
            // `deriveEndpointToolSchema` turns into the tool's input schema.
            // An endpoint carries no queryParams/pathParams/bodyParams — an
            // earlier version of this hash read those three names, found
            // undefined in each, and so moved for no parameter edit at all.
            params: ep['params'],
          }))
          .sort((a, b) => String(a.endpointId).localeCompare(String(b.endpointId))),
      };
    })
    .sort((a, b) => a.apiId.localeCompare(b.apiId));
}

interface ResolvedAgentTask {
  model?: string;
  version?: string;
  slug: string;
}

/**
 * What each agent task resolved to at launch — its model, and the version that
 * resolution landed on. The version matters as much as the model: dispatch
 * otherwise takes `latest`, so an agent edited while a batch runs gives two
 * trials of one case two different subjects under a single manifest.
 */
async function resolveAgentTasks(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  tasks: ReadonlyArray<{ taskId: string; agent?: unknown }>,
  /**
   * The workflow's own assignment. Execution resolves
   * `task.agent ?? workflow.assignedAgent ?? 'cybernetic-runner'`, so a task
   * that names no agent still runs one — reading `task.agent` alone left a
   * workflow-level custom agent unpinned, unversioned, and absent from the
   * subject models the judge≠subject guard reads.
   */
  assignedAgent: string | undefined,
): Promise<Record<string, ResolvedAgentTask>> {
  const out: Record<string, ResolvedAgentTask> = {};
  const { createAgentRepository, createTenantContext } = await import('@aflow/database');
  const repo = createAgentRepository(db, createTenantContext(tenantId));
  for (const task of tasks) {
    const effectiveAgent =
      typeof task.agent === 'string' && task.agent.length > 0
        ? task.agent
        : (assignedAgent ?? undefined);
    // The platform runner is not a custom agent and carries no version row.
    if (effectiveAgent === undefined || effectiveAgent === 'cybernetic-runner') continue;
    try {
      const latest = await repo.getLatestVersion(
        effectiveAgent as Parameters<typeof repo.getLatestVersion>[0],
      );
      const row = latest as unknown as { definitionJson?: unknown; version?: unknown } | null;
      const steps = (
        row?.definitionJson as { steps?: Array<{ config?: Record<string, unknown> }> } | undefined
      )?.steps;
      const model = steps?.[0]?.config?.['model'];
      const entry: ResolvedAgentTask = { slug: effectiveAgent };
      if (typeof model === 'string' && model.length > 0) entry.model = model;
      if (typeof row?.version === 'string' && row.version.length > 0) entry.version = row.version;
      out[task.taskId] = entry;
    } catch {
      // A platform-role reference or an archived agent: no entry, never a guess.
    }
  }
  return out;
}

/** The model-only projection the subject-model derivation still expects. */
function agentTaskModelsFrom(resolved: Record<string, ResolvedAgentTask>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [taskId, entry] of Object.entries(resolved)) {
    if (entry.model !== undefined) out[taskId] = entry.model;
  }
  return out;
}

/** The pinned-version projection the manifest records. */
function agentVersionsFrom(
  resolved: Record<string, ResolvedAgentTask>,
): Record<string, { slug: string; version: string }> {
  const out: Record<string, { slug: string; version: string }> = {};
  for (const [taskId, entry] of Object.entries(resolved)) {
    if (entry.version !== undefined) out[taskId] = { slug: entry.slug, version: entry.version };
  }
  return out;
}
