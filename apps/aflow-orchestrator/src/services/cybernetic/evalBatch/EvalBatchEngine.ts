/**
 * Durable eval-batch engine (Plan 269 D17). `eval_batches` /
 * `eval_case_results` ARE the state machine; one pass over a tenant is a pure
 * re-derivation of "what does this batch still owe" from the rows, so a
 * worker restart mid-batch loses nothing: expired leases are adopted,
 * running trials are re-tracked by runId, and terminalization is reached
 * from any interleaving.
 *
 * Scheduling and tenant discovery live in the runner beside this file — the
 * engine only ever works one already-claimed tenant.
 */
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type {
  CyberneticEvalSuite,
  EvalCaseResultDisposition,
  EvalCaseRubricResult,
  CaseRubric,
  EvalCaseTrialResults,
  EvalCaseTrialVerdict,
  EvalLabelQueueEvidence,
  GoldenCase,
  GoldenCaseRevision,
  SimulationRunInput,
  TenantId,
  TrialOutcome,
  TrialOutcomeClass,
  Workflow,
} from '@aflow/schemas';
import {
  EvalBatchProvenanceManifestSchema,
  EvalCaseTrialResultsSchema,
  classifyTrialOutcome,
  resolveRoleModel,
  verdictForOutcomeClass,
} from '@aflow/schemas';
import {
  isValidSchemaName,
  tenantIdToSchemaName,
  type EvalBatchRow,
  type EvalCaseResultRow,
} from '@aflow/database';
import { createByokAiClientFactory, type ByokAiClientFactory } from '@aflow/credential-resolver';
import {
  addEvalBatchCost,
  sumTrialRunUsage,
  adoptExpiredTrialLeases,
  applyRubricResultsToTrialResults,
  buildCaseRubricJudgeEvidence,
  checkEvidenceSatisfaction,
  buildTrialRunRecord,
  casEvalBatchStatus,
  claimScheduledTrials,
  collectGradingPayloadRefs,
  completeTrialGraded,
  computeBatchScorecard,
  countDispositions,
  createSeededRng,
  dispatchCaseRubricJudge,
  getEvalBatchById,
  getGoldenCaseRevisionsByIds,
  gradeCaseTrial,
  deriveTrialOutcome,
  rubricSlotKey,
  hasCrossedCostCeiling,
  buildLabelQueueSubjectViews,
  insertLabelQueueItems,
  listEvalBatchesNeedingWork,
  listRunsForEvalTrial,
  listTrialRows,
  loadEvalSuite,
  loadSpaceDirectives,
  loadTrialRunSnapshot,
  replyTextFrom,
  type EvalLabelQueuePlanItem,
  markPendingTrialsNeverStarted,
  markTrialCancelled,
  markTrialInfraRetry,
  planBatchTerminalization,
  planLabelQueueForBatch,
  planTrialClaims,
  planTrialRubricJudges,
  recordTrialRunId,
  renewTrialLeases,
  resolveJudgeModelForDispatch,
  seedFromString,
  subjectModelRefsFromManifest,
  terminalizeEvalBatch,
  type GradableRunRecord,
  type JudgeEvidence,
  type ScorecardStratum,
  type TrialGrade,
  type TrialRunSnapshot,
} from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { cancelRun } from '../harness/cancel.js';
import type { HarnessDeps } from '../harness/types.js';
import { startWorkflowRunAtRevision } from './startWorkflowRunAtRevision.js';
import { createTrialFixtureSpace, reapExpiredEvalFixtureSpaces } from './fixtureSpaces.js';
import { provisionSealedBindings, SealedProvisioningError } from './sealedBindings.js';

/**
 * The source worlds this batch pinned for one case, from its provenance
 * manifest. Every trial of the case provisions from the same selection.
 */
function sealedSourcesForCase(
  manifestJson: unknown,
  caseRevisionId: string,
): Record<
  string,
  { simulationRevision: number; baselineVersion: number; definitionHash?: string | undefined }
> {
  const manifest = EvalBatchProvenanceManifestSchema.safeParse(manifestJson);
  if (!manifest.success) return {};
  const prefix = `${caseRevisionId}/`;
  const sources: Record<
    string,
    { simulationRevision: number; baselineVersion: number; definitionHash?: string | undefined }
  > = {};
  for (const [key, value] of Object.entries(manifest.data.sealedSources)) {
    if (!key.startsWith(prefix)) continue;
    sources[key.slice(prefix.length)] = value;
  }
  return sources;
}

const TRIAL_LEASE_MS = 90_000;
const MAX_TRIAL_ATTEMPTS = 3;
const FIXTURE_SPACE_TTL_MS = 6 * 60 * 60 * 1000;
const SPACE_REAP_LIMIT_PER_PASS = 10;

/** Run statuses the engine grades at first observation. A paused frozen
 * trial can never resume (there is no operator inside a batch), so the
 * pause IS its terminal observation — graded, then torn down. */
const GRADABLE_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'paused']);

export interface EvalBatchEngineConfig {
  sqlClient: postgres.Sql;
  harnessDeps: HarnessDeps;
  /** Trial-lease owner. Adoption of an expired lease keys off it. */
  instanceId?: string;
  fixtureSpaceTtlMs?: number;
}

export interface EvalBatchTenantPass {
  /** Batches the pass looked at. */
  batches: number;
  /** Batches (plus the fixture reap) whose own work threw. */
  errors: number;
}

/**
 * The rubric slots that decide a trial's verdict.
 *
 * Every slot the CASE declares, because judge criteria gate and a slot that
 * produced no result must read as unjudged rather than as absent. Taking the
 * set from the results instead would let a slot vanish from the gate whenever
 * it reached neither a result nor the pending list — two scopes sharing a
 * criterion name drain each other's pending entry — and the trial would then
 * pass without that judge having answered.
 */
function gatingSlotsFor(rubrics: readonly CaseRubric[]): Set<string> {
  return new Set(rubrics.map(rubricSlotKey));
}

