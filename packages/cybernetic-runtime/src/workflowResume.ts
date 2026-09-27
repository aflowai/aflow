import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import {
  createTenantContext,
  sessions,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import {
  WorkflowResumeContractSchema,
  describeMissingCapability,
  type TenantId,
  type WorkflowResumeContract,
  type WorkflowRunPauseReason,
  type WorkflowTask,
  type SubagentHandoffPayload,
  type ResumeResolutionMode,
  type OAuthConsentPauseCause,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { getCyberneticLogger } from './logger.js';
import { RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS } from './workflowRunDetail.js';

export interface SurfacedResumeContract {
  contract: WorkflowResumeContract;
  /** Live snapshot version stamped into `suggestedResumeCall.args.pauseVersion`. */
  pauseVersion: number;
  /** Echoed for caller convenience (UI / log lines / tool result framing). */
  pausedReason: string | null;
  resumeAttemptCount: number;
}

/**
 * Fetch a paused run's resume contract with the live `pauseVersion` injected
 * into `suggestedResumeCall.args.pauseVersion`. Returns null when:
 *
 *   - the run row is absent;
 *   - the row is not in `status='paused'` (no contract surface to surface);
 *   - `paused_payload_ref` is null (legacy pause / non-contract pause cause);
 *   - the stored ref fails to retrieve or fails schema validation
 *     (a schema-broken payload is treated as missing — caller should
 *     fall back to a degraded prompt rather than crash).
 */
export async function surfaceWorkflowResumeContract(
  db: PostgresJsDatabase,
  payloadStore: PayloadStore,
  tenantId: string,
  runId: string,
): Promise<SurfacedResumeContract | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const row = await withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx.select().from(workflowRuns).where(eq(workflowRuns.runId, runId)).limit(1);
    return rows[0] ?? null;
  });
  if (!row) {
    getCyberneticLogger().info(
      `[surfaceWorkflowResumeContract] null: row not found for run=${runId}`,
    );
    return null;
  }
  if (row.status !== 'paused') {
    getCyberneticLogger().info(
      `[surfaceWorkflowResumeContract] null: run=${runId} status="${row.status}" (not paused)`,
    );
    return null;
  }
  if (!row.pausedPayloadRef) {
    getCyberneticLogger().info(
      `[surfaceWorkflowResumeContract] null: run=${runId} has no pausedPayloadRef ` +
        `(pausedReason=${row.pausedReason ?? 'null'})`,
    );
    return null;
  }

  let raw: unknown;
  try {
    raw = await payloadStore.retrieve(row.pausedPayloadRef);
  } catch (err) {
    getCyberneticLogger().warn(
      `[surfaceWorkflowResumeContract] null: payloadStore.retrieve threw for run=${runId} ref=${row.pausedPayloadRef}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    getCyberneticLogger().info(
      `[surfaceWorkflowResumeContract] null: payload ref=${row.pausedPayloadRef} resolved to non-object`,
    );
    return null;
  }
  const parsed = WorkflowResumeContractSchema.safeParse(raw);
  if (!parsed.success) {
    getCyberneticLogger().warn(
      `[surfaceWorkflowResumeContract] null: schema validation failed for run=${runId} ref=${row.pausedPayloadRef} — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
    return null;
  }

  const live = parsed.data;
  let surfaced: WorkflowResumeContract = live;
  if (live.suggestedResumeCall) {
    if (live.suggestedResumeCall.op === 'workflow.run.resume') {
      surfaced = {
        ...live,
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            ...live.suggestedResumeCall.args,
            pauseVersion: row.pauseVersion,
          },
        },
      };
    }
    // agent.control.resume case: nothing to inject — surface as-is.
  }

  const actionCenterItemId = await findActionCenterItemIdForPausedRun(
    db,
    payloadStore,
    tenantId,
    runId,
  );
  if (actionCenterItemId !== null) {
    surfaced = {
      ...surfaced,
      suggestedResumeCall: {
        op: 'human.action_center.focus' as const,
        args: { itemId: actionCenterItemId },
      },
    };
  }

  return {
    contract: surfaced,
    pauseVersion: row.pauseVersion,
    pausedReason: row.pausedReason,
    resumeAttemptCount: row.resumeAttemptCount,
  };
}

