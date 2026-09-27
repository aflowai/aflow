import { randomUUID } from 'node:crypto';
import { getDatabase, workflowDocPath, ensureWorkflowRevisionSnapshot } from '@aflow/database';
import type { Workflow, WorkflowPutInput } from '@aflow/schemas';
import {
  listActiveRuns,
  materializeAndValidateSkillConfig,
  renderSkillDiagnostics,
  resolveCampaignManifestParams,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../types.js';
import { emitStepSuccess, emitStepError } from '../helpers.js';
import { requireSpaceId } from '../spaceScope.js';
import { getRepos, readJsonDoc, writeJsonDoc, workflowPath } from './shared.js';

export async function handleWorkflowPut(
  args: InlineHandlerArgs,
  input: WorkflowPutInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const { docRepo, dirRepo } = getRepos(args.context.tenantId);

  const slug = input.slug;
  const writeMode = input.writeMode;

  const existing = await readJsonDoc<Workflow>(docRepo, workflowDocPath(slug), spaceId);

  if (writeMode === 'create' && existing) {
    await emitStepError(
      args,
      'WORKFLOW_ALREADY_EXISTS',
      `Workflow with slug "${slug}" already exists. Use writeMode="upsert" to replace it, or workflow.manage.patch for targeted edits.`,
      startTime,
      'validation',
    );
    return;
  }
  if (writeMode === 'overwrite' && !existing) {
    await emitStepError(
      args,
      'WORKFLOW_NOT_FOUND',
      `No workflow found with slug "${slug}". Use writeMode="upsert" or "create" to create a new one.`,
      startTime,
      'validation',
    );
    return;
  }

  // Optimistic concurrency
  if (
    existing &&
    input.expectedRevision !== undefined &&
    existing.revision !== input.expectedRevision
  ) {
    await emitStepError(
      args,
      'WORKFLOW_REVISION_CONFLICT',
      `Expected revision ${String(input.expectedRevision)} but current is ${String(existing.revision)}. Reload and retry.`,
      startTime,
      'validation',
    );
    return;
  }

  const campaign = await resolveCampaignManifestParams(
    { db: getDatabase(), tenantId: args.context.tenantId as string, spaceId },
    slug,
  );

  const { materializedTasks, validity } = materializeAndValidateSkillConfig({
    tasks: input.tasks,
    stateVariables: input.stateVariables,
    output: input.output,
    ...(campaign ? { campaign: { ...campaign, outcomes: input.outcomes } } : {}),
  });
  if (validity.status === 'invalid') {
    await emitStepError(
      args,
      'GRAPH_INVALID',
      `Workflow validation failed:\n${renderSkillDiagnostics(validity.diagnostics)}`,
      startTime,
      'validation',
      false,
      { diagnostics: validity.diagnostics },
    );
    return;
  }
  const tasks: Workflow['tasks'] = materializedTasks;

  // Active-run advisory — edits apply to the next run
  let activeRunWarning: string | undefined;
  if (existing) {
    const db = getDatabase();
    const activeRuns = await listActiveRuns(db, args.context.tenantId as string, spaceId, {
      limit: 1,
    });
    if (activeRuns.length > 0) {
      const activeRun = activeRuns[0]!;
      activeRunWarning =
        `Note: active run ${activeRun.runId} still uses revision ${String(existing.revision)}. ` +
        `This put creates revision ${String(existing.revision + 1)} for future runs.`;
    }
  }

  const now = new Date().toISOString();
  const isReplace = existing !== null;
  // Snapshot the old revision when replacing an already-approved workflow.
  const shouldSnapshot =
    isReplace &&
    existing.status === 'approved' &&
    input.status !== 'completed' &&
    input.status !== 'abandoned';

  const workflow: Workflow = {
    id: existing?.id ?? randomUUID(),
    slug,
    name: input.name,
    description: input.description ?? '',
    outcomes: input.outcomes,
    mode: input.mode,
    tasks,
    stateVariables: input.stateVariables,
    runInputs: input.runInputs,
    ...(input.output !== undefined ? { output: input.output } : {}),
    iteration: input.iteration ?? {
      auto: false,
      maxConsecutiveRuns: 5,
      stopOnOutcomesMet: true,
      cooldownMs: 0,
    },
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.assignedAgent !== undefined ? { assignedAgent: input.assignedAgent } : {}),
    ...(input.taskAssignments !== undefined ? { taskAssignments: input.taskAssignments } : {}),
    revision: shouldSnapshot ? existing.revision + 1 : (existing?.revision ?? 1),
    status: input.status,
    ...(input.activation ? { activation: input.activation } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (shouldSnapshot) {
    await ensureWorkflowRevisionSnapshot({
      docRepo,
      dirRepo,
      slug,
      revision: existing.revision,
      spaceId,
      workflow: existing as unknown as Record<string, unknown>,
      actor: 'system:workflow-put',
      // Tenant-authored definitions keep the strict 'throw' invariant; a
      // platform-origin def (in-code registry is source of truth) overwrites
      // its stale snapshot. See run/start.ts for the same rule.
      onDrift: existing.origin === 'platform' ? 'overwrite' : 'throw',
    });
  }

  await writeJsonDoc(
    docRepo,
    dirRepo,
    workflowDocPath(slug),
    workflow as unknown as Record<string, unknown>,
    'json',
    spaceId,
    isReplace ? 'overwrite' : 'create',
    'workflow_overview',
  );

  // Initialize subdirs on first write only.
  // Note: ledger.json no longer created — runs stored in relational tables (104c Phase 2).
  if (!isReplace) {
    await dirRepo.mkdir({ path: `${workflowPath(slug)}/revisions`, scope: { spaceId } });
    await dirRepo.mkdir({ path: `${workflowPath(slug)}/runs`, scope: { spaceId } });
  }

  const result: Record<string, unknown> = {
    id: workflow.id,
    slug,
    revision: workflow.revision,
    status: workflow.status,
    path: workflowDocPath(slug),
    created: !isReplace,
  };
  if (activeRunWarning) {
    result['warning'] = activeRunWarning;
  }

  await emitStepSuccess(args, result, startTime);
}