export class EvalBatchEngine {
  private readonly sqlClient: postgres.Sql;
  private readonly deps: HarnessDeps;
  private readonly instanceId: string;
  private readonly fixtureSpaceTtlMs: number;
  private byokFactory: ByokAiClientFactory | null = null;

  constructor(config: EvalBatchEngineConfig) {
    this.sqlClient = config.sqlClient;
    this.deps = config.harnessDeps;
    this.instanceId = config.instanceId ?? randomUUID();
    this.fixtureSpaceTtlMs = config.fixtureSpaceTtlMs ?? FIXTURE_SPACE_TTL_MS;
  }

  // ==========================================================================

  /**
   * One pass over a claimed tenant: every batch that still owes work, then the
   * fixture spaces its trials left behind.
   *
   * A batch whose own pass throws costs the rest of the tenant nothing — the
   * rows keep saying what is outstanding, so the next pass re-derives it.
   */
  async processTenant(
    tenantId: TenantId,
    options: { signal?: AbortSignal } = {},
  ): Promise<EvalBatchTenantPass> {
    const schemaName = tenantIdToSchemaName(tenantId);
    if (!isValidSchemaName(schemaName)) {
      throw new Error(`Refusing to run the eval-batch engine against schema: ${schemaName}`);
    }

    const batches = await listEvalBatchesNeedingWork(this.deps.db, tenantId);
    let errors = 0;
    let seen = 0;
    for (const batch of batches) {
      if (options.signal?.aborted === true) break;
      seen += 1;
      try {
        await this.processBatch(tenantId, batch);
      } catch (err) {
        errors += 1;
        logOrchestratorError(`[eval-batch] batch ${batch.id} pass failed`, err, {
          tenantId,
          batchId: batch.id,
        });
      }
    }

    try {
      await reapExpiredEvalFixtureSpaces(this.sqlClient, schemaName, {
        limit: SPACE_REAP_LIMIT_PER_PASS,
        liveRunRenewalMs: this.fixtureSpaceTtlMs,
      });
    } catch (err) {
      errors += 1;
      logOrchestratorError('[eval-batch] fixture-space reap failed', err, { tenantId });
    }

    return { batches: seen, errors };
  }

  // ==========================================================================

  private async processBatch(tenantId: TenantId, batchAtRead: EvalBatchRow): Promise<void> {
    let batch = batchAtRead;
    if (batch.status === 'queued') {
      const promoted = await casEvalBatchStatus(this.deps.db, tenantId, {
        batchId: batch.id,
        from: ['queued'],
        to: 'running',
      });
      if (promoted) {
        batch = { ...batch, status: 'running' };
      } else {
        // Someone moved the head since our read (e.g. cancelled while
        // queued) — re-derive from the rows instead of dispatching a
        // pass's worth of trials for a batch that is no longer running.
        const head = await getEvalBatchById(this.deps.db, tenantId, batch.id);
        if (head === null) return;
        batch = head;
      }
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + TRIAL_LEASE_MS);
    const adopted = await adoptExpiredTrialLeases(this.deps.db, tenantId, {
      batchId: batch.id,
      leaseOwner: this.instanceId,
      leaseExpiresAt,
      now,
    });
    if (adopted.length > 0) {
      getOrchestratorLogger().info(
        `[eval-batch] adopted ${String(adopted.length)} expired trial lease(s) for batch ${batch.id}`,
      );
    }

    const rows = await listTrialRows(this.deps.db, tenantId, batch.id);
    const revisionsById = await getGoldenCaseRevisionsByIds(this.deps.db, tenantId, [
      ...new Set(rows.map((r) => r.caseRevisionId)),
    ]);

    let costSpentCents = batch.costSpentCents;
    const running = rows.filter((r) => r.disposition === 'running');

    // 1. Track + grade: every in-flight trial whose run reached a gradable
    //    state gets its deterministic verdict now.
    for (const row of running) {
      // Only the lease owner may settle or grade: another leader's work could
      // still be in flight under an unexpired lease it holds, and adoption
      // already reassigned every expired one to us. Grading is where this
      // bites hardest — the judge calls and their cost land before
      // `completeTrialGraded` CASes, so a second grader pays a second time
      // and the losing CAS undoes neither the spend nor the model calls.
      if (row.leaseOwner !== this.instanceId) continue;
      if (row.runId === null) {
        // Claimed but never launched (crash between claim and dispatch, or
        // launch threw).
        costSpentCents = await this.settleUnlaunchedTrial(tenantId, batch, row, costSpentCents);
        continue;
      }
      const snapshot = await loadTrialRunSnapshot(this.deps.db, tenantId, row.runId);
      if (snapshot === null) {
        costSpentCents = await this.settleUnlaunchedTrial(tenantId, batch, row, costSpentCents);
        continue;
      }
      if (!GRADABLE_RUN_STATUSES.has(snapshot.run.status)) continue;
      const revision = revisionsById.get(row.caseRevisionId);
      if (revision === undefined) {
        await completeTrialGraded(this.deps.db, tenantId, {
          trialId: row.id,
          verdict: 'error',
          outcome: this.invalidCaseOutcome(),
          results: this.gradingFaultResults(
            'CASE_REVISION_MISSING: golden case revision row is gone',
          ),
          completedAt: new Date(),
        });
        continue;
      }
      costSpentCents = await this.gradeTrial(
        tenantId,
        batch,
        row,
        revision,
        snapshot,
        costSpentCents,
      );
    }

    if (batch.status === 'cancelling') {
      await this.drainCancellation(tenantId, batch, rows);
    }

    const ceilingCrossed = hasCrossedCostCeiling(costSpentCents, batch.costCeilingCents);

    // 2. Dispatch new trials under the cap (running batches only, ceiling
    //    permitting).
    if (batch.status === 'running' && !ceilingCrossed) {
      const rowsNow = await listTrialRows(this.deps.db, tenantId, batch.id);
      const counts = countDispositions(rowsNow);
      const claimCount = planTrialClaims({
        batchStatus: 'running',
        dispatchCap: batch.maxConcurrentTrials,
        runningCount: counts.running,
        claimableCount: counts.scheduled + counts.infra_retry,
        ceilingCrossed,
      });
      if (claimCount > 0) {
        const claimed = await claimScheduledTrials(this.deps.db, tenantId, {
          batchId: batch.id,
          limit: claimCount,
          leaseOwner: this.instanceId,
          leaseExpiresAt: new Date(Date.now() + TRIAL_LEASE_MS),
        });
        for (const row of claimed) {
          await this.launchTrial(tenantId, batch, row, revisionsById.get(row.caseRevisionId));
        }
      }
    }

    // 3. Keep surviving leases alive.
    const stillRunning = (await listTrialRows(this.deps.db, tenantId, batch.id)).filter(
      (r) => r.disposition === 'running',
    );
    await renewTrialLeases(this.deps.db, tenantId, {
      trialIds: stillRunning.map((r) => r.id),
      leaseOwner: this.instanceId,
      leaseExpiresAt: new Date(Date.now() + TRIAL_LEASE_MS),
    });

    // 4. Terminalize when the rows allow it.
    await this.maybeTerminalize(tenantId, batch.id, revisionsById);
  }

