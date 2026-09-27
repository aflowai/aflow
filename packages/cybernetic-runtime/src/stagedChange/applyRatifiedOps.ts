/**
 * Apply Ratified Ops — 104e follow-up Phase A.
 *
 * Shared infrastructure for applying staged-change ops after ratification.
 * Dispatches on `op.op` and mutates the target artifact (workflow JSON,
 * eval suite JSON) via memory-doc read-modify-write with version checks.
 *
 * Structured as a reusable apply substrate so future handlers (104f
 * `skill_compose`, 104g `capability_binding`) can plug in cleanly.
 *
 * Atomicity contract: all ops in a proposal must apply successfully or
 * the entire apply is rolled back (no artifact writes). The caller
 * should NOT mark the proposal as ratified if apply throws.
 *
 * Single-writer contract: only this module writes workflow/eval-suite
 * mutations as a consequence of ratification. The causal binder (104e §4.6)
 * is the sole writer of `causal_measurements` rows.
 *
 * @packageDocumentation
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type {
  TenantId,
  StagedChange,
  StagedChangeOp,
  Workflow,
  CyberneticEvalSuite,
  SkillManifest,
  PostInstallTask,
  PreconditionConflict,
  RatificationApplyReason,
} from '@aflow/schemas';
import { WorkflowSchema, CyberneticEvalSuiteSchema, SkillManifestSchema } from '@aflow/schemas';
import {
  createTenantContext,
  createMemoryDocRepository,
  workflowDocPath,
  ensureWorkflowRevisionSnapshot,
} from '@aflow/database';
import { isPlatformWorkflowSlug } from '@aflow/platform-artifacts';
import { getCyberneticLogger } from '../logger.js';
import { resolveCampaignManifestParams, resolveSkillForWorkflow } from '../skill.js';
import type { SkillCampaignManifestParams } from '../skillValidity/skillValidity.js';
import { applySkillComposeBundle, extractAndValidateBundle } from './skillComposeApply.js';
import { applyCapabilityBindingOps } from './capabilityBindingApply.js';
import { applyStoreInstallOps } from './storeInstallApply.js';
import { applyEvalCaseDraftOps } from './evalCaseDraftApply.js';
import { applyArtifactUpdateOps } from './applyArtifactUpdate.js';
import {
  collectEvalSkillSlugs,
  evaluateProposalPreconditions,
  isInScopeForPinning,
} from './preconditions.js';
import { applyOpsToSnapshot } from './applyOpsToSnapshot.js';

// ============================================================================
// Types
// ============================================================================

export interface ApplyContext {
  tenantId: string;
  spaceId: string;
  db: PostgresJsDatabase;
  inTransaction?: boolean;
  /** Required by kinds whose apply publishes invalidations (store_install). */
  redis?: Redis;
  /** Acting operator, stamped onto provenance rows by kinds that write them. */
  actorUserId?: string;
  /** Required by kinds whose apply persists an over-inline-cap artifact source. */
  payloadStore?: PayloadStore | undefined;
}

export interface ApplyResult {
  /** Whether any artifact was actually mutated. */
  applied: boolean;
  /** Ops that were applied successfully. */
  appliedOps: string[];
  /** Ops that were skipped (no-op or handled elsewhere). */
  skippedOps: string[];
  /** New workflow revision after mutations, if workflow was changed. */
  newRevision?: number;
  /** Post-install setup tasks (store_install) — surfaced to the ratifying operator. */
  setupChecklist?: PostInstallTask[];
  stale?: {
    conflicts: PreconditionConflict[];
  };
}

export class RatificationApplyError extends Error {
  constructor(
    public readonly op: string,
    public readonly detail: string,
    public readonly reason: RatificationApplyReason = 'transient',
  ) {
    super(`Ratification apply failed on op '${op}': ${detail}`);
    this.name = 'RatificationApplyError';
  }
}

// ============================================================================
// Eval suite paths
// (workflow paths come from @aflow/database — single source of truth)
// ============================================================================

function evalSuiteDocPath(slug: string): string {
  return `/evals/${slug}/suite.json`;
}

// ============================================================================
// Core apply dispatcher
// ============================================================================