export async function deriveSuggestedNextCallForPausedRun(
  db: PostgresJsDatabase,
  payloadStore: PayloadStore,
  tenantId: string,
  runId: string,
): Promise<{ op: 'human.action_center.focus'; args: { itemId: string } } | null> {
  const itemId = await findActionCenterItemIdForPausedRun(db, payloadStore, tenantId, runId);
  if (itemId === null) return null;
  return { op: 'human.action_center.focus' as const, args: { itemId } };
}

async function findActionCenterItemIdForPausedRun(
  db: PostgresJsDatabase,
  payloadStore: PayloadStore,
  tenantId: string,
  runId: string,
): Promise<string | null> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const result = await withTenantSchema(db, tenantCtx, async (tx) => {
    const taskRows = await tx
      .select({ workerSessionId: workflowRunTasks.workerSessionId })
      .from(workflowRunTasks)
      .where(and(eq(workflowRunTasks.runId, runId), eq(workflowRunTasks.status, 'paused')))
      .limit(1);
    const workerSessionId = taskRows[0]?.workerSessionId;
    if (!workerSessionId) return null;

    const sessionRows = await tx
      .select({
        currentStepExecutionId: sessions.currentStepExecutionId,
        requestedInputRef: sessions.requestedInputRef,
      })
      .from(sessions)
      .where(eq(sessions.sessionId, workerSessionId))
      .limit(1);
    const stepExecutionId = sessionRows[0]?.currentStepExecutionId;
    const requestedInputRef = sessionRows[0]?.requestedInputRef;
    if (!stepExecutionId || !requestedInputRef) return null;

    return { stepExecutionId, requestedInputRef };
  });
  if (!result) return null;

  let payload: Record<string, unknown> | null = null;
  try {
    const raw = await payloadStore.retrieve(result.requestedInputRef as never);
    if (raw && typeof raw === 'object') {
      payload = raw as Record<string, unknown>;
    }
  } catch {
    // Malformed/missing payload — caller falls back to null.
  }
  if (!payload) return null;

  const rawKind = typeof payload['kind'] === 'string' ? payload['kind'] : null;
  if (rawKind !== 'input' && rawKind !== 'approval') return null;

  const hasGateContext = payload['gateContext'] !== undefined && payload['gateContext'] !== null;
  const prefix = hasGateContext ? 'gate' : 'step';
  return `${prefix}:${result.stepExecutionId}`;
}

// ============================================================================

/**
 * Discriminated input to `buildResumeContract` — one variant per pause
 * class. Each carries exactly the data the contract needs (handoff
 * payload for subagent_handoff, error metadata for transient_error,
 * Ajv errors for task_contract_violation, etc.) so the builder is a
 * pure function with no DB or PayloadStore reads.
 */
export type BuildResumeContractInput =
  | {
      pauseCause: 'subagent_handoff';
      runId: string;
      taskId: string;
      taskDef: WorkflowTask | null;
      handoff: SubagentHandoffPayload;
      /** Live `workflow_run_tasks.attempt` at pause time (defaults to 1). */
      pausedTaskAttempt?: number;
    }
  | {
      pauseCause: 'transient_error';
      runId: string;
      taskId: string;
      taskDef: WorkflowTask | null;
      errorMessage: string;
      errorCode?: string;
      pausedTaskAttempt?: number;
    }
  | {
      pauseCause: 'task_contract_violation';
      runId: string;
      taskId: string;
      taskDef: WorkflowTask | null;
      pausedTaskAttempt?: number;
      resumePrompt: string;
      expectedTaskOutputSchema?: Record<string, unknown>;
      replaceOutputSchema?: Record<string, unknown>;
      contractErrors?: Array<Record<string, unknown>>;
      failedOutputPreview?: unknown;
    }
  | {
      pauseCause: 'needs_credentials';
      runId: string;
      blockedBindings: Array<{
        bindingId: string;
        bindingName: string;
        missingFields: string[];
      }>;
      taskId?: string;
    }
  | {
      pauseCause: 'needs_capability';
      runId: string;
      disabledCapabilities: string[];
    }
  | {
      pauseCause: 'needs_oauth_consent';
      runId: string;
      taskId?: string;
      oauthConsent: OAuthConsentPauseCause;
    }
  | {
      pauseCause: 'retry_budget_exceeded';
      runId: string;
      taskId: string;
      taskDef: WorkflowTask | null;
      resumePrompt: string;
      expectedTaskOutputSchema?: Record<string, unknown>;
      replaceOutputSchema?: Record<string, unknown>;
    }
  | {
      pauseCause: 'manual';
      runId: string;
      taskId?: string;
      taskDef?: WorkflowTask | null;
      reason: string;
      pausedTaskAttempt?: number;
      interruptRestart?: boolean;
    };