  // ==========================================================================
  // Dispatch
  // ==========================================================================

  private async launchTrial(
    tenantId: TenantId,
    batch: EvalBatchRow,
    row: EvalCaseResultRow,
    revision: GoldenCaseRevision | undefined,
  ): Promise<void> {
    if (revision === undefined) {
      await completeTrialGraded(this.deps.db, tenantId, {
        trialId: row.id,
        verdict: 'error',
        outcome: this.invalidCaseOutcome(),
        results: this.gradingFaultResults(
          'CASE_REVISION_MISSING: golden case revision row is gone',
        ),
        completedAt: new Date(),
      });
      return;
    }
    const goldenCase: GoldenCase = revision.case;

    try {
      // D17 idempotent dispatch: the run ledger, not the trial row, is the
      // source of truth for "was this trial already launched" — a crash
      // between run creation and recordTrialRunId leaves runId NULL while
      // the run keeps executing. Adopt the survivor (its verdict and spend
      // then flow normally) instead of double-launching; a duplicate from
      // a pre-reconcile interleaving is cancelled, never left running
      // ungraded.
      if (await this.adoptExistingTrialRun(tenantId, batch, row)) return;

      // Launch refuses a creator-less batch, so only a row predating that
      // rule can land here. Grade it rather than dispatching a trial whose
      // every agent step would be denied for want of model credentials.
      const credentialOwnerId = batch.createdByUserId;
      if (credentialOwnerId === null) {
        await completeTrialGraded(this.deps.db, tenantId, {
          trialId: row.id,
          verdict: 'error',
          outcome: this.harnessErrorOutcome(),
          results: this.gradingFaultResults(
            'EVAL_BATCH_NO_CREDENTIAL_OWNER: the batch records no launching operator, so no model credentials resolve',
            goldenCase.fixture.tier,
          ),
          completedAt: new Date(),
        });
        return;
      }

      let targetSpaceId = batch.spaceId;
      let simulationRunInput: SimulationRunInput | undefined;
      if (goldenCase.fixture.tier !== 'live') {
        const { spaceId } = await createTrialFixtureSpace(
          { db: this.deps.db, payloadStore: this.deps.payloadStore },
          {
            tenantId,
            homeSpaceId: batch.spaceId,
            batchId: batch.id,
            caseRevisionId: row.caseRevisionId,
            trial: row.trial,
            workflowSlug: batch.workflowSlug,
            workflow: await this.resolvePinnedWorkflow(tenantId, batch),
            memoryDocs: goldenCase.fixture.memoryDocs ?? [],
            expiresAt: new Date(Date.now() + this.fixtureSpaceTtlMs),
          },
        );
        targetSpaceId = spaceId;
      }

      if (goldenCase.fixture.tier === 'sealed') {
        try {
          simulationRunInput = await provisionSealedBindings({
            db: this.deps.db,
            tenantId,
            homeSpaceId: batch.spaceId,
            fixtureSpaceId: targetSpaceId,
            bindings: goldenCase.fixture.bindings ?? [],
            // From the case revision, never the run: trials of one case must
            // face the SAME world, or their disagreement measures the
            // environment instead of the agent.
            seed: `eval:${row.caseRevisionId}`,
            sources: sealedSourcesForCase(batch.provenanceManifestJson, row.caseRevisionId),
            // Same argument as the seed: a case set at a fixed instant reads
            // the same world on every trial and in six months. Omitted, the
            // trial reads at wall-clock time and a world holding relative dates
            // ages out from under the case.
            ...(goldenCase.fixture.clockAnchor !== undefined
              ? { clockAnchorMs: Date.parse(goldenCase.fixture.clockAnchor) }
              : {}),
          });
        } catch (err) {
          if (err instanceof SealedProvisioningError) {
            // A property of the case (names a simulation the space does not
            // hold, pins a baseline that never existed) — a grading verdict,
            // not an infra retry that would fail identically every time.
            await completeTrialGraded(this.deps.db, tenantId, {
              trialId: row.id,
              verdict: 'error',
              outcome: this.invalidCaseOutcome(),
              results: this.gradingFaultResults(
                `${err.code}: ${err.message}`,
                goldenCase.fixture.tier,
              ),
              completedAt: new Date(),
            });
            return;
          }
          throw err;
        }
      }

      // The manifest recorded what each agent task resolved to at launch, and
      // dispatch would otherwise spawn its Runner at `latest`. Carrying the
      // pins onto the run is what makes the manifest describe the subject that
      // actually ran: a version that no longer resolves fails the trial at the
      // agent load rather than silently running a different agent.
      const agentVersionPins = this.agentVersionPinsFor(batch);

      const result = await startWorkflowRunAtRevision(this.deps, {
        tenantId,
        spaceId: batch.spaceId,
        slug: batch.workflowSlug,
        workflowRevision: batch.workflowRevision,
        inputs: goldenCase.trigger.inputs,
        instructions: goldenCase.trigger.instructions,
        campaignId: goldenCase.trigger.campaignId,
        campaignConfig: goldenCase.trigger.campaignConfig,
        evalBatchId: batch.id,
        caseRevisionId: row.caseRevisionId,
        trial: row.trial,
        fixtureTier: goldenCase.fixture.tier,
        targetSpaceId,
        ...(agentVersionPins !== undefined ? { agentVersionPins } : {}),
        credentialOwnerId,
        ...(simulationRunInput !== undefined ? { simulationRunInput } : {}),
      });

      if (!result.ok) {
        // A typed launch refusal is a property of the case/revision pair
        // (stale inputs, missing snapshot, broken contract) — a grading
        // verdict, not an infra retry.
        await completeTrialGraded(this.deps.db, tenantId, {
          trialId: row.id,
          verdict: 'error',
          outcome: this.invalidCaseOutcome(),
          results: this.gradingFaultResults(
            `${result.code}: ${result.detail}`,
            goldenCase.fixture.tier,
          ),
          completedAt: new Date(),
        });
        return;
      }

      await recordTrialRunId(this.deps.db, tenantId, { trialId: row.id, runId: result.runId });
    } catch (err) {
      logOrchestratorError(
        `[eval-batch] trial launch threw (batch=${batch.id} case=${row.caseRevisionId} trial=${String(row.trial)})`,
        err,
        { tenantId, batchId: batch.id },
      );
      if (row.attempt < MAX_TRIAL_ATTEMPTS) {
        await markTrialInfraRetry(this.deps.db, tenantId, { trialId: row.id });
      } else {
        await completeTrialGraded(this.deps.db, tenantId, {
          trialId: row.id,
          verdict: 'error',
          outcome: this.harnessErrorOutcome(),
          results: this.gradingFaultResults(
            `INFRA_RETRY_BUDGET_EXHAUSTED: launch failed ${String(row.attempt)} time(s): ${
              err instanceof Error ? err.message : String(err)
            }`,
            revision.case.fixture.tier,
          ),
          completedAt: new Date(),
        });
      }
    }
  }