/**
 * Apply all ops from a ratified staged change to the target artifacts.
 *
 * - Workflow-mutation ops read-modify-write the workflow JSON and bump revision.
 * - Eval-criterion ops read-modify-write the eval suite JSON.
 * - `platform_issue` and `flag_pattern` are no-ops (informational only).
 * - `amend_directives` is skipped — handled by the directive amendment route.
 *
 * Atomicity: if ANY op fails, the function throws `RatificationApplyError`
 * and no artifacts are written. The caller must not mark the proposal as
 * ratified if this function throws.
 */
export async function applyRatifiedOps(
  ctx: ApplyContext,
  stagedChange: StagedChange,
): Promise<ApplyResult> {
  const logger = getCyberneticLogger();

  // An eval case draft names the skill it MEASURES, not one it edits, and a
  // golden dataset is a tenant artifact whoever owns that skill. Every other
  // kind targeting a platform artifact is asking for a code change.
  const targetsMeasuredSkill = stagedChange.kind === 'eval_case_draft';
  if (
    !targetsMeasuredSkill &&
    stagedChange.targetWorkflowSlug &&
    isPlatformWorkflowSlug(stagedChange.targetWorkflowSlug)
  ) {
    throw new RatificationApplyError(
      'platform_artifact_read_only',
      `Cannot apply ops to platform-owned workflow "${stagedChange.targetWorkflowSlug}" — ` +
        `this artifact lives in packages/platform-artifacts/ and requires a code change. ` +
        `Diagnostic should be surfaced as a /coach/platform-issues/ report.`,
      'platform_artifact_read_only',
    );
  }

  // -- Kind-level dispatch: some kinds have a dedicated handler that
  //    processes the entire proposal atomically (not op-by-op).
  if (stagedChange.kind === 'skill_compose') {
    const bundle = extractAndValidateBundle(stagedChange);
    return applySkillComposeBundle(ctx, bundle);
  }

  if (stagedChange.kind === 'capability_binding') {
    return applyCapabilityBindingOps(ctx, stagedChange);
  }

  if (stagedChange.kind === 'store_install') {
    return applyStoreInstallOps(ctx, stagedChange);
  }

  if (stagedChange.kind === 'artifact_update') {
    return applyArtifactUpdateOps(ctx, stagedChange);
  }

  if (stagedChange.kind === 'eval_case_draft') {
    return applyEvalCaseDraftOps(ctx, stagedChange);
  }

  // -- Default: per-op dispatch for workflow refinement, eval criterion, etc.
  const result: ApplyResult = {
    applied: false,
    appliedOps: [],
    skippedOps: [],
  };

  const ops = stagedChange.proposal.ops;
  const targetSlug = stagedChange.targetWorkflowSlug;

  // Partition ops by target artifact
  const workflowOps: StagedChangeOp[] = [];
  const evalOps: StagedChangeOp[] = [];
  const manifestOps: StagedChangeOp[] = [];
  const noOpKinds = new Set(['platform_issue', 'flag_pattern', 'amend_directives']);

  for (const op of ops) {
    if (noOpKinds.has(op.op)) {
      result.skippedOps.push(op.op);
      continue;
    }
    if (op.op.startsWith('eval.criterion.')) {
      evalOps.push(op);
    } else if (op.op === 'update_goal' || op.op.startsWith('campaign.field.')) {
      manifestOps.push(op);
    } else {
      workflowOps.push(op);
    }
  }

  if (isInScopeForPinning(stagedChange.kind) && stagedChange.preconditions === undefined) {
    throw new RatificationApplyError(
      'precondition_missing',
      `This proposal was authored before revision pinning was enabled and ` +
        `cannot be ratified safely. Regenerate it so the Coach can re-check it ` +
        `against the current state of the workflow.`,
      'precondition_missing',
    );
  }

  const campaign: SkillCampaignManifestParams | undefined =
    targetSlug && (workflowOps.length > 0 || evalOps.length > 0)
      ? await resolveCampaignManifestParams(
          {
            db: ctx.db,
            tenantId: ctx.tenantId,
            spaceId: ctx.spaceId,
            ...(ctx.inTransaction ? { inTransaction: true } : {}),
          },
          targetSlug,
        )
      : undefined;

  // Manifest ops (goal / campaign-contract edits) target the skill's manifest
  // doc, keyed by skillId — resolve it from the workflow slug up front so we
  // can lock the doc inside the transaction.
  let manifestSkillId: string | null = null;
  if (manifestOps.length > 0 && targetSlug) {
    if (isPlatformWorkflowSlug(targetSlug)) {
      throw new RatificationApplyError(
        manifestOps[0]?.op ?? 'unknown',
        `Platform-owned skill '${targetSlug}' cannot be edited.`,
        'post_validation',
      );
    }
    const skill = await resolveSkillForWorkflow(
      {
        db: ctx.db,
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        ...(ctx.inTransaction ? { inTransaction: true } : {}),
      },
      targetSlug,
    );
    if (!skill) {
      throw new RatificationApplyError(
        manifestOps[0]?.op ?? 'unknown',
        `No skill found for workflow slug '${targetSlug}'.`,
        'target_skill_missing',
      );
    }
    manifestSkillId = skill.manifest.skillId;
  }

  // Wrap workflow + eval apply in a single transaction with row-locks on
  // every artifact this proposal touches. That serializes concurrent
  // ratifications against the same artifact and lets us read-check-apply-write
  // atomically. The first step inside the transaction is the precondition
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const outerRepo = createMemoryDocRepository(ctx.db, tenantCtx);

  await outerRepo.withTransaction(async (txRepo) => {
    // Lock + load all artifacts the proposal touches.
    let workflow: Workflow | null = null;
    if (
      targetSlug &&
      (workflowOps.length > 0 || manifestOps.length > 0 || isInScopeForPinning(stagedChange.kind))
    ) {
      const wfDoc = await txRepo.getByPath(workflowDocPath(targetSlug), ctx.spaceId, {
        forUpdate: true,
      });
      if (wfDoc?.inlineContent) {
        workflow = WorkflowSchema.parse(JSON.parse(wfDoc.inlineContent));
      }
    }

    // Lock + load the manifest when goal/campaign ops are present; the post-edit
    // contract is what the workflow's `$campaign` refs are re-validated against.
    let manifest: SkillManifest | null = null;
    if (manifestSkillId) {
      const mDoc = await txRepo.getByPath(manifestDocPath(manifestSkillId), ctx.spaceId, {
        forUpdate: true,
      });
      if (mDoc?.inlineContent) {
        manifest = SkillManifestSchema.parse(JSON.parse(mDoc.inlineContent));
      }
      if (!manifest) {
        throw new RatificationApplyError(
          manifestOps[0]?.op ?? 'unknown',
          `Manifest not found at ${manifestDocPath(manifestSkillId)}`,
          'target_skill_missing',
        );
      }
    }

    const evalOpSlugs = new Set(collectEvalSkillSlugs(stagedChange));
    // A manifest (contract) edit can orphan a `$campaign` ref in the target
    // skill's eval suite, so load it for read-only re-validation even when no
    // eval op touches it — but never persist a suite that wasn't mutated.
    const evalSlugsToLoad = new Set(evalOpSlugs);
    if (manifestOps.length > 0 && targetSlug) evalSlugsToLoad.add(targetSlug);
    const evalSuites = new Map<string, CyberneticEvalSuite>();
    for (const slug of evalSlugsToLoad) {
      const suiteDoc = await txRepo.getByPath(evalSuiteDocPath(slug), ctx.spaceId, {
        forUpdate: true,
      });
      if (suiteDoc?.inlineContent) {
        evalSuites.set(slug, CyberneticEvalSuiteSchema.parse(JSON.parse(suiteDoc.inlineContent)));
      }
    }

    if (stagedChange.preconditions) {
      const conflicts = evaluateProposalPreconditions(stagedChange, {
        workflow,
        evalSuites,
        manifest,
      });
      if (conflicts && conflicts.length > 0) {
        logger.info(
          `[applyRatifiedOps] Proposal ${stagedChange.id} is stale: ` +
            `${String(conflicts.length)} precondition(s) no longer hold`,
        );
        result.stale = { conflicts };
        return; // commit-with-no-writes; the row locks release on commit
      }
    }

    // Preconditions passed (or n/a) — apply ops.
    //
    if (workflowOps.length > 0 && targetSlug && !workflow) {
      throw new RatificationApplyError(
        workflowOps[0]?.op ?? 'unknown',
        `Workflow not found at ${workflowDocPath(targetSlug)}`,
        'workflow_not_found',
      );
    }
    if (workflowOps.length > 0 || evalOps.length > 0 || manifestOps.length > 0) {
      const transform = applyOpsToSnapshot({
        workflow: workflow ?? null,
        evalSuites,
        // Eval ops with `targetScope: 'task'` validate against this set.
        ...(workflow ? { workflowTaskIds: new Set(workflow.tasks.map((t) => t.taskId)) } : {}),
        ops: [...workflowOps, ...evalOps, ...manifestOps],
        ...(targetSlug ? { targetSlug } : {}),
        ...(manifest ? { manifest } : {}),
        ...(campaign ? { campaign } : {}),
        // Stamps operator authorship + enforces the Coach-can't-clobber rule at
        // the real apply. Only 'operator' is distinguished; every other source
        // (coach / compose / bind / agent_patch) applies as coach.
        source: stagedChange.source === 'operator' ? 'operator' : 'coach',
      });
      if (!transform.ok) {
        // Map shared-transform failures to RatificationApplyError so the
        // outer apply path's existing telemetry + persistRatificationError
        // wiring carries through. `failureCode` covers the same surface as
        // the pre-Plan-163 inline throws (target_missing, target_skill_missing,
        // post_validation, eval_post_validation, eval_slug_missing, etc.)
        // plus the new graph_validator:<kind> codes from validateWorkflowGraph.
        const reason = mapTransformFailureToRatificationReason(transform.failureCode);
        const failedOp =
          transform.failedOpIndex !== undefined
            ? (stagedChange.proposal.ops[transform.failedOpIndex]?.op ?? 'unknown')
            : 'apply';
        throw new RatificationApplyError(failedOp, transform.failureDetail, reason);
      }

      // Persist only artifacts an op actually mutated. A manifest-only edit
      // loads the workflow + target eval suite for re-validation but must not
      // rewrite them (no revision bump, no spurious snapshot).
      if (workflowOps.length > 0 && transform.candidateWorkflow && workflow && targetSlug) {
        await persistCandidateWorkflow(
          ctx,
          txRepo,
          targetSlug,
          workflow,
          transform.candidateWorkflow,
        );
        result.newRevision = transform.candidateWorkflow.revision;
      }
      for (const [slug, candidateSuite] of transform.candidateEvalSuites) {
        if (!evalOpSlugs.has(slug)) continue;
        await persistCandidateEvalSuite(ctx, txRepo, slug, candidateSuite);
      }
      if (transform.manifestChanged && transform.candidateManifest && manifestSkillId) {
        await persistCandidateManifest(ctx, txRepo, manifestSkillId, transform.candidateManifest);
      }
      result.appliedOps.push(...transform.appliedOps);
      if (transform.appliedOps.length > 0) {
        result.applied = true;
      }
    }
  });

  if (result.applied) {
    logger.info(
      `[applyRatifiedOps] Applied ${String(result.appliedOps.length)} ops for ` +
        `proposal ${stagedChange.id} (slug=${targetSlug ?? 'n/a'})`,
    );
  }

  return result;
}

