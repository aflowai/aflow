import { Buffer } from 'node:buffer';
import { getDatabase } from '@aflow/database';
import type {
  ContractError,
  StoredParentInstructions,
  StoredParentTaskInputs,
  Workflow,
  WorkflowTask,
} from '@aflow/schemas';
import {
  inferTaskType,
  isCustomAgentRef,
  StoredParentInstructionsSchema,
  StoredParentTaskInputsSchema,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import {
  buildRunnerDelegationContext,
  getCampaignById,
  getRunCampaignId,
  loadRunById,
  parseOutputPath,
  renderLearningSetBlock,
  resolveRunnerModelHot,
  resolveRunnerReasoningHot,
  type CachedSpaceContextState,
  deriveEffectiveOutputSchema,
  DeriveSchemaError,
  resolveArtifactBinding,
  resolveConnectionGrantsToBinding,
  selectActiveLearningSetForRun,
} from '@aflow/cybernetic-runtime';
import type { WorkflowRunDetail } from '@aflow/cybernetic-runtime';
import { resolveTaskInputs } from '../SessionOrchestrator/handlers/inlineOps/resolveTaskInputs.js';
import { getOrchestratorLogger } from '../../lib/orchestratorLogger.js';

export async function resolveOperationTaskInputs(
  task: WorkflowTask,
  tenantId: string,
  spaceId: string,
  runId: string,
  payloadStore?: PayloadStore,
  /** Typed ContractError injected into the `system_feedback` binding on a producer rerun. */
  systemFeedback?: ContractError,
): Promise<Record<string, unknown>> {
  const base = { ...(task.inputs ?? {}) };
  const bindings = task.inputBindings;
  const hasBindings = bindings !== undefined && Object.keys(bindings).length > 0;
  if (!hasBindings && task.inputTemplate === undefined) return base;

  const db = getDatabase();
  const run = await loadRunById(db, tenantId, spaceId, runId);
  if (!run) {
    throw new Error(
      `resolveOperationTaskInputs: workflow run ${runId} not found for task=${task.taskId}`,
    );
  }
  const campaignConfig = await loadCampaignConfigForTask(db, tenantId, run, task);
  // Operation tasks (e.g. code.agent.run / push / open-pr) bind `run_input`
  // too — resolve them against the run-level input pool, the same way the
  // runner path does. Without this, any operation task past the first one
  // fails input resolution with "no run_input is available".
  const runInputPool = extractParentTaskInputs(run.metadata)?.inputs ?? null;
  const runInputSnapshot =
    bindings && runInputPool ? buildRunInputSnapshotFromParent(bindings, runInputPool) : undefined;
  // The run's pinned GitHub connection (set at run start for coding runs).
  // Threaded symmetrically with campaignConfig; `connection_binding` bindings
  // resolve against it and fail closed when it is absent.
  const connectionBindingId = extractConnectionBindingId(run.metadata);
  return resolveTaskInputs(task, {
    run,
    ...(payloadStore ? { payloadStore } : {}),
    ...(runInputSnapshot ? { runInput: runInputSnapshot } : {}),
    ...(campaignConfig !== undefined ? { campaignConfig } : {}),
    ...(connectionBindingId !== undefined ? { connectionBindingId } : {}),
    ...(systemFeedback ? { systemFeedback } : {}),
    resolveArtifactBinding: ({ bundleId, bindingId }) =>
      resolveArtifactBinding(db, { tenantId, spaceId, bundleId, bindingId }),
    resolveLearningSet: makeLearningSetResolver(db, tenantId, run),
  });
}

/**
 * Close over the run row's identity (space + skill) so a `learning_set`
 * binding reads the selector with the consuming task's id as the targeting
 * filter, rendered with the same formatter the Runner delegation path uses.
 */
function makeLearningSetResolver(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  run: WorkflowRunDetail,
): (args: { taskId: string }) => Promise<string> {
  return async ({ taskId }) => {
    const { selected } = await selectActiveLearningSetForRun({
      db,
      tenantId,
      spaceId: run.spaceId,
      skillSlug: run.workflowSlug,
      runId: run.runId,
      taskId,
    });
    return renderLearningSetBlock(selected);
  };
}

/** Narrow `workflow_runs.metadata.connectionBindingId` (the run-start pin). */
function extractConnectionBindingId(runMetadata: unknown): string | undefined {
  if (runMetadata === null || runMetadata === undefined || typeof runMetadata !== 'object') {
    return undefined;
  }
  const raw = (runMetadata as Record<string, unknown>)['connectionBindingId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Narrow `workflow_runs.metadata.evalCampaignConfig` (the launcher's pin). */
function extractEvalCampaignConfig(runMetadata: unknown): Record<string, unknown> | undefined {
  if (runMetadata === null || runMetadata === undefined || typeof runMetadata !== 'object') {
    return undefined;
  }
  const raw = (runMetadata as Record<string, unknown>)['evalCampaignConfig'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

async function loadCampaignConfigForTask(
  db: ReturnType<typeof getDatabase>,
  tenantId: string,
  run: WorkflowRunDetail,
  task: WorkflowTask,
): Promise<Record<string, unknown> | undefined> {
  const bindings = task.inputBindings;
  if (!bindings) return undefined;
  const needsCampaign = Object.values(bindings).some((b) => b.kind === 'campaign_input');
  if (!needsCampaign) return undefined;
  // Frozen trial (Plan 269 D5): campaign_input resolves from the case's
  // pinned config — never the live campaign row, which is mutable
  // mid-batch and would make trials incomparable. This is the same source
  // the trial grader resolves $campaign expectation params against.
  if (typeof run.evalBatchId === 'string') {
    return extractEvalCampaignConfig(run.metadata) ?? {};
  }
  const campaignId = await getRunCampaignId(db, tenantId, run.runId);
  if (!campaignId) return undefined;
  const campaign = await getCampaignById(db, tenantId, campaignId);
  if (!campaign) return undefined;
  return campaign.config ?? {};
}

export async function buildTaskInputRef(
  task: WorkflowTask,
  workflow: Workflow,
  tenantId: string,
  spaceId: string,
  runId: string,
  payloadStore?: PayloadStore,
  /** Typed ContractError injected into the `system_feedback` binding on a producer rerun. */
  systemFeedback?: ContractError,
): Promise<string> {
  const taskType = inferTaskType(task);

  if (taskType === 'human') {
    const humanInput = {
      prompt: task.pauseInstruction ?? `Please provide input for: ${task.name}`,
    };
    return `inline:${Buffer.from(JSON.stringify(humanInput)).toString('base64')}`;
  }

  if (taskType === 'operation') {
    const opInput = await resolveOperationTaskInputs(
      task,
      tenantId,
      spaceId,
      runId,
      payloadStore,
      systemFeedback,
    );
    return `inline:${Buffer.from(JSON.stringify(opInput)).toString('base64')}`;
  }

  throw new Error(
    `[taskHelpers] agent task '${task.taskId}' has no input ref — build its Runner input via buildDelegateTaskInput`,
  );
}

export interface DelegateTaskInput {
  agentId: string;
  input: string;
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  validatorRefs?: string[];
  displayMeta: { workflowSlug: string; taskId: string; taskName: string };
}

/**
 * Build an agent task's Runner delegate input, returned as a value — never
 * encoded as one payload. Dispatch encodes only `{ input, config }` as the
 * Runner's input ref (spilling to the payload store when oversized) and
 * stamps the remaining fields onto structured Runner hot-state fields, so
 * the full envelope never lands on task rows, streams, or storage.
 */
export async function buildDelegateTaskInput(
  task: WorkflowTask,
  workflow: Workflow,
  tenantId: string,
  spaceId: string,
  runId: string,
  /** 104f: delegation context from the Helmsman, injected into Runner prompt. */
  delegationContextJson?: string,
  /**
   * The Helmsman's cached SpaceContext and the generation live at dispatch.
   * One argument because a cache is only usable together with the generation it
   * is checked against — passing the snapshot alone would serve a directive the
   * operator has already changed to the very Runner the change was made for.
   */
  spaceContextCache?: { cached: CachedSpaceContextState; currentGen: number },
  payloadStore?: PayloadStore,
  runMetadata?: unknown,
  priorFailures?: unknown,
  /** Typed ContractError injected into the `system_feedback` binding on a producer rerun. */
  systemFeedback?: ContractError,
): Promise<DelegateTaskInput> {
  const targetAgent = task.agent ?? workflow.assignedAgent ?? 'cybernetic-runner';

  const db = getDatabase();
  const runnerModel = await resolveRunnerModelHot({
    taskModel: task.model,
    sessionState: spaceContextCache?.cached,
    ...(spaceContextCache ? { currentGen: spaceContextCache.currentGen } : {}),
    db,
    tenantId,
    spaceId,
  });
  const runnerReasoningEffort = await resolveRunnerReasoningHot({
    // No per-task reasoning override yet (would be `task.reasoningEffort` once
    // the WorkflowTask schema gains the field). Pure space-directive fallthrough today.
    taskReasoning: undefined,
    sessionState: spaceContextCache?.cached,
    ...(spaceContextCache ? { currentGen: spaceContextCache.currentGen } : {}),
    db,
    tenantId,
    spaceId,
  });

  const parentTaskInputs = extractParentTaskInputs(runMetadata);
  const parentInputsForThisTask =
    parentTaskInputs?.taskId === task.taskId ? parentTaskInputs.inputs : null;
  // Run inputs are a run-level pool every task's `run_input` bindings resolve
  // against — not just the first task. The `taskId` on parentTaskInputs only
  // records which task they were validated against at start; later tasks
  // (e.g. push/open-pr) legitimately bind run inputs too. The raw spread below
  // stays first-task-only — that is the distinct parent→child-first-task
  // typed-input contract.
  const runInputPool = parentTaskInputs?.inputs ?? null;

  const bindings = task.inputBindings;
  let typedTaskInputs: Record<string, unknown> = {};
  if (bindings && Object.keys(bindings).length > 0) {
    const fullRun = await loadRunById(db, tenantId, spaceId, runId);
    if (!fullRun) {
      throw new Error(
        `[taskHelpers] typed-inputs pre-resolution: run ${runId} not found for task=${task.taskId}`,
      );
    }
    const runInputSnapshot = runInputPool
      ? buildRunInputSnapshotFromParent(bindings, runInputPool)
      : undefined;
    const campaignConfig = await loadCampaignConfigForTask(db, tenantId, fullRun, task);
    typedTaskInputs = await resolveTaskInputs(task, {
      run: fullRun,
      ...(payloadStore ? { payloadStore } : {}),
      ...(runInputSnapshot ? { runInput: runInputSnapshot } : {}),
      ...(campaignConfig !== undefined ? { campaignConfig } : {}),
      ...(systemFeedback ? { systemFeedback } : {}),
      resolveArtifactBinding: ({ bundleId, bindingId }) =>
        resolveArtifactBinding(db, { tenantId, spaceId, bundleId, bindingId }),
      resolveLearningSet: makeLearningSetResolver(db, tenantId, fullRun),
    });
  }

  if (parentInputsForThisTask) {
    typedTaskInputs = { ...typedTaskInputs, ...parentInputsForThisTask };
  }

  const wdc = await buildRunnerDelegationContext({
    tenantId,
    spaceId,
    workflowSlug: workflow.slug,
    task: {
      taskId: task.taskId,
      name: task.name,
      goal: task.goal,
      ...(task.outputContract
        ? {
            outputContract: {
              ...(task.outputContract.metrics != null
                ? { metrics: task.outputContract.metrics }
                : {}),
              ...(task.outputContract.artifacts != null
                ? { artifacts: task.outputContract.artifacts }
                : {}),
              ...(task.outputContract.schema != null ? { schema: task.outputContract.schema } : {}),
            },
          }
        : {}),
    },
    ...(task.context ? { contextSpec: task.context } : {}),
    runId,
    runnerModel,
    ...(runnerReasoningEffort !== undefined ? { runnerReasoningEffort } : {}),
    db,
    taskInputs: typedTaskInputs,
  });

  // A coding campaign pins its GitHub connection on the run at start (Plan 222
  // P3). An agent task (e.g. pr-shepherd `rehydrate`) reaches GitHub via granted
  // virtual tools whose binding is the grant's `binding` ref; resolve every grant
  // deferred to the run's connection (`binding.kind === 'connection'`) to the
  // pinned connection so the read tools resolve to the campaign's account. No pin
  // ⇒ the connection ref stays unresolved and the dispatch parser withholds the
  // tools (fail closed) rather than scope-resolving an arbitrary account.
  if (wdc.capabilityGrants?.integrations && wdc.capabilityGrants.integrations.length > 0) {
    const connectionBindingId = extractConnectionBindingId(runMetadata);
    if (connectionBindingId !== undefined) {
      wdc.capabilityGrants = {
        ...wdc.capabilityGrants,
        integrations: resolveConnectionGrantsToBinding(
          wdc.capabilityGrants.integrations,
          connectionBindingId,
        ),
      };
    }
  }

  if (task.outputContract?.derivedFrom && task.outputContract.derivedFrom.length > 0) {
    if (!payloadStore) {
      getOrchestratorLogger().warn(
        `[taskHelpers] task=${task.taskId} declares derivedFrom but buildTaskInputRef was called without payloadStore — skipping derivation. Cross-task validation will be inactive for this task.`,
      );
    } else {
      try {
        const derived = await deriveEffectiveOutputSchema({
          tenantId,
          spaceId,
          runId,
          task: {
            taskId: task.taskId,
            outputContract: {
              ...(task.outputContract.schema != null ? { schema: task.outputContract.schema } : {}),
              derivedFrom: task.outputContract.derivedFrom,
            },
          },
          db,
          payloadStore,
        });
        if (derived.effectiveSchema) {
          wdc.outputSchema = derived.effectiveSchema;
        }
        getOrchestratorLogger().info(
          `[taskHelpers] Derived effective schema for task=${task.taskId}: bindings=${String(derived.resolvedBindings.length)} hash=${derived.effectiveSchemaHash?.slice(0, 12) ?? 'none'}`,
        );
      } catch (err) {
        if (err instanceof DeriveSchemaError) {
          getOrchestratorLogger().warn(
            `[taskHelpers] derivedFrom failed for task=${task.taskId} bindingId=${err.bindingId ?? '<unspecified>'}: ${err.code} — ${err.message}`,
          );
        }
        throw err;
      }
    }
  }

  // 104n: Build EffectiveTaskToolManifest — immutable evidence record.
  const effectiveManifest = {
    taskId: task.taskId,
    runId,
    generatedAt: new Date().toISOString(),
    operations: wdc.runnerTools.map((op) => ({
      operationId: op,
      agentTool: true,
    })),
    apiEndpoints: (wdc.capabilityGrants?.integrations ?? [])
      .filter((g) => g.sourceKind === 'api')
      .flatMap((grant) => {
        // A grant still deferred to the run's connection (`binding.kind ===
        // 'connection'`) means no pin reached — its tools are withheld at
        // dispatch, so it contributes nothing to the effective manifest.
        if (grant.binding.kind !== 'binding') return [];
        const bindingId = grant.binding.bindingId;
        return grant.allTools
          ? [
              {
                capabilityId: grant.capabilityId,
                bindingId,
                apiId: grant.integrationId,
                endpointId: '*',
                toolName: `${grant.integrationId}.*`,
                broadGrant: true,
              },
            ]
          : grant.toolNames.map((t) => ({
              capabilityId: grant.capabilityId,
              bindingId,
              apiId: grant.integrationId,
              endpointId: t.toolName,
              revision: t.revision,
              schemaHash: t.schemaHash,
              toolName: `${grant.integrationId}.${t.toolName}`,
              broadGrant: false,
            }));
      }),
    mcpTools: (wdc.capabilityGrants?.integrations ?? [])
      .filter((g) => g.sourceKind === 'mcp')
      .flatMap((grant) => {
        if (grant.binding.kind !== 'binding') return [];
        const bindingId = grant.binding.bindingId;
        return grant.allTools
          ? [
              {
                capabilityId: grant.capabilityId,
                bindingId,
                serverId: grant.integrationId,
                toolName: `${grant.integrationId}.*`,
                broadGrant: true,
              },
            ]
          : grant.toolNames.map((t) => ({
              capabilityId: grant.capabilityId,
              bindingId,
              serverId: grant.integrationId,
              toolName: t.toolName,
              schemaHash: t.schemaHash,
              broadGrant: false,
            }));
      }),
  };

  const promptParts = [wdc.runnerSystemPrompt];

  // 104f: inject the Helmsman's delegation context so the Runner knows
  // what the user originally asked for.
  if (delegationContextJson) {
    try {
      const dc = JSON.parse(delegationContextJson) as Record<string, unknown>;
      const dcParts: string[] = [];
      if (dc['objective'] && typeof dc['objective'] === 'string') {
        dcParts.push(`OBJECTIVE: ${dc['objective']}`);
      }
      if (Array.isArray(dc['constraints']) && dc['constraints'].length > 0) {
        dcParts.push(`CONSTRAINTS: ${(dc['constraints'] as string[]).join('; ')}`);
      }
      if (dcParts.length > 0) {
        promptParts.push(`\n\nCONTEXT FROM USER:\n${dcParts.join('\n')}`);
      }
    } catch {
      // best-effort
    }
  }

  const parentInstructions = extractParentInstructions(runMetadata);
  if (parentInstructions) {
    if ('runLevel' in parentInstructions) {
      promptParts.push(`\n\nPARENT INSTRUCTIONS (run-level):\n${parentInstructions.runLevel}`);
    } else {
      const forThisTask = parentInstructions.taskTargeted.filter((e) => e.taskId === task.taskId);
      if (forThisTask.length > 0) {
        const combined = forThisTask.map((e) => e.text).join('\n\n');
        promptParts.push(`\n\nPARENT INSTRUCTIONS (this task):\n${combined}`);
      }
    }
  }

  if (wdc.taskContext) {
    promptParts.push(`\n\nCONTEXT DOCUMENTS:\n${wdc.taskContext}`);
  }
  if (wdc.taskLearnings) {
    promptParts.push(`\n\nPRIOR LEARNINGS:\n${wdc.taskLearnings}`);
  }

  const inputsForPrompt = wdc.taskInputs ?? {};
  promptParts.push(
    `\n\nTASK INPUTS (typed, keyed by bindAs):\n${JSON.stringify(inputsForPrompt, null, 2)}`,
  );

  const priorFailuresBlock = formatPriorFailuresBlock(priorFailures);
  if (priorFailuresBlock) {
    promptParts.push(priorFailuresBlock);
  }

  // 104f: Parse delegation context into an object for the Runner's session
  let parsedDelegationCtx: Record<string, unknown> | undefined;
  if (delegationContextJson) {
    try {
      parsedDelegationCtx = JSON.parse(delegationContextJson) as Record<string, unknown>;
    } catch {
      // best-effort
    }
  }

  if (wdc.outputSchema) {
    const schemaJson = JSON.stringify(wdc.outputSchema);
    getOrchestratorLogger().info(
      `[taskHelpers] Forwarding outputSchema to runner for task=${task.taskId} (${String(schemaJson.length)} chars)`,
    );
  } else {
    getOrchestratorLogger().warn(
      `[taskHelpers] No outputSchema for task=${task.taskId} — runner won't validate output. ` +
        `task.outputContract=${task.outputContract ? 'present' : 'absent'}`,
    );
  }
  // An operator-authored agent carries its own system prompt, tools and model.
  // The Runner scaffolding — prompt, tool manifest, capability grants — is
  // addressed to the Runner and would arrive as unknown config, so the task
  // hands over only what is genuinely its own: the goal and the bound inputs.
  if (isCustomAgentRef(targetAgent)) {
    const taskInputs = wdc.taskInputs ?? {};
    const inputParts = [`GOAL: ${task.goal}`];
    if (Object.keys(taskInputs).length > 0) {
      inputParts.push(
        `\n\nTASK INPUTS (typed, keyed by bindAs):\n${JSON.stringify(taskInputs, null, 2)}`,
      );
    }
    return {
      agentId: targetAgent,
      input: inputParts.join(''),
      config: {},
      ...(parsedDelegationCtx ? { context: parsedDelegationCtx } : {}),
      ...(wdc.outputSchema ? { outputSchema: wdc.outputSchema } : {}),
      ...(task.outputContract?.validatorRefs && task.outputContract.validatorRefs.length > 0
        ? { validatorRefs: task.outputContract.validatorRefs }
        : {}),
      displayMeta: {
        workflowSlug: workflow.slug,
        taskId: task.taskId,
        taskName: task.name,
      },
    };
  }

  return {
    agentId: targetAgent,
    input: promptParts.join(''),
    config: {
      runner_system_prompt: wdc.runnerSystemPrompt,
      runner_tools: wdc.runnerTools,
      runner_model: wdc.runnerModel,
      ...(wdc.runnerReasoningEffort !== undefined
        ? { runner_reasoning_effort: wdc.runnerReasoningEffort }
        : {}),
      ...(wdc.capabilityGrants ? { runner_capability_grants: wdc.capabilityGrants } : {}),
      runner_tool_manifest: effectiveManifest,
      runner_task_inputs: wdc.taskInputs ?? {},
    },
    ...(parsedDelegationCtx ? { context: parsedDelegationCtx } : {}),
    ...(wdc.outputSchema ? { outputSchema: wdc.outputSchema } : {}),
    ...(task.outputContract?.validatorRefs && task.outputContract.validatorRefs.length > 0
      ? { validatorRefs: task.outputContract.validatorRefs }
      : {}),
    displayMeta: {
      workflowSlug: workflow.slug,
      taskId: task.taskId,
      taskName: task.name,
    },
  };
}

export function extractParentInstructions(runMetadata: unknown): StoredParentInstructions | null {
  if (runMetadata === null || runMetadata === undefined || typeof runMetadata !== 'object') {
    return null;
  }
  const raw = (runMetadata as Record<string, unknown>)['parentInstructions'];
  if (raw === undefined) return null;
  const parsed = StoredParentInstructionsSchema.safeParse(raw);
  if (!parsed.success) {
    getOrchestratorLogger().warn(
      `[taskHelpers] workflow_runs.metadata.parentInstructions failed validation; ignoring. ` +
        `issues=${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
    return null;
  }
  return parsed.data;
}

export function buildRunInputSnapshotFromParent(
  inputBindings: NonNullable<WorkflowTask['inputBindings']>,
  parentInputs: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [bindAs, binding] of Object.entries(inputBindings)) {
    if (binding.kind !== 'run_input') continue;
    if (!Object.prototype.hasOwnProperty.call(parentInputs, bindAs)) continue;
    setAtPath(snapshot, binding.path, parentInputs[bindAs]);
  }
  return snapshot;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = parseOutputPath(path) ?? [{ kind: 'key' as const, key: path }];
  let cursor: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const last = i === segments.length - 1;
    // The container the NEXT segment needs (object for keys, array for [n]).
    const next = segments[i + 1];
    const freshContainer = (): Record<string, unknown> | unknown[] =>
      next?.kind === 'index' ? [] : {};

    if (seg.kind === 'key') {
      // A key segment writes into a plain object; if the cursor is an array
      // we cannot place a key here — the snapshot is freshly owned, so this
      // only happens on conflicting paths; skip rather than corrupt.
      if (Array.isArray(cursor)) return;
      if (last) {
        cursor[seg.key] = value;
        return;
      }
      const existing = cursor[seg.key];
      // Replace anything that can't host the next segment (primitive, null,
      // wrong container kind). The runInput we're building is a fresh
      // snapshot we own; overwriting is safe and predictable.
      if (
        existing === null ||
        typeof existing !== 'object' ||
        Array.isArray(existing) !== (next?.kind === 'index')
      ) {
        cursor[seg.key] = freshContainer();
      }
      cursor = cursor[seg.key] as Record<string, unknown> | unknown[];
    } else {
      if (!Array.isArray(cursor)) return;
      if (last) {
        cursor[seg.index] = value;
        return;
      }
      const existing = cursor[seg.index];
      if (
        existing === null ||
        existing === undefined ||
        typeof existing !== 'object' ||
        Array.isArray(existing) !== (next?.kind === 'index')
      ) {
        cursor[seg.index] = freshContainer();
      }
      cursor = cursor[seg.index] as Record<string, unknown> | unknown[];
    }
  }
}

export function extractParentTaskInputs(runMetadata: unknown): StoredParentTaskInputs | null {
  if (runMetadata === null || runMetadata === undefined || typeof runMetadata !== 'object') {
    return null;
  }
  const raw = (runMetadata as Record<string, unknown>)['parentTaskInputs'];
  if (raw === undefined) return null;
  const parsed = StoredParentTaskInputsSchema.safeParse(raw);
  if (!parsed.success) {
    getOrchestratorLogger().warn(
      `[taskHelpers] workflow_runs.metadata.parentTaskInputs failed validation; ignoring. ` +
        `issues=${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
    return null;
  }
  return parsed.data;
}

export function formatPriorFailuresBlock(priorFailures: unknown): string | null {
  if (!Array.isArray(priorFailures) || priorFailures.length === 0) return null;
  const lines: string[] = [];
  for (const raw of priorFailures) {
    if (!raw || typeof raw !== 'object') continue;
    const snapshot = raw as Record<string, unknown>;
    const attempt = typeof snapshot['attempt'] === 'number' ? snapshot['attempt'] : undefined;
    if (attempt === undefined) continue;
    lines.push(`  attempt ${String(attempt)}:`);
    if (typeof snapshot['failedAt'] === 'string') {
      lines.push(`    failed_at: ${snapshot['failedAt']}`);
    }
    if (typeof snapshot['errorCode'] === 'string') {
      lines.push(`    error_code: ${snapshot['errorCode']}`);
    }
    if (typeof snapshot['errorClassification'] === 'string') {
      lines.push(`    error_classification: ${snapshot['errorClassification']}`);
    }
    if (typeof snapshot['errorRetryable'] === 'boolean') {
      lines.push(`    error_retryable: ${String(snapshot['errorRetryable'])}`);
    }
    if (typeof snapshot['failureReason'] === 'string') {
      lines.push(`    failure_reason: ${JSON.stringify(snapshot['failureReason'])}`);
    }
    if (typeof snapshot['remediationNote'] === 'string') {
      lines.push(`    remediation_note: ${JSON.stringify(snapshot['remediationNote'])}`);
    }
  }
  if (lines.length === 0) return null;
  return `\n\nPRIOR ATTEMPTS:\n${lines.join('\n')}`;
}