  private async resolvePinnedWorkflow(tenantId: TenantId, batch: EvalBatchRow): Promise<Workflow> {
    const { resolveWorkflowForRunRevision } = await import('@aflow/database');
    const { workflow } = await resolveWorkflowForRunRevision(
      this.deps.db,
      tenantId,
      batch.spaceId,
      batch.workflowSlug,
      batch.workflowRevision,
    );
    return workflow;
  }

  // ==========================================================================
  // Grading
  // ==========================================================================

  private async gradeTrial(
    tenantId: TenantId,
    batch: EvalBatchRow,
    row: EvalCaseResultRow,
    revision: GoldenCaseRevision,
    snapshot: TrialRunSnapshot,
    costSpentBefore: number,
  ): Promise<number> {
    const goldenCase = revision.case;
    const runRecord: GradableRunRecord = buildTrialRunRecord(
      snapshot,
      goldenCase.trigger.campaignConfig,
    );

    const payloads = new Map<string, unknown>();
    for (const ref of collectGradingPayloadRefs(goldenCase.expectations, runRecord)) {
      try {
        payloads.set(ref, await this.deps.payloadStore.retrieve(ref));
      } catch {
        // Absent from the map → the expectation grades failed with an
        // "unavailable" detail (D6 run-terminal coverage — never a skip).
      }
    }

    const grade = gradeCaseTrial({
      expectations: goldenCase.expectations,
      rubrics: goldenCase.rubrics,
      fixtureTier: goldenCase.fixture.tier,
      run: runRecord,
      payloads,
    });

    // Summed from the durable per-step usage envelopes, NOT the run row's
    // roll-up column (which nothing populates — reading it made the ceiling
    // unenforceable and reported every batch as free). No usage step at all
    // means unobserved, which is not the same as costing nothing.
    //
    // Read BEFORE the judge stage: this trial's own run spend is already
    // incurred but not yet on the batch, so a gate that omits it dispatches
    // paid judges for the very trial that carried the batch past its
    // ceiling. The projection is what the ceiling has to answer for.
    const usage = await sumTrialRunUsage(this.deps.db, tenantId, snapshot.run.runId);
    const runCost = usage.costCents;
    const spentIncludingThisRun = costSpentBefore + runCost;

    // Judge stage: rubric verdicts decide the quality axis and so reach the
    // trial's verdict, exactly as a deterministic check reaches it. A stage
    // FAILURE is different from a judge verdict of fail — a stage that could
    // not run leaves its slots pending, which reads as unverified rather than
    // as a judgement nobody made. Judge spend counts
    // against the SAME batch ceiling as trial runs — a batch past its
    // ceiling dispatches no judges, and every judge call's cost lands in
    // costSpentCents (recorded even when the stage throws mid-way).
    let results = grade.results;
    let costSpent = costSpentBefore;
    if (
      goldenCase.rubrics.length > 0 &&
      grade.verdict !== 'error' &&
      !hasCrossedCostCeiling(spentIncludingThisRun, batch.costCeilingCents)
    ) {
      const stageCost = { cents: 0 };
      try {
        const rubricResults = await this.executeTrialRubricJudges(
          tenantId,
          batch,
          goldenCase,
          runRecord,
          snapshot,
          grade,
          payloads,
          { costSpentCents: spentIncludingThisRun, stageCost },
        );
        results = applyRubricResultsToTrialResults(results, rubricResults);
      } catch (err) {
        logOrchestratorError(
          `[eval-batch] rubric judge stage failed (batch=${batch.id} run=${snapshot.run.runId})`,
          err,
          { tenantId, batchId: batch.id },
        );
      }
      // Sub-cent stages round UP: the ceiling is a spend guard and must
      // never be undercounted by fractional-cent judge calls.
      const judgeCostCents = Math.ceil(stageCost.cents);
      if (judgeCostCents > 0) {
        costSpent = await addEvalBatchCost(this.deps.db, tenantId, {
          batchId: batch.id,
          deltaCents: judgeCostCents,
        });
      }
    }

    const completedAt = new Date();
    const durationMs =
      row.startedAt !== null
        ? Math.max(0, completedAt.getTime() - row.startedAt.getTime())
        : undefined;
    const gradedResults = { ...results, costObserved: usage.usageSteps > 0 };
    // Every rubric slot the case carries gates. There is no advisory tier to
    // fall back to: a judge that cannot decide a criterion is a judge to repair
    // or a criterion to rewrite, and a criterion whose verdict decided nothing
    // left the whole quality dimension unmeasured while costing a model call
    // per trial.
    const outcome = deriveTrialOutcome({
      run: runRecord,
      results: gradedResults,
      expectationCount: goldenCase.expectations.length,
      gatingSlots: gatingSlotsFor(goldenCase.rubrics),
    });
    const wrote = await completeTrialGraded(this.deps.db, tenantId, {
      trialId: row.id,
      // Folded from every axis, not from the deterministic half. Reading the
      // checks alone stored `pass` on trials a judge had failed.
      verdict: verdictForOutcomeClass(outcome.outcomeClass),
      outcome,
      results: gradedResults,
      costCents: runCost,
      completedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    if (!wrote) return costSpent;

    if (runCost > 0) {
      costSpent = await addEvalBatchCost(this.deps.db, tenantId, {
        batchId: batch.id,
        deltaCents: runCost,
      });
    }

    // A paused frozen trial has been observed and graded; tear the run down
    // so it never lingers as a parked slot in the trial space.
    if (snapshot.run.status === 'paused') {
      try {
        await cancelRun(this.deps, tenantId, snapshot.run.runId, {
          cancelledBy: 'system',
          reason: 'Eval batch trial graded at pause — frozen runs never resume.',
        });
      } catch (err) {
        logOrchestratorError(
          `[eval-batch] post-grade cancel of paused trial run ${snapshot.run.runId} failed`,
          err,
          { tenantId, batchId: batch.id },
        );
      }
    }
    return costSpent;
  }

  // ==========================================================================
  // Advisory rubric judging (D8)
  // ==========================================================================

  private getByokFactory(): ByokAiClientFactory {
    this.byokFactory ??= createByokAiClientFactory(this.deps.db);
    return this.byokFactory;
  }

  private async executeTrialRubricJudges(
    tenantId: TenantId,
    batch: EvalBatchRow,
    goldenCase: GoldenCase,
    runRecord: GradableRunRecord,
    snapshot: TrialRunSnapshot,
    grade: TrialGrade,
    payloads: ReadonlyMap<string, unknown>,
    budget: {
      /** Batch spend already on record when the stage started. */
      costSpentCents: number;
      /** Mutable accumulator the CALLER owns — judge spend survives a mid-stage throw. */
      stageCost: { cents: number };
    },
  ): Promise<EvalCaseRubricResult[]> {
    const suite = await this.loadProductionSuite(tenantId, batch, goldenCase);
    const plan = planTrialRubricJudges({
      rubrics: goldenCase.rubrics,
      suite,
      deterministicVerdict: grade.verdict,
    });

    const outcomes: EvalCaseRubricResult[] = [];
    let dispatchContext: { spaceJudgeModel: string; subjectModelRefs: string[] | null } | null =
      null;
    let evidence: JudgeEvidence | null = null;

    for (const entry of plan) {
      switch (entry.action) {
        case 'skipped_run_error':
        case 'not_selected':
          outcomes.push({
            status: entry.action,
            criterionId: entry.criterionId,
            scopeKey: entry.scopeKey,
          });
          break;
        case 'unresolved':
          outcomes.push({
            status: 'error',
            criterionId: entry.criterionId,
            scopeKey: entry.scopeKey,
            errorCode: 'rubric_criterion_unresolved',
            errorMessage: entry.detail,
          });
          break;
        case 'judge': {
          // The ceiling is re-checked before EVERY dispatch — judge spend
          // inside the stage counts, so a slot whose budget ran out stays
          // pending rather than firing past the ceiling.
          if (
            hasCrossedCostCeiling(
              budget.costSpentCents + budget.stageCost.cents,
              batch.costCeilingCents,
            )
          ) {
            break;
          }
          dispatchContext ??= await this.buildJudgeDispatchContext(tenantId, batch);
          if (dispatchContext.subjectModelRefs === null) {
            // Fail closed: an unparseable manifest means the subject models
            // are unknown, so the judge≠subject rule cannot be checked —
            // never an unchecked dispatch.
            outcomes.push({
              status: 'error',
              criterionId: entry.criterionId,
              scopeKey: entry.scopeKey,
              errorCode: 'manifest_unavailable',
              errorMessage:
                'The batch provenance manifest did not parse, so the subject models are unknown ' +
                'and the judge≠subject rule cannot be checked. The dispatch is refused.',
            });
            break;
          }
          const resolution = resolveJudgeModelForDispatch({
            criterionModel: entry.criterion.model,
            spaceJudgeModel: dispatchContext.spaceJudgeModel,
            subjectModelRefs: dispatchContext.subjectModelRefs,
          });
          if (!resolution.ok) {
            outcomes.push({
              status: 'error',
              criterionId: entry.criterionId,
              scopeKey: entry.scopeKey,
              errorCode: resolution.errorCode,
              errorMessage: resolution.errorMessage,
            });
            break;
          }
          let client;
          try {
            ({ client } = await this.getByokFactory().getClientForModel(resolution.model, {
              tenantId: tenantId as string,
              spaceId: batch.spaceId,
            }));
          } catch (err) {
            outcomes.push({
              status: 'error',
              criterionId: entry.criterionId,
              scopeKey: entry.scopeKey,
              errorCode: 'judge_client_unavailable',
              errorMessage: err instanceof Error ? err.message : String(err),
            });
            break;
          }
          evidence ??= await this.buildRubricJudgeEvidence(goldenCase, runRecord, payloads);

          // Checked BEFORE the model call, because the call is what costs and
          // because a judge shown no evidence for a fact reads its absence as
          // an invention. An unanswerable criterion abstains and says which
          // part of the pack was missing.
          const satisfaction = checkEvidenceSatisfaction(evidence, entry.criterion.reads);
          if (!satisfaction.satisfied) {
            outcomes.push({
              status: 'error',
              criterionId: entry.criterionId,
              scopeKey: entry.scopeKey,
              errorCode: 'evidence_unavailable',
              errorMessage: `This trial's evidence does not carry ${satisfaction.missing.join(' or ')}, which '${entry.criterion.name}' reads.`,
            });
            continue;
          }
          const dispatched = await dispatchCaseRubricJudge({
            client,
            model: resolution.model,
            criterionId: entry.criterionId,
            scopeKey: entry.scopeKey,
            criterion: entry.criterion,
            evidence,
            tenantId: tenantId as string,
            runId: snapshot.run.runId,
          });
          budget.stageCost.cents += dispatched.costCents;
          outcomes.push(dispatched.result);
          break;
        }
      }
    }
    return outcomes;
  }

  /** The production suite lives in the batch's home space, never the fixture. */
  private async loadProductionSuite(
    tenantId: TenantId,
    batch: EvalBatchRow,
    goldenCase: GoldenCase,
  ): Promise<CyberneticEvalSuite | null> {
    if (!goldenCase.rubrics.some((r) => r.kind === 'suite_criterion')) return null;
    return loadEvalSuite(this.deps.db, tenantId as string, batch.spaceId, batch.workflowSlug);
  }

  /** `subjectModelRefs === null` = unparseable manifest — the caller must refuse the dispatch. */
  private async buildJudgeDispatchContext(
    tenantId: TenantId,
    batch: EvalBatchRow,
  ): Promise<{ spaceJudgeModel: string; subjectModelRefs: string[] | null }> {
    const directives = await loadSpaceDirectives(this.deps.db, tenantId as string, batch.spaceId);
    return {
      spaceJudgeModel: resolveRoleModel(directives?.modelDefaults, 'judge'),
      subjectModelRefs: subjectModelRefsFromManifest(batch.provenanceManifestJson),
    };
  }

  private async buildRubricJudgeEvidence(
    goldenCase: GoldenCase,
    runRecord: GradableRunRecord,
    payloads: ReadonlyMap<string, unknown>,
  ): Promise<JudgeEvidence> {
    return buildCaseRubricJudgeEvidence({
      goldenCase,
      runRecord,
      payloads,
      retrievePayload: (ref) => this.deps.payloadStore.retrieve(ref),
    });
  }

  /**
   * A run already exists for this (batch, caseRevision, trial): link it to
   * the trial row and cancel any extra duplicates. Returns false when the
   * ledger holds no run for the trial.
   */
  private async adoptExistingTrialRun(
    tenantId: TenantId,
    batch: EvalBatchRow,
    row: EvalCaseResultRow,
  ): Promise<boolean> {
    const priorRuns = await listRunsForEvalTrial(this.deps.db, tenantId, {
      evalBatchId: batch.id,
      caseRevisionId: row.caseRevisionId,
      trial: row.trial,
    });
    const adopted = priorRuns[0];
    if (adopted === undefined) return false;
    for (const extra of priorRuns.slice(1)) {
      try {
        await cancelRun(this.deps, tenantId, extra.runId, {
          cancelledBy: 'system',
          reason: 'Duplicate eval trial launch reconciled — the first run is the observation.',
        });
      } catch (err) {
        logOrchestratorError(
          `[eval-batch] cancel of duplicate trial run ${extra.runId} failed`,
          err,
          { tenantId, batchId: batch.id },
        );
      }
    }
    await recordTrialRunId(this.deps.db, tenantId, { trialId: row.id, runId: adopted.runId });
    getOrchestratorLogger().info(
      `[eval-batch] adopted existing run ${adopted.runId} for trial (batch=${batch.id} case=${row.caseRevisionId} trial=${String(row.trial)})`,
    );
    return true;
  }

  /** A claimed row with no surviving run: re-dispatch within budget, else type it. */
  private async settleUnlaunchedTrial(
    tenantId: TenantId,
    batch: EvalBatchRow,
    row: EvalCaseResultRow,
    costSpent: number,
  ): Promise<number> {
    // The launch may have died between run creation and recordTrialRunId —
    // reconcile against the ledger before burning a retry on a trial whose
    // run is alive and well.
    if (row.runId === null && (await this.adoptExistingTrialRun(tenantId, batch, row))) {
      return costSpent;
    }
    if (row.attempt < MAX_TRIAL_ATTEMPTS) {
      await markTrialInfraRetry(this.deps.db, tenantId, { trialId: row.id });
    } else {
      await completeTrialGraded(this.deps.db, tenantId, {
        trialId: row.id,
        verdict: 'error',
        outcome: this.harnessErrorOutcome(),
        results: this.gradingFaultResults(
          `INFRA_RETRY_BUDGET_EXHAUSTED: ${String(row.attempt)} dispatch attempt(s) left no trackable run`,
        ),
        completedAt: new Date(),
      });
    }
    return costSpent;
  }

  /**
   * A fault that is a property of the CASE — a missing revision, a simulation
   * the space does not hold, a launch the contract refuses. Suite health, and
   * excluded from the behavioural score rather than counted as a failure.
   */

  /**
   * agentId → pinned version, from the batch's manifest. Absent when the
   * manifest predates pinning or the workflow runs no custom agent, in which
   * case dispatch resolves `latest` exactly as a production run does.
   */
  private agentVersionPinsFor(batch: {
    provenanceManifestJson: unknown;
  }): Record<string, string> | undefined {
    const parsed = EvalBatchProvenanceManifestSchema.safeParse(batch.provenanceManifestJson);
    if (!parsed.success) return undefined;
    const pins: Record<string, string> = {};
    for (const entry of Object.values(parsed.data.agentVersions)) {
      pins[entry.slug] = entry.version;
    }
    return Object.keys(pins).length > 0 ? pins : undefined;
  }

  /**
   * A fault that is a property of the CASE — a missing revision, a simulation
   * the space does not hold, a launch the contract refuses. Suite health, and
   * excluded from the behavioural score rather than counted as a failure.
   */

  private invalidCaseOutcome(): TrialOutcome {
    return classifyTrialOutcome({
      executionState: 'completed',
      setupOutcome: 'invalid',
      checkOutcome: 'incomplete',
      qualityOutcome: 'not_applicable',
    });
  }

  /**
   * A fault that is a property of the HARNESS — exhausted dispatch attempts, a
   * batch whose credentials do not resolve. It belongs to the execution failure
   * rate; reading it as a bad case would blame the suite for infrastructure.
   */
  private harnessErrorOutcome(): TrialOutcome {
    return classifyTrialOutcome({
      executionState: 'harness_error',
      setupOutcome: 'valid',
      checkOutcome: 'incomplete',
      qualityOutcome: 'not_applicable',
    });
  }

  private gradingFaultResults(
    gradingError: string,
    fixtureTier: 'live' | 'seeded' | 'sealed' = 'live',
  ): EvalCaseTrialResults {
    return EvalCaseTrialResultsSchema.parse({
      expectationResults: [],
      fractionPassed: 0,
      fixtureTier,
      gradingError,
    });
  }

  // ==========================================================================
  // Cancellation + terminalization
  // ==========================================================================

  private async drainCancellation(
    tenantId: TenantId,
    batch: EvalBatchRow,
    rowsAtRead: readonly EvalCaseResultRow[],
  ): Promise<void> {
    await markPendingTrialsNeverStarted(this.deps.db, tenantId, { batchId: batch.id });
    for (const row of rowsAtRead) {
      if (row.disposition !== 'running') continue;
      if (row.runId !== null) {
        try {
          await cancelRun(this.deps, tenantId, row.runId, {
            cancelledBy: 'system',
            reason: 'Eval batch cancelled.',
          });
        } catch (err) {
          logOrchestratorError(
            `[eval-batch] cancel of trial run ${row.runId} failed; retrying next pass`,
            err,
            { tenantId, batchId: batch.id },
          );
          continue;
        }
      }
      await markTrialCancelled(this.deps.db, tenantId, {
        trialId: row.id,
        completedAt: new Date(),
      });
    }
  }

  /**
   * The ONLY minter of partition 'validation' (D10): a uniform seeded draw
   * over the batch's graded deterministic-pass trials, plus exemplar items
   * for judged-fail outcomes. Advisory by placement — a mint failure is
   * logged and never blocks terminalization.
   */
  private async mintLabelQueueItems(
    tenantId: TenantId,
    head: EvalBatchRow,
    finalRows: readonly EvalCaseResultRow[],
    revisionsById: ReadonlyMap<string, GoldenCaseRevision>,
  ): Promise<void> {
    const manifest = EvalBatchProvenanceManifestSchema.safeParse(head.provenanceManifestJson);
    if (!manifest.success) return;
    const items = planLabelQueueForBatch({
      trialRows: finalRows.map((row) => ({
        caseRevisionId: row.caseRevisionId,
        trial: row.trial,
        runId: row.runId,
        disposition: row.disposition,
        verdict: row.verdict,
        resultsJson: row.resultsJson,
      })),
      revisionsById,
      manifest: manifest.data,
      validationSliceSize: head.validationSliceSize,
      rng: createSeededRng(seedFromString(head.id)),
    });
    if (items.length === 0) return;
    const withConversation = await this.attachConversations(tenantId, items, revisionsById);
    const withEvidence = await this.attachEvidence(tenantId, head, withConversation);
    const inserted = await insertLabelQueueItems(this.deps.db, tenantId, {
      spaceId: head.spaceId,
      batchId: head.id,
      items: withEvidence,
    });
    if (inserted > 0) {
      const withExchange = withConversation.filter(
        (item) => item.conversation?.reply != null,
      ).length;
      getOrchestratorLogger().info(
        `[eval-batch] minted ${String(inserted)} label-queue item(s) for batch ${head.id} — ${String(withExchange)} carry a saved exchange`,
      );
    }
  }

  /**
   * Capture each item's exchange while its run still exists.
   *
   * A queue item points at a trial run inside a fixture space that is
   * collected at expiry, so an item left pending long enough loses the very
   * thing it exists to have reviewed. The exchange is two strings; keeping it
   * on the row is what makes the item durable. Several criteria share one
   * trial, so this resolves per run rather than per item.
   *
   * Best-effort by design: a run that cannot be read yields an item without a
   * snapshot, exactly as before, and never blocks terminalization.
   */
  private async attachConversations(
    tenantId: TenantId,
    items: readonly EvalLabelQueuePlanItem[],
    revisionsById: ReadonlyMap<string, GoldenCaseRevision>,
  ): Promise<EvalLabelQueuePlanItem[]> {
    const byRun = new Map<string, { request: string | null; reply: string | null }>();
    const runIds = [...new Set(items.map((item) => item.runId).filter((id) => id !== null))];
    let failures = 0;
    for (const runId of runIds) {
      try {
        const snapshot = await loadTrialRunSnapshot(this.deps.db, tenantId, runId);
        const ref = snapshot?.run.pausedPayloadRef;
        const reply =
          typeof ref === 'string' && ref.length > 0
            ? (replyTextFrom(await this.deps.payloadStore.retrieve(ref)) ?? null)
            : null;
        byRun.set(runId, { request: null, reply });
      } catch (err) {
        // Best-effort, but never silent: a store that fails for every run would
        // otherwise mint a whole batch of items that expire later, and the
        // degradation would only surface once the evidence was already gone.
        failures += 1;
        getOrchestratorLogger().warn(
          `[eval-batch] could not capture the exchange for run ${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (failures > 0) {
      getOrchestratorLogger().warn(
        `[eval-batch] ${String(failures)} of ${String(runIds.length)} run(s) minted label-queue items with no saved exchange`,
      );
    }

    return items.map((item) => {
      const captured = item.runId !== null ? byRun.get(item.runId) : undefined;
      if (captured === undefined) return item;
      const trigger = revisionsById.get(item.caseRevisionId)?.case.trigger.inputs ?? {};
      const request =
        Object.values(trigger).find((value): value is string => typeof value === 'string') ?? null;
      return { ...item, conversation: { request, reply: captured.reply } };
    });
  }

  /**
   * Freeze the judge's pack onto each item while its run still exists.
   *
   * Rebuilt at read time it needs the trial run, and the run's fixture space
   * is collected within hours while an item waits for a person indefinitely —
   * so an item reviewed later fell back to the exchange alone, without the
   * tool results that settle whether a stated fact was supported. A label read
   * from a narrower pack than the judge's measures the evidence gap rather
   * than the judge, which is the one thing these labels exist to do.
   *
   * The read path's own builder does the work, so the frozen pack and a
   * rebuilt one cannot drift. Best-effort like the exchange capture: an item
   * that cannot be built keeps the old behaviour and never blocks
   * terminalization.
   */
  private async attachEvidence(
    tenantId: TenantId,
    head: EvalBatchRow,
    items: readonly EvalLabelQueuePlanItem[],
  ): Promise<EvalLabelQueuePlanItem[]> {
    const keyOf = (item: EvalLabelQueuePlanItem): string =>
      `${item.caseRevisionId}:${String(item.trial)}:${item.criterionId}:${item.scopeKey}`;
    let views: ReadonlyMap<string, { evidence: EvalLabelQueueEvidence }>;
    try {
      views = await buildLabelQueueSubjectViews({
        db: this.deps.db,
        tenantId,
        spaceId: head.spaceId,
        subjects: items.map((item) => ({
          itemId: keyOf(item),
          caseRevisionId: item.caseRevisionId,
          runId: item.runId,
          conversation: item.conversation ?? null,
          criterionId: item.criterionId,
          scopeKey: item.scopeKey,
          workflowSlug: head.workflowSlug,
          judgeVersion: item.judgeVersion ?? null,
        })),
        retrievePayload: (ref) => this.deps.payloadStore.retrieve(ref),
      });
    } catch (err) {
      getOrchestratorLogger().warn(
        `[eval-batch] could not freeze judge evidence for batch ${head.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [...items];
    }

    let frozen = 0;
    const out = items.map((item) => {
      const evidence = views.get(keyOf(item))?.evidence;
      if (evidence?.status !== 'available') return item;
      frozen += 1;
      return { ...item, evidence };
    });
    if (frozen < items.length) {
      getOrchestratorLogger().warn(
        `[eval-batch] froze judge evidence on ${String(frozen)} of ${String(items.length)} label-queue item(s) for batch ${head.id} — the rest are reviewable only until their fixture space is collected`,
      );
    }
    return out;
  }

  private async maybeTerminalize(
    tenantId: TenantId,
    batchId: string,
    revisionsById: ReadonlyMap<string, GoldenCaseRevision>,
  ): Promise<void> {
    const head = await getEvalBatchById(this.deps.db, tenantId, batchId);
    if (head === null) return;
    if (head.status !== 'running' && head.status !== 'cancelling') return;

    const rows = await listTrialRows(this.deps.db, tenantId, batchId);
    const counts = countDispositions(rows);
    const ceilingCrossed = hasCrossedCostCeiling(head.costSpentCents, head.costCeilingCents);
    const plan = planBatchTerminalization({
      status: head.status,
      counts,
      ceilingCrossed,
      costSpentCents: head.costSpentCents,
      costCeilingCents: head.costCeilingCents,
    });
    if (plan === null) return;

    if (plan.markNeverStarted) {
      await markPendingTrialsNeverStarted(this.deps.db, tenantId, { batchId });
    }
    if (!plan.done) return;

    const finalRows = plan.markNeverStarted
      ? await listTrialRows(this.deps.db, tenantId, batchId)
      : rows;

    // D10: mint label-queue items BEFORE the terminal CAS. The validation
    // draw is seeded from the batch id — a pure function of the settled rows
    // — so a crash between this write and terminalization re-derives the
    // identical items next pass and the subject unique index conflict-skips;
    // the draw never re-rolls. Once terminal, the batch never re-enters
    // processing, so after-CAS would be a lost draw on crash.
    try {
      await this.mintLabelQueueItems(tenantId, head, finalRows, revisionsById);
    } catch (err) {
      logOrchestratorError(`[eval-batch] label-queue mint failed for batch ${batchId}`, err, {
        tenantId,
        batchId,
      });
    }

    const strata = new Map<string, ScorecardStratum>();
    for (const [revisionId, revision] of revisionsById) {
      strata.set(revisionId, {
        scenario: revision.case.stratum.scenario,
        tier: revision.case.stratum.tier,
      });
    }
    const summary = computeBatchScorecard({
      rows: finalRows.map((r) => ({
        caseRevisionId: r.caseRevisionId,
        trial: r.trial,
        disposition: r.disposition as EvalCaseResultDisposition,
        verdict: r.verdict as EvalCaseTrialVerdict | null,
        outcomeClass: r.outcomeClass as TrialOutcomeClass | null,
        resultsJson: r.resultsJson,
      })),
      strataByCaseRevision: strata,
      trialsPerCase: head.trialsPerCase,
      costSpentCents: head.costSpentCents,
      ...(plan.terminalReason !== undefined ? { terminalReason: plan.terminalReason } : {}),
    });
    const wrote = await terminalizeEvalBatch(this.deps.db, tenantId, {
      batchId,
      finalStatus: plan.finalStatus,
      summary,
    });
    if (wrote) {
      getOrchestratorLogger().info(
        `[eval-batch] batch ${batchId} terminalized ${plan.finalStatus}` +
          (plan.terminalReason !== undefined ? ` (${plan.terminalReason})` : ''),
      );
    }
  }
}