// ============================================================================
// Persistence — I/O wrappers around the shared pure transform.

async function persistCandidateWorkflow(
  ctx: ApplyContext,
  repo: ReturnType<typeof createMemoryDocRepository>,
  slug: string,
  priorWorkflow: Workflow,
  candidateWorkflow: Workflow,
): Promise<void> {
  const path = workflowDocPath(slug);
  const priorRevision = priorWorkflow.revision;

  // Re-parse the candidate (defense in depth — the shared transform
  // already validated, but persistence must not write an unparsed doc).
  const parseResult = WorkflowSchema.safeParse(candidateWorkflow);
  if (!parseResult.success) {
    throw new RatificationApplyError(
      'post_validation',
      `Persistence reparse failed: ${parseResult.error.message}`,
      'post_validation',
    );
  }

  await ensureWorkflowRevisionSnapshot({
    docRepo: repo,
    slug,
    revision: priorRevision,
    spaceId: ctx.spaceId,
    workflow: JSON.parse(JSON.stringify(priorWorkflow)) as Record<string, unknown>,
    actor: 'system:ratification-apply',
  });

  const updatedJson = JSON.stringify(parseResult.data, null, 2);
  const updatedBytes = Buffer.byteLength(updatedJson, 'utf8');
  await repo.put({
    path,
    writeMode: 'upsert' as const,
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: updatedJson,
    payloadRef: null,
    sizeBytes: updatedBytes,
    contentHash: '',
    preview: updatedJson.substring(0, 200),
    tags: ['workflow'],
    summary: `Workflow updated by ratification (rev ${String(parseResult.data.revision)})`,
    semanticType: 'workflow',
    indexing: 'disabled',
    scope: { spaceId: ctx.spaceId },
    provenance: { actor: 'system:ratification-apply' },
  });
}