/**
 * Derive `pausedTaskInputContract.schema` for the `provide_input` mode —
 * the JSON Schema of the expected `resolution.inputs` payload, keyed by
 * `bindAs`. Returns `null` when the task has no `run_input` bindings.
 */
function deriveProvideInputSchemaForTask(
  task: WorkflowTask | null,
): Record<string, unknown> | null {
  const bindings = task?.inputContract?.bindings;
  if (!bindings) return null;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [bindAs, binding] of Object.entries(bindings)) {
    if (binding.kind !== 'run_input') continue;
    properties[bindAs] = binding.schema;
    required.push(bindAs);
  }
  if (Object.keys(properties).length === 0) return null;
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function requiresRemediationConfirmation(task: WorkflowTask | null | undefined): boolean {
  if (!task) return false;
  return (task.retryability ?? 'unknown') !== 'safe';
}

/**
 * JSON Schema slot for the inner `re_execute` resolution payload. For
 * safe tasks the resumer can omit every field; for unsafe/unknown
 * tasks `remediationConfirmed: true` is REQUIRED so the schema fails
 * loudly if Helmsman tries to copy the suggested call as-is.
 */
function reExecuteInputSchema(task: WorkflowTask | null | undefined): Record<string, unknown> {
  if (!requiresRemediationConfirmation(task)) {
    return { type: 'object', additionalProperties: true };
  }
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      remediationConfirmed: { type: 'boolean', const: true },
      instructions: {
        oneOf: [
          { type: 'string' },
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['taskId', 'text'],
            },
          },
        ],
      },
    },
    required: ['remediationConfirmed'],
  };
}

/**
 * Append the unsafe-task gate language to a resumePrompt so Helmsman
 * narrates the confirmation requirement to the operator before sending
 * the resume call. Returns the original prompt unchanged for safe tasks.
 */
function annotatePromptForUnsafeRetry(
  prompt: string,
  task: WorkflowTask | null | undefined,
): string {
  if (!requiresRemediationConfirmation(task)) return prompt;
  const retryability = task?.retryability ?? 'unknown';
  return (
    prompt +
    `\n\nThis task is declared \`retryability: '${retryability}'\` — side effects may have occurred on the prior attempt. ` +
    'BEFORE invoking the suggested call, confirm with the operator that the prior attempt did not commit observable side effects ' +
    '(or that external state has been remediated). Then add `remediationConfirmed: true` to `resolution` — that flag is your ' +
    'assertion that confirmation was obtained. The suggested call deliberately omits it so you cannot rubber-stamp the gate by ' +
    'copying verbatim. Without `remediationConfirmed: true` the resume handler rejects the call with ' +
    '`RE_EXECUTE_UNSAFE_TASK_REQUIRES_CONFIRMATION`.'
  );
}

const PAUSED_TASK_INPUT_CONTRACT_PROMPT_MAX = 2000;

/**
 * Clip text assigned to `pausedTaskInputContract.prompt` so stored contracts
 * always pass `WorkflowResumeContractSchema` (handoff prompts are unbounded).
 * Full prose remains on uncapped `resumePrompt`.
 */
function boundPausedTaskInputContractPrompt(prompt: string): string {
  if (prompt.length <= PAUSED_TASK_INPUT_CONTRACT_PROMPT_MAX) return prompt;
  return prompt.slice(0, PAUSED_TASK_INPUT_CONTRACT_PROMPT_MAX - 1) + '…';
}

