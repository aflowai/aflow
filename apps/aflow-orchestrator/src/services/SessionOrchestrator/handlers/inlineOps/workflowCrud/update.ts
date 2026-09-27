import { randomUUID } from 'node:crypto';
import { getDatabase, workflowDocPath } from '@aflow/database';
import type {
  Workflow,
  WorkflowPatchInput,
  StagedChange,
  StagedChangeOp,
  SkillManifest,
} from '@aflow/schemas';
import { WorkflowSchema } from '@aflow/schemas';
import { applyJsonPatch, JsonPatchError } from '@aflow/lib';
import {
  runWorkflowProposalValidations,
  isProposalReadinessSafe,
  proposalReadinessWarningCount,
  proposalReadinessBlockerCount,
  loadProposalValidationSnapshot,
  computeProposalPreconditions,
  resolveProposalRoute,
  listActiveRuns,
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
  resolveCampaignManifestParams,
  resolveSkillForWorkflow,
} from '@aflow/cybernetic-runtime';
import {
  convertWorkflowPatchToStagedOps,
  convertManifestPatchToStagedOps,
  isManifestPatchOp,
  type ManifestPatchDoc,
} from '../workflowPatchToStagedOps.js';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess, emitStepError } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import { getRepos, readJsonDoc, writeJsonDoc } from './shared.js';
import { patchTouchesDefinition, patchTouchesMetadata } from './validators.js';