const manifestDocPath = (skillId: string): string => `/skills/${skillId}/manifest.json`;

async function persistCandidateManifest(
  ctx: ApplyContext,
  repo: ReturnType<typeof createMemoryDocRepository>,
  skillId: string,
  candidateManifest: SkillManifest,
): Promise<void> {
  const parseResult = SkillManifestSchema.safeParse(candidateManifest);
  if (!parseResult.success) {
    throw new RatificationApplyError(
      'post_validation',
      `Manifest persistence reparse failed: ${parseResult.error.message}`,
      'post_validation',
    );
  }
  const updatedJson = JSON.stringify(parseResult.data, null, 2);
  await repo.put({
    path: manifestDocPath(skillId),
    writeMode: 'upsert' as const,
    docType: 'skill_manifest',
    mimeType: 'application/json',
    inlineContent: updatedJson,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(updatedJson, 'utf8'),
    contentHash: '',
    preview: updatedJson.substring(0, 200),
    tags: ['skill'],
    summary: null,
    indexing: 'disabled',
    scope: { spaceId: ctx.spaceId },
    provenance: { actor: 'system:ratification-apply' },
  });
}

async function persistCandidateEvalSuite(
  ctx: ApplyContext,
  repo: ReturnType<typeof createMemoryDocRepository>,
  slug: string,
  candidateSuite: CyberneticEvalSuite,
): Promise<void> {
  const parseResult = CyberneticEvalSuiteSchema.safeParse(candidateSuite);
  if (!parseResult.success) {
    throw new RatificationApplyError(
      'post_validation',
      `Eval suite persistence reparse failed: ${parseResult.error.message}`,
      'post_validation',
    );
  }
  const path = evalSuiteDocPath(slug);
  const updatedJson = JSON.stringify(parseResult.data, null, 2);
  const updatedBytes = Buffer.byteLength(updatedJson, 'utf8');
  await repo.put({
    path,
    writeMode: 'upsert' as const,
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: updatedJson,
    payloadRef: null,
    sizeBytes: updatedBytes,
    contentHash: '',
    preview: updatedJson.substring(0, 200),
    tags: ['eval', 'suite'],
    summary: `Eval suite updated by ratification`,
    semanticType: 'eval_suite',
    indexing: 'disabled',
    scope: { spaceId: ctx.spaceId },
    provenance: { actor: 'system:ratification-apply' },
  });
}

/**
 * Translate a shared-transform `failureCode` to the closest matching
 * `RatificationApplyReason`. Codes the transform emits today:
 *   - target_missing                       → target_skill_missing
 *   - eval_target_missing                  → target_skill_missing
 *   - target_skill_missing                 → target_skill_missing
 *   - workflow_not_found                   → workflow_not_found
 *   - post_validation                      → post_validation
 *   - eval_post_validation                 → post_validation
 *   - eval_slug_missing                    → post_validation
 *   - graph_validator:<kind>               → post_validation
 *   - op_apply_error / preview_impure / …  → transient
 */
function mapTransformFailureToRatificationReason(code: string): RatificationApplyReason {
  if (code === 'workflow_not_found') return 'workflow_not_found';
  if (
    code === 'target_missing' ||
    code === 'target_skill_missing' ||
    code === 'eval_target_missing'
  ) {
    return 'target_skill_missing';
  }
  if (
    code === 'post_validation' ||
    code === 'eval_post_validation' ||
    code === 'eval_slug_missing' ||
    code === 'manifest_post_validation' ||
    code === 'manifest_apply_error' ||
    code.startsWith('graph_validator') ||
    code.startsWith('campaign_ref')
  ) {
    return 'post_validation';
  }
  return 'transient';
}