function pausedTaskInputContractPromptForReExecute(
  basePrompt: string,
  task: WorkflowTask | null | undefined,
): string {
  return boundPausedTaskInputContractPrompt(annotatePromptForUnsafeRetry(basePrompt, task));
}

/**
 * Build the `suggestedResumeCall.args.resolution` block for the
 * `re_execute` mode. The shape is intentionally minimal — Helmsman
 * appends free-text `instructions` (PRIOR FAILURE GUIDANCE) and, for
 * unsafe/unknown tasks, the load-bearing `remediationConfirmed: true`
 * flag AFTER getting operator confirmation. Pre-filling
 * `remediationConfirmed` here would let Helmsman rubber-stamp the gate
 * by copying the call verbatim; instead the schema (via
 * `reExecuteInputSchema`) marks the flag REQUIRED for unsafe tasks so
 * Helmsman is forced to add it explicitly. The act of adding the flag
 * IS the assertion of operator confirmation.
 */
function reExecuteResolutionForTask(
  _task: WorkflowTask | null | undefined,
): Record<string, unknown> {
  return { mode: 're_execute' };
}

function effectiveMaxAttempts(taskDef: WorkflowTask | null | undefined): number {
  return taskDef?.maxAttempts ?? RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS;
}

/**
 * Mirrors `applyReExecuteResolution` budget gate (`reExecute.ts`): offer
 * `re_execute` only when the paused row can accept another attempt.
 */
function reExecuteOfferable(
  taskDef: WorkflowTask | null | undefined,
  pausedTaskAttempt: number | undefined,
): boolean {
  const attempt = pausedTaskAttempt ?? 1;
  return attempt < effectiveMaxAttempts(taskDef);
}

/**
 * Whether `re_execute` may appear in `allowedResumeModes` for pauses whose
 * primary path is another mode (e.g. `task_contract_violation` →
 * `replace_output`). Budget alone is insufficient: unsafe/unknown tasks need
 * `pausedTaskInputContract` + remediation guidance (see
 * `buildReExecuteOrFailOnlySlice`), which those contracts do not carry.
 */
function reExecuteAdvertisable(
  taskDef: WorkflowTask | null | undefined,
  pausedTaskAttempt: number | undefined,
): boolean {
  return (
    reExecuteOfferable(taskDef, pausedTaskAttempt) && !requiresRemediationConfirmation(taskDef)
  );
}

/**
 * Whether a `task_contract_violation` pause has a resolution anyone can carry
 * out — the question of whether the pause should exist at all.
 *
 * The contract advertises `replace_output` unconditionally, but a resolver can
 * only supply a replacement when the task declares the schema that says which
 * ports to supply; `re_execute` is withheld from tasks that are not
 * `retryability: safe`. With neither, `fail` is the only honest answer left,
 * and pausing to reach a failure is strictly worse than failing: it parks the
 * run, defers the same outcome, and makes releasing it depend on a resolver
 * arriving. A task that fails instead propagates through `failureMode` to its
 * caller immediately, which is what a caller is waiting to hear.
 */
export function contractViolationHasResolution(args: {
  taskDef: WorkflowTask | null | undefined;
  pausedTaskAttempt: number | undefined;
  replaceOutputSchema?: Record<string, unknown> | undefined;
}): boolean {
  if (args.replaceOutputSchema) return true;
  return reExecuteAdvertisable(args.taskDef, args.pausedTaskAttempt);
}

type ReExecuteContractSlice = Pick<
  WorkflowResumeContract,
  'allowedResumeModes' | 'suggestedResumeCall' | 'pausedTaskInputContract'
>;