export async function handleWorkflowPatch(
  args: InlineHandlerArgs,
  input: WorkflowPatchInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getRepos(args.context.tenantId);

  const slug = input.slug;

  const existing = await readJsonDoc<Workflow>(docRepo, workflowDocPath(slug), spaceId);
  if (!existing) {
    await emitStepError(
      args,
      'WORKFLOW_NOT_FOUND',
      `No workflow found with slug "${slug}".`,
      startTime,
      'validation',
    );
    return;
  }

  if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    await emitStepError(
      args,
      'WORKFLOW_REVISION_CONFLICT',
      `Expected revision ${String(input.expectedRevision)} but current is ${String(existing.revision)}. Reload and retry.`,
      startTime,
      'validation',
    );
    return;
  }

  // `/goal` + `/campaign/...` paths target the manifest, not the workflow doc.
  // Partition so the workflow patch never sees them (it would fail to resolve
  // a path that isn't on the workflow), and lower them to manifest ops below.
  const manifestRfcOps = input.operations.filter(isManifestPatchOp);
  const workflowRfcOps = input.operations.filter((op) => !isManifestPatchOp(op));

  // Apply the workflow-targeting patch. Shared util deep-clones + validates.
  let patched: Workflow;
  try {
    patched = applyJsonPatch<Workflow>(existing, workflowRfcOps);
  } catch (err) {
    const message =
      err instanceof JsonPatchError
        ? `Patch failed: ${err.message}` +
          (err.opPath ? ` (op ${String(err.opIndex ?? '?')} at ${err.opPath})` : '')
        : err instanceof Error
          ? err.message
          : String(err);
    await emitStepError(args, 'WORKFLOW_PATCH_INVALID', message, startTime, 'validation');
    return;
  }

  // Re-parse the patched workflow through WorkflowSchema to enforce all
  // Zod constraints (field types, inputBindings shape, stateVariables, etc.).
  // This prevents malformed fields from surviving a JSON Patch write.
  const patchedParse = WorkflowSchema.safeParse(patched);
  if (!patchedParse.success) {
    await emitStepError(
      args,
      'WORKFLOW_PATCH_INVALID',
      `Patched workflow fails schema validation: ${patchedParse.error.message}`,
      startTime,
      'validation',
    );
    return;
  }
  const validatedPatched = patchedParse.data;

  // Metadata-only vs definition-touching split, computed up front: it routes
  // the patch below AND scopes the campaign-rule inputs (only a definition
  // patch can move outcomes, and only that branch gates on `validity`, so the
  // manifest read is skipped for metadata-only patches).
  const touchesDef = patchTouchesDefinition(input.operations);
  const touchesMeta = patchTouchesMetadata(input.operations);

  const campaign = touchesDef
    ? await resolveCampaignManifestParams(
        { db: getDatabase(), tenantId: args.context.tenantId as string, spaceId },
        slug,
      )
    : undefined;

  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: validatedPatched.tasks,
    stateVariables: validatedPatched.stateVariables,
    output: validatedPatched.output,
    runInputs: validatedPatched.runInputs,
    ...(campaign ? { campaign: { ...campaign, outcomes: validatedPatched.outcomes } } : {}),
  });
  // A metadata-only patch must persist the AUTHORED tasks, not the re-materialized
  // form: persisting re-materialized tasks at the same revision drifts the stored
  // definition from the pinned run-start snapshot (extractDefinitionEssence compares
  // tasks), so run.start hard-fails for a non-platform (bundle/cloned) skill.
  if (touchesDef) {
    validatedPatched.tasks = materializedTasks;
  }

  // Guard immutable identity fields.
  if (validatedPatched.slug !== existing.slug || validatedPatched.id !== existing.id) {
    await emitStepError(
      args,
      'WORKFLOW_PATCH_INVALID',
      'Patch may not change the workflow slug or id. Use workflow.manage.put for a rename.',
      startTime,
      'validation',
    );
    return;
  }

  // ------------------------------------------------------------------------

  if (touchesDef && touchesMeta) {
    await emitStepError(
      args,
      'WORKFLOW_PATCH_MIXED',
      'A single patch may not mix metadata (status, budget, name, description, assignedAgent, taskAssignments) with definition fields (tasks, outcomes, iteration, stateVariables, activation, origin). Split into two separate workflow.manage.patch calls.',
      startTime,
      'validation',
    );
    return;
  }

  if (!touchesDef) {
    // Metadata-only direct mutation (status, budget, name, description,
    const now = new Date().toISOString();
    const updated: Workflow = {
      ...validatedPatched,
      revision: existing.revision,
      updatedAt: now,
      createdAt: existing.createdAt,
    };

    await writeJsonDoc(
      docRepo,
      dirRepo,
      workflowDocPath(slug),
      updated as unknown as Record<string, unknown>,
      'json',
      spaceId,
      'overwrite',
      'workflow_overview',
    );

    let activeRunWarning: string | undefined;
    {
      const dbMetadata = getDatabase();
      const activeRuns = await listActiveRuns(
        dbMetadata,
        args.context.tenantId as string,
        spaceId,
        { limit: 1 },
      );
      if (activeRuns.length > 0) {
        const activeRun = activeRuns[0]!;
        activeRunWarning =
          `Note: active run ${activeRun.runId} still uses revision ${String(existing.revision)}. ` +
          `This patch applies to future runs.`;
      }
    }

    const result: Record<string, unknown> = {
      id: updated.id,
      slug,
      revision: updated.revision,
      status: updated.status,
      applied: input.operations.map((op) => ({ op: op.op, path: op.path })),
    };
    if (activeRunWarning) {
      result['warning'] = activeRunWarning;
    }

    await emitStepSuccess(args, result, startTime);
    return;
  }

  // ------------------------------------------------------------------------
  // Definition-touching patches go through the proposal pipeline.
  //
  // Convert the agent's RFC 6902 ops to typed StagedChangeOps, run the
  // validation runner, and persist a `workflow_refinement` proposal with
  // `source: 'agent_patch'`. The operator HTTP PATCH route (apps/server)
  // still mutates directly — that's the emergency-intervention escape hatch.
  // ------------------------------------------------------------------------

  if (validity.status === 'invalid') {
    await emitStepError(
      args,
      'GRAPH_INVALID',
      `Workflow validation failed after patch:\n${renderSkillDiagnostics(validity.diagnostics)}`,
      startTime,
      'validation',
      false,
      { diagnostics: validity.diagnostics },
    );
    return;
  }

  // Goal/campaign edits lower to manifest ops against the live manifest.
  let manifest: SkillManifest | null = null;
  if (manifestRfcOps.length > 0) {
    const skill = await resolveSkillForWorkflow(
      { db: getDatabase(), tenantId: args.context.tenantId as string, spaceId },
      slug,
    );
    manifest = skill?.manifest ?? null;
    if (!manifest) {
      await emitStepError(
        args,
        'WORKFLOW_PATCH_UNSUPPORTED',
        `Cannot patch /goal or /campaign — no skill manifest is associated with workflow "${slug}".`,
        startTime,
        'validation',
      );
      return;
    }
  }

  const workflowConversion = convertWorkflowPatchToStagedOps(workflowRfcOps, existing);
  const manifestConversion =
    manifest && manifestRfcOps.length > 0
      ? convertManifestPatchToStagedOps(manifestRfcOps, {
          goal: manifest.goal,
          ...(manifest.campaign ? { campaign: manifest.campaign } : {}),
        } satisfies ManifestPatchDoc)
      : { ops: [] as StagedChangeOp[], unsupported: [] as string[] };
  const conversion = {
    ops: [...workflowConversion.ops, ...manifestConversion.ops],
    unsupported: [...workflowConversion.unsupported, ...manifestConversion.unsupported],
  };
  if (conversion.unsupported.length > 0) {
    const detail = conversion.unsupported.join('\n');
    await emitStepError(
      args,
      'WORKFLOW_PATCH_UNSUPPORTED',
      `One or more patch ops cannot be expressed as a workflow_refinement proposal:\n${detail}`,
      startTime,
      'validation',
    );
    return;
  }
  if (conversion.ops.length === 0) {
    await emitStepError(
      args,
      'WORKFLOW_PATCH_INVALID',
      'No supported ops after conversion. Nothing to propose.',
      startTime,
      'validation',
    );
    return;
  }

  // Run the validation runner against the proposed final state. The runner
  // never throws; results land on `proposal.validations` for the operator's
  // proposal card to render as a checklist.
  const db = getDatabase();
  const snapshot = await loadProposalValidationSnapshot({
    db,
    tenantId: args.context.tenantId as string,
    spaceId,
  });
  const validations = runWorkflowProposalValidations(validatedPatched, snapshot, campaign);

  // Active-run advisory — surface to the operator on the proposal card via
  // rationale text; not load-bearing for the proposal itself.
  let activeRunWarning: string | undefined;
  {
    const activeRuns = await listActiveRuns(db, args.context.tenantId as string, spaceId, {
      limit: 1,
    });
    if (activeRuns.length > 0) {
      const activeRun = activeRuns[0]!;
      activeRunWarning = `Note: active run ${activeRun.runId} still uses revision ${String(existing.revision)}.`;
    }
  }

  const now = new Date().toISOString();
  const proposalId = randomUUID();
  const resolutionRoute = resolveProposalRoute({
    targetSlug: slug,
    ops: conversion.ops,
  });
  // computeProposalPreconditions only inspects `ops` for subtree hashing —
  // summary/rationale/confidence are dummy passthroughs to satisfy the
  // typed proposal shape.
  const proposalShape = {
    kind: 'workflow_refinement' as const,
    targetWorkflowSlug: slug,
    proposal: {
      summary: '',
      rationale: '',
      confidence: 'medium' as const,
      ops: conversion.ops,
    },
  };
  const preconditions = computeProposalPreconditions(proposalShape, {
    workflow: existing,
    evalSuites: new Map(),
    manifest,
  });

  const overallSafe = isProposalReadinessSafe(validations);
  const rationale = [
    `Agent ${args.context.runId} proposed ${String(conversion.ops.length)} patch op(s) against workflow "${slug}".`,
    ...(activeRunWarning ? [activeRunWarning] : []),
    ...(!overallSafe
      ? ['One or more hard checks failed — review the validations block before ratifying.']
      : []),
  ].join('\n');

  const stagedChange: StagedChange = {
    id: proposalId,
    kind: 'workflow_refinement',
    source: 'agent_patch',
    status: 'proposed',
    targetWorkflowSlug: slug,
    proposal: {
      summary: `Agent-initiated patch (${String(conversion.ops.length)} op(s)) for "${slug}"`,
      rationale,
      confidence: 'medium',
      ops: conversion.ops,
      validations,
    },
    evidence: {
      sourceSessionIds: [args.context.runId],
    },
    authorityLevel: 'require_operator',
    resolutionRoute,
    proposedAt: now,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    coachSessionId: args.context.runId,
    rebaseState: 'clean',
    pinnedRevision: existing.revision,
    preconditions,
  };

  const proposalDir =
    resolutionRoute === 'platform_issue' ? '/coach/platform-issues' : '/coach/staged';
  await writeJsonDoc(
    docRepo,
    dirRepo,
    `${proposalDir}/${proposalId}.json`,
    stagedChange as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'create',
    'staged_change',
  );

  // Best-effort entity event so the proposal surfaces on the Coach board.
  try {
    const { appendEntityEvent } = await import('@aflow/redis');
    await appendEntityEvent(args.redis, {
      tenantId: args.context.tenantId,
      spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.coach.proposal',
        spaceId,
        tenantId: args.context.tenantId,
        timestamp: Date.now(),
        causedBySessionId: args.context.runId,
        causedByStepExecutionId: args.stepExecutionId,
        payload: {
          stagedChangeId: proposalId,
          targetSlug: slug,
          authorityLevel: 'require_operator',
          resolutionRoute,
          confidence: 'medium',
          opCount: conversion.ops.length,
          source: 'agent_patch',
          overallSafe,
        },
        summary: `Agent proposed ${String(conversion.ops.length)} change(s) to workflow "${slug}" (route: ${resolutionRoute}, overallSafe: ${String(overallSafe)})`,
      },
    });
  } catch {
    // Best-effort event emission; missing event must not fail the proposal.
  }

  await emitStepSuccess(
    args,
    {
      proposalId,
      slug,
      status: 'proposed',
      kind: 'workflow_refinement',
      opCount: conversion.ops.length,
      validations: {
        overallSafe,
        contractStatus: validations.contract.status,
        blockerCount: proposalReadinessBlockerCount(validations),
        warningCount: proposalReadinessWarningCount(validations),
      },
      ...(activeRunWarning ? { warning: activeRunWarning } : {}),
    },
    startTime,
  );
}
