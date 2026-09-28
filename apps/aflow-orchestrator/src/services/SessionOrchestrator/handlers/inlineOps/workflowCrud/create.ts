import { randomUUID } from 'node:crypto';
import { getDatabase, workflowDocPath } from '@aflow/database';
import type { Workflow, WorkflowPutInput } from '@aflow/schemas';
import {
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

  const existing = await readJsonDoc<Workflow>(docRepo, workflowDocPath(slug), spaceId);
  if (existing) {
    await emitStepError(
      args,
      'WORKFLOW_ALREADY_EXISTS',
      `Workflow "${slug}" already exists, and workflow.manage.put only creates. Change it with workflow.manage.patch: a definition change becomes a proposal the operator ratifies.`,
      startTime,
      'validation',
    );
    return;
  }
  const archived = await docRepo.getByPath(workflowDocPath(slug), spaceId, {
    includeDeleted: true,
  });
  if (archived) {
    await emitStepError(
      args,
      'WORKFLOW_ARCHIVED',
      `Workflow "${slug}" belongs to an archived skill, and creating it again would overwrite that skill's definition. Choose another slug, or ask the operator to restore the archived skill.`,
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
    runInputs: input.runInputs,
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

  const now = new Date().toISOString();
  const workflow: Workflow = {
    id: randomUUID(),
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
    revision: 1,
    status: 'draft',
    ...(input.activation ? { activation: input.activation } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await writeJsonDoc(
    docRepo,
    dirRepo,
    workflowDocPath(slug),
    workflow as unknown as Record<string, unknown>,
    'json',
    spaceId,
    'create',
    'workflow_overview',
  );
  await dirRepo.mkdir({ path: `${workflowPath(slug)}/revisions`, scope: { spaceId } });
  await dirRepo.mkdir({ path: `${workflowPath(slug)}/runs`, scope: { spaceId } });

  await emitStepSuccess(
    args,
    {
      id: workflow.id,
      slug,
      revision: workflow.revision,
      status: workflow.status,
      path: workflowDocPath(slug),
    },
    startTime,
  );
}