function buildReExecuteOrFailOnlySlice(args: {
  runId: string;
  taskDef: WorkflowTask | null | undefined;
  pausedTaskAttempt: number | undefined;
  basePrompt: string;
  forceReExecute?: boolean;
}): ReExecuteContractSlice {
  if (args.forceReExecute || reExecuteOfferable(args.taskDef, args.pausedTaskAttempt)) {
    return {
      allowedResumeModes: ['re_execute', 'fail'],
      suggestedResumeCall: {
        op: 'workflow.run.resume',
        args: {
          runId: args.runId,
          resolution: reExecuteResolutionForTask(args.taskDef) as never,
        },
      },
      pausedTaskInputContract: {
        schema: reExecuteInputSchema(args.taskDef),
        resolutionMode: 're_execute',
        prompt: pausedTaskInputContractPromptForReExecute(args.basePrompt, args.taskDef),
      },
    };
  }
  const attempt = args.pausedTaskAttempt ?? 1;
  const maxAttempts = effectiveMaxAttempts(args.taskDef);
  return {
    allowedResumeModes: ['fail'],
    suggestedResumeCall: {
      op: 'workflow.run.resume',
      args: {
        runId: args.runId,
        resolution: {
          mode: 'fail',
          reason:
            `Retry budget exhausted (attempt=${String(attempt)} >= maxAttempts=${String(maxAttempts)}). ` +
            'Replace this reason with the operator-facing rejection text before invoking.',
        },
      },
    },
    pausedTaskInputContract: {
      schema: {},
      resolutionMode: 'fail',
      prompt: boundPausedTaskInputContractPrompt(
        `Task retry budget exhausted (attempt=${String(attempt)} >= maxAttempts=${String(maxAttempts)}). ` +
          'Invoke fail with a `reason` on the resolution, or cancel the run.',
      ),
    },
  };
}

export function buildResumeContract(input: BuildResumeContractInput): WorkflowResumeContract {
  switch (input.pauseCause) {
    case 'subagent_handoff': {
      const isMissingInput = input.handoff.blockingCategory === 'missing_input';
      if (isMissingInput) {
        const provideInputSchema = deriveProvideInputSchemaForTask(input.taskDef);
        return {
          pauseCause: 'subagent_handoff',
          resumePrompt: input.handoff.prompt,
          failedTaskId: input.taskId,
          handoffPayload: input.handoff,
          allowedResumeModes: ['provide_input', 'fail'] satisfies ResumeResolutionMode[],
          suggestedResumeCall: {
            op: 'workflow.run.resume',
            args: {
              runId: input.runId,
              resolution: {
                mode: 'provide_input',
                taskId: input.taskId,
                inputs: {},
              },
            },
          },
          ...(provideInputSchema
            ? {
                pausedTaskInputContract: {
                  schema: provideInputSchema,
                  resolutionMode: 'provide_input',
                  prompt: boundPausedTaskInputContractPrompt(input.handoff.prompt),
                },
              }
            : {}),
        };
      }
      // Non-missing_input subagent handoff → re_execute when retry budget
      // remains; otherwise fail-only (mirrors `applyReExecuteResolution`).
      const reExecuteSlice = buildReExecuteOrFailOnlySlice({
        runId: input.runId,
        taskDef: input.taskDef,
        pausedTaskAttempt: input.pausedTaskAttempt,
        basePrompt: input.handoff.prompt,
      });
      return {
        pauseCause: 'subagent_handoff',
        resumePrompt: annotatePromptForUnsafeRetry(input.handoff.prompt, input.taskDef),
        failedTaskId: input.taskId,
        handoffPayload: input.handoff,
        ...reExecuteSlice,
      };
    }
    case 'transient_error': {
      const basePrompt =
        `Task "${input.taskId}" hit a transient external failure: ${input.errorMessage}. ` +
        'Verify the upstream cause is resolved, then retry via `re_execute`.';
      const reExecuteSlice = buildReExecuteOrFailOnlySlice({
        runId: input.runId,
        taskDef: input.taskDef,
        pausedTaskAttempt: input.pausedTaskAttempt,
        basePrompt,
      });
      return {
        pauseCause: 'transient_error',
        resumePrompt: annotatePromptForUnsafeRetry(basePrompt, input.taskDef),
        failedTaskId: input.taskId,
        errorMessage: input.errorMessage,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...reExecuteSlice,
      };
    }
    case 'task_contract_violation': {
      const violationModes: ResumeResolutionMode[] = ['replace_output', 'fail'];
      if (reExecuteAdvertisable(input.taskDef, input.pausedTaskAttempt)) {
        violationModes.splice(1, 0, 're_execute');
      }
      let resumePrompt = input.resumePrompt;
      if (
        reExecuteOfferable(input.taskDef, input.pausedTaskAttempt) &&
        requiresRemediationConfirmation(input.taskDef)
      ) {
        resumePrompt =
          input.resumePrompt +
          '\n\n`re_execute` is not offered on this pause — the task is not `retryability: safe` and ' +
          'this contract only surfaces the `replace_output` patch schema. Use `replace_output` to fix ' +
          'the failed ports, or `fail` to reject the task.';
      }
      return {
        pauseCause: 'task_contract_violation',
        resumePrompt,
        failedTaskId: input.taskId,
        ...(input.expectedTaskOutputSchema
          ? { expectedTaskOutputSchema: input.expectedTaskOutputSchema }
          : {}),
        ...(input.replaceOutputSchema ? { replaceOutputSchema: input.replaceOutputSchema } : {}),
        ...(input.contractErrors ? { contractErrors: input.contractErrors as never } : {}),
        ...(input.failedOutputPreview !== undefined
          ? { failedOutputPreview: input.failedOutputPreview }
          : {}),
        allowedResumeModes: violationModes satisfies ResumeResolutionMode[],
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: input.runId,
            resolution: { mode: 'replace_output', output: {} },
          },
        },
        ...(input.replaceOutputSchema
          ? {
              pausedTaskInputContract: {
                schema: input.replaceOutputSchema,
                resolutionMode: 'replace_output',
                prompt: boundPausedTaskInputContractPrompt(input.resumePrompt),
              },
            }
          : {}),
      };
    }
    case 'retry_budget_exceeded': {
      return {
        pauseCause: 'retry_budget_exceeded',
        resumePrompt: input.resumePrompt,
        failedTaskId: input.taskId,
        ...(input.expectedTaskOutputSchema
          ? { expectedTaskOutputSchema: input.expectedTaskOutputSchema }
          : {}),
        ...(input.replaceOutputSchema ? { replaceOutputSchema: input.replaceOutputSchema } : {}),
        allowedResumeModes: ['replace_output', 'fail'] satisfies ResumeResolutionMode[],
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: input.runId,
            resolution: { mode: 'replace_output', output: {} },
          },
        },
        ...(input.replaceOutputSchema
          ? {
              pausedTaskInputContract: {
                schema: input.replaceOutputSchema,
                resolutionMode: 'replace_output',
                prompt: boundPausedTaskInputContractPrompt(input.resumePrompt),
              },
            }
          : {}),
      };
    }
    case 'needs_credentials': {
      const bindingNames = input.blockedBindings.map((b) => b.bindingName).join(', ');
      const taskBacked = input.taskId !== undefined;
      return {
        pauseCause: 'needs_credentials',
        resumePrompt:
          `Workflow paused — bindings without credentials: ${bindingNames || '(unknown)'}. ` +
          (taskBacked
            ? 'Fix at /integrations, then `acknowledge` to re-resolve bindings and re-run the blocked task.'
            : 'Fix at /integrations, then `acknowledge` to re-resolve bindings.'),
        blockedBindings: input.blockedBindings,
        ...(input.taskId ? { failedTaskId: input.taskId } : {}),
        allowedResumeModes: ['acknowledge', 'fail'] satisfies ResumeResolutionMode[],
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: input.runId,
            resolution: { mode: 'acknowledge' },
          },
        },
        pausedTaskInputContract: {
          schema: {},
          resolutionMode: 'acknowledge',
          prompt: 'After fixing credentials out-of-band, call this verbatim.',
        },
      };
    }
    case 'needs_capability': {
      const capabilityRemedies = input.disabledCapabilities.map((capability) => ({
        capability,
        remedy: describeMissingCapability(capability),
      }));
      return {
        pauseCause: 'needs_capability',
        resumePrompt:
          `Workflow paused — disabled capabilities: ${input.disabledCapabilities.join(', ') || '(unknown)'}. ` +
          capabilityRemedies.map((r) => `${r.capability}: ${r.remedy}`).join(' ') +
          (capabilityRemedies.length > 0 ? ' ' : '') +
          'Resolve these capability gaps, then `acknowledge` to retry.',
        disabledCapabilities: input.disabledCapabilities,
        ...(capabilityRemedies.length > 0 ? { capabilityRemedies } : {}),
        allowedResumeModes: ['acknowledge', 'fail'] satisfies ResumeResolutionMode[],
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: input.runId,
            resolution: { mode: 'acknowledge' },
          },
        },
        pausedTaskInputContract: {
          schema: {},
          resolutionMode: 'acknowledge',
          prompt: 'After re-enabling the capability, call this verbatim.',
        },
      };
    }
    case 'needs_oauth_consent': {
      // The pinned owner completes consent out-of-band (the OAuth callback);
      // the run resumes when the callback lands. When the pause parked a Runner
      // step (`taskId` present), resuming must RE-DISPATCH that step
      // (`re_execute`) — a bare `acknowledge` would leave the paused task row
      // stuck, so the callback resume routing drives `re_execute`. Only the
      // run-level (task-less) consent pause uses `acknowledge`.
      const provider = input.oauthConsent.resourceKey;
      const taskBacked = input.taskId !== undefined;
      const resolutionMode = taskBacked ? 're_execute' : 'acknowledge';
      return {
        pauseCause: 'needs_oauth_consent',
        resumePrompt:
          `Workflow paused — connect ${provider} to continue. ` +
          (input.oauthConsent.reason === 'expired'
            ? 'The stored connection expired; reconnect to retry.'
            : 'No account is connected; connect it to retry.'),
        oauthConsent: input.oauthConsent,
        ...(input.taskId ? { failedTaskId: input.taskId } : {}),
        allowedResumeModes: (taskBacked
          ? ['re_execute', 'fail']
          : ['acknowledge', 'fail']) satisfies ResumeResolutionMode[],
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: input.runId,
            resolution: taskBacked ? { mode: 're_execute' } : { mode: 'acknowledge' },
          },
        },
        pausedTaskInputContract: {
          schema: {},
          resolutionMode,
          prompt: 'After connecting the account out-of-band, call this verbatim.',
        },
      };
    }
    case 'manual': {
      // Run-level manual pause (no taskId): re_execute needs failedTaskId on
      // the contract — advertise acknowledge only so the suggested call works.
      if (!input.taskId) {
        return {
          pauseCause: 'manual',
          resumePrompt: input.reason,
          allowedResumeModes: ['acknowledge'] satisfies ResumeResolutionMode[],
          suggestedResumeCall: {
            op: 'workflow.run.resume',
            args: {
              runId: input.runId,
              resolution: { mode: 'acknowledge' },
            },
          },
          pausedTaskInputContract: {
            schema: {},
            resolutionMode: 'acknowledge',
            prompt: boundPausedTaskInputContractPrompt(
              'Operator paused the run. After any out-of-band fix, call acknowledge to resume.',
            ),
          },
        };
      }
      // Task-level manual: acknowledge would leave the paused task row stuck.
      const reExecuteSlice = buildReExecuteOrFailOnlySlice({
        runId: input.runId,
        taskDef: input.taskDef ?? null,
        pausedTaskAttempt: input.pausedTaskAttempt,
        basePrompt: input.reason,
        ...(input.interruptRestart ? { forceReExecute: true } : {}),
      });
      return {
        pauseCause: 'manual',
        resumePrompt: annotatePromptForUnsafeRetry(input.reason, input.taskDef),
        failedTaskId: input.taskId,
        ...reExecuteSlice,
      };
    }
  }
}

export const BUILD_RESUME_CONTRACT_HANDLED_CAUSES = new Set<WorkflowRunPauseReason>([
  'subagent_handoff',
  'transient_error',
  'task_contract_violation',
  'retry_budget_exceeded',
  'needs_credentials',
  'needs_capability',
  'needs_oauth_consent',
  'manual',
]);
