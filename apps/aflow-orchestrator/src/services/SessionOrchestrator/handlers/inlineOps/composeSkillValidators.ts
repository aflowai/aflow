import { getDatabase, resolveWorkflowForRunRevision } from '@aflow/database';
import { loadRunById } from '@aflow/cybernetic-runtime';
import {
  validateTaskGraphSelfConsistent,
  validateSourceCoverage,
  validateSurfaceConformance,
  type ComposeValidationResult,
  type ComposeValidationViolation,
} from '@aflow/cybernetic-runtime';
import { getSessionState } from '@aflow/redis';
import {
  ValidateTaskGraphInputSchema,
  ValidateSourceCoverageInputSchema,
  CapabilityValidateGrantsInputSchema,
  type ContractError,
  type Workflow,
  type WorkflowTask,
  type WorkflowTaskInputBinding,
} from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import {
  emitContractFailure,
  emitStepError,
  emitStepSuccess,
  readInlineOpInput,
} from './helpers.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

// ============================================================================
// Consumer-context resolution
// ============================================================================

interface ConsumerContext {
  consumerTaskId: string;
  /**
   * The consumer's persisted `inputBindings`, used to resolve `bindAs` →
   * `producerTaskId` when constructing per-binding `ContractError`s.
   */
  inputBindings: Record<string, WorkflowTaskInputBinding>;
}

/**
 * Extract `_taskId:<id>` from the step's tags and load the consumer task's
 * persisted definition. The consumer's `inputBindings` are required to
 * resolve `violation.bindAs` → `producerTaskId` for each emitted
 * `ContractError`. Returns `null` and emits a typed step error on failure.
 *
 * The `runId` for the database lookup is read from
 * `runtimeState.variables.workflow._engineMeta.runId`, NOT from
 * `args.context.runId`. The latter is the platform `SessionId`, which
 * differs from the workflow-run id for delegated worker sessions (the
 * common case for compose-skill: the agent runner runs in a child session
 * but the workflow run id stays anchored on the parent driver session's
 * engine meta).
 */
async function loadConsumerContext(
  args: InlineHandlerArgs,
  startTime: number,
): Promise<ConsumerContext | null> {
  const taskIdTag = args.stepDef.tags.find((t) => t.startsWith('_taskId:'));
  if (!taskIdTag) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_NO_TASK_TAG',
      'Validator step is missing the `_taskId:<id>` tag — it must be emitted by the lifecycle compiler so the handler can load the consumer task definition.',
      startTime,
      'configuration',
    );
    return null;
  }
  const consumerTaskId = taskIdTag.slice('_taskId:'.length);

  const tenantId = args.context.tenantId;
  const spaceId = args.context.spaceId ?? '';
  const db = getDatabase();

  let runId = args.workflowExecution?.runId;
  if (!runId) {
    const session = await getSessionState(args.redis, tenantId, args.context.runId);
    runId = session?.workflowExecution?.runId;
  }
  if (!runId) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_NO_WORKFLOW_EXECUTION',
      `validator handler could not read workflowExecution (neither args.workflowExecution nor SessionHotState.workflowExecution for session ${args.context.runId}) — the validator step must run inside an active workflow run`,
      startTime,
      'configuration',
    );
    return null;
  }

  let run: Awaited<ReturnType<typeof loadRunById>>;
  try {
    run = await loadRunById(db, tenantId, spaceId, runId);
  } catch (err) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_RUN_LOAD_FAILED',
      `loadRunById: ${err instanceof Error ? err.message : String(err)}`,
      startTime,
      'internal',
    );
    return null;
  }
  if (!run) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_RUN_NOT_FOUND',
      `workflow run ${runId} not found for consumer task=${consumerTaskId}`,
      startTime,
      'configuration',
    );
    return null;
  }

  let workflow: Workflow;
  try {
    const resolved = await resolveWorkflowForRunRevision(
      db,
      tenantId,
      spaceId,
      run.workflowSlug,
      run.workflowRevision,
    );
    workflow = resolved.workflow;
  } catch (err) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_WORKFLOW_LOAD_FAILED',
      `resolveWorkflowForRunRevision: ${err instanceof Error ? err.message : String(err)}`,
      startTime,
      'internal',
    );
    return null;
  }

  const task: WorkflowTask | undefined = workflow.tasks.find((t) => t.taskId === consumerTaskId);
  if (!task) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_TASK_NOT_FOUND',
      `consumer task=${consumerTaskId} not in workflow ${workflow.slug}@${String(workflow.revision)}`,
      startTime,
      'configuration',
    );
    return null;
  }

  return {
    consumerTaskId,
    inputBindings: task.inputBindings ?? {},
  };
}

// ============================================================================
// Violation → ContractError conversion
// ============================================================================

/**
 * Convert pure-validator violations into typed `ContractError` envelopes.
 *
 * `bindAs` resolution: looks up the consumer's `inputBindings[bindAs]` and
 * pulls `taskId` (for `task_output` / `task_summary` kinds) as the
 * producer. Bindings that don't reference a producer (`run_input`,
 * `system_feedback`) won't be reported by the Phase C validators (their
 * violations always blame `task_output`-typed bindings); if one is
 * encountered defensively, the violation falls through as a non-binding
 * error and the consumer routes it as a generic failure.
 */
export function violationsToContractErrors(
  violations: ComposeValidationViolation[],
  consumerTaskId: string,
  inputBindings: Record<string, WorkflowTaskInputBinding>,
): ContractError[] {
  const errors: ContractError[] = [];
  for (const violation of violations) {
    const binding = inputBindings[violation.bindAs];
    if (!binding || (binding.kind !== 'task_output' && binding.kind !== 'task_summary')) {
      // Unbound or non-producer binding kind — emit as platform error so
      // the router knows this isn't producer-attributable. (Should not
      // happen in well-formed Phase C workflows; defense-in-depth.)
      errors.push({
        code: 'CONTRACT_INPUT_INVALID',
        consumerTaskId,
        contractName: violation.contractName,
        source: { kind: 'platform' },
        expectedSchema: {},
        zodIssues: [{ path: violation.path ?? [], message: violation.message }],
        blame: 'platform',
      });
      continue;
    }
    errors.push({
      code: 'CONTRACT_INPUT_INVALID',
      consumerTaskId,
      contractName: violation.contractName,
      source: {
        kind: 'binding',
        bindAs: violation.bindAs,
        producerTaskId: binding.taskId,
      },
      // Generic — the violation message + zodIssues carry the actionable
      // detail. Producer-rerun feedback uses these.
      expectedSchema: {},
      zodIssues: [{ path: violation.path ?? [], message: violation.message }],
      blame: 'producer-contract',
    });
  }
  return errors;
}

// ============================================================================
// Shared validator-emission flow
// ============================================================================

async function emitValidationOutcome(
  args: InlineHandlerArgs,
  result: ComposeValidationResult,
  ctx: ConsumerContext,
  startTime: number,
  failureCode: string,
): Promise<void> {
  if (result.valid) {
    await emitStepSuccess(args, { valid: true }, startTime);
    return;
  }
  const errors = violationsToContractErrors(
    result.violations,
    ctx.consumerTaskId,
    ctx.inputBindings,
  );
  await emitContractFailure(args, failureCode, errors, startTime);
}

interface ParseableSchema<T> {
  safeParse: (raw: unknown) =>
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
}

interface ZodIssueLite {
  path: Array<string | number>;
  message: string;
}

/**
 * `parseInlineInput` outcomes:
 *   - `ok` — input parsed; proceed.
 *   - `emitted` — a non-attributable infra failure (non-inline ref / JSON
 *     parse) already surfaced a terminal step error; the caller just returns.
 *   - `schema_invalid` — the input failed the Zod schema. These issues ARE
 *     producer-attributable (the draft a producer task emitted is malformed
 *     per the IR), so the caller routes them as producer-contract failures
 *     (Plan 206 §2.2) instead of dying terminally.
 */
type InlineParseOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'emitted' }
  | { status: 'schema_invalid'; issues: ZodIssueLite[] };

async function parseInlineInput<T>(
  args: InlineHandlerArgs,
  schema: ParseableSchema<T>,
  startTime: number,
): Promise<InlineParseOutcome<T>> {
  let raw: unknown;
  try {
    raw = await readInlineOpInput(args);
  } catch (err) {
    await emitStepError(
      args,
      'COMPOSE_VALIDATOR_INPUT_READ_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'configuration',
    );
    return { status: 'emitted' };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'schema_invalid', issues: parsed.error.issues };
  }
  return { status: 'ok', data: parsed.data };
}

/** Stable contract name for input-schema (Zod-parse) failures — keeps the
 *  producer-rerun budget bucketed consistently across reruns. */
const INPUT_SCHEMA_CONTRACT = 'compose-input-schema';

/** Compose-validator input binding names — the legal `bindAs` values. The
 *  `satisfies` guards against a typo drifting from the violation union. */
const COMPOSE_BINDING_NAMES = [
  'surface',
  'draft',
  'intent',
  'evals',
  'assembled',
] as const satisfies ReadonlyArray<ComposeValidationViolation['bindAs']>;

/**
 * Map a Zod issue's path head to its consumer binding. `draft` is bound on
 * every compose validator, so an unattributable head (e.g. a root-level issue)
 * falls back to it — the rerunnable producer, never a silent terminal.
 */
function bindAsForPathHead(head: unknown): ComposeValidationViolation['bindAs'] {
  return typeof head === 'string' && (COMPOSE_BINDING_NAMES as readonly string[]).includes(head)
    ? (head as ComposeValidationViolation['bindAs'])
    : 'draft';
}

/**
 * Route an input Zod-parse failure to its producer (Plan 206 §2.2). Each issue
 * is attributed by its path head (`draft.*` / `intent.*` / `surface.*`) to the
 * consumer's binding of that name, then emitted as a producer-contract
 * `ContractError` so Plan 202's lane re-runs the producer (e.g. `draft.*` →
 * `draft-task-graph`) with the issues as `system_feedback`. Issues whose head
 * is not a producer-bound input fall through to a `platform`-blame error
 * (non-routable, terminal) inside `violationsToContractErrors`.
 */
async function routeInputSchemaFailure(
  args: InlineHandlerArgs,
  issues: ZodIssueLite[],
  ctx: ConsumerContext,
  startTime: number,
): Promise<void> {
  const violations: ComposeValidationViolation[] = issues.map((i) => ({
    bindAs: bindAsForPathHead(i.path[0]),
    contractName: INPUT_SCHEMA_CONTRACT,
    path: i.path.slice(1),
    message: i.message,
  }));
  const errors = violationsToContractErrors(violations, ctx.consumerTaskId, ctx.inputBindings);
  await emitContractFailure(args, 'CONTRACT_INPUT_INVALID', errors, startTime);
  getOrchestratorLogger().info(
    `[compose-validator] task=${ctx.consumerTaskId} input schema invalid; routed ${String(errors.length)} contract error(s) for producer fix`,
  );
}

// ============================================================================
// Handler: skill.compose.validate_task_graph
// ============================================================================

export async function handleValidateTaskGraphInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const parsed = await parseInlineInput(args, ValidateTaskGraphInputSchema, startTime);
  if (parsed.status === 'emitted') return;
  const ctx = await loadConsumerContext(args, startTime);
  if (!ctx) return;
  if (parsed.status === 'schema_invalid') {
    await routeInputSchemaFailure(args, parsed.issues, ctx, startTime);
    return;
  }
  const result = validateTaskGraphSelfConsistent(parsed.data.draft);
  await emitValidationOutcome(args, result, ctx, startTime, 'CONTRACT_INPUT_INVALID');
  if (!result.valid) {
    getOrchestratorLogger().info(
      `[validate_task_graph] task=${ctx.consumerTaskId} violations=${String(result.violations.length)}`,
    );
  }
}

// ============================================================================
// Handler: skill.compose.validate_source_coverage
// ============================================================================

export async function handleValidateSourceCoverageInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const parsed = await parseInlineInput(args, ValidateSourceCoverageInputSchema, startTime);
  if (parsed.status === 'emitted') return;
  const ctx = await loadConsumerContext(args, startTime);
  if (!ctx) return;
  if (parsed.status === 'schema_invalid') {
    await routeInputSchemaFailure(args, parsed.issues, ctx, startTime);
    return;
  }
  const result = validateSourceCoverage(parsed.data.intent, parsed.data.draft);
  await emitValidationOutcome(args, result, ctx, startTime, 'CONTRACT_INPUT_INVALID');
  if (!result.valid) {
    getOrchestratorLogger().info(
      `[validate_source_coverage] task=${ctx.consumerTaskId} violations=${String(result.violations.length)}`,
    );
  }
}

// ============================================================================
// Handler: capability.validate_grants
// ============================================================================

export async function handleCapabilityValidateGrantsInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const parsed = await parseInlineInput(args, CapabilityValidateGrantsInputSchema, startTime);
  if (parsed.status === 'emitted') return;
  const ctx = await loadConsumerContext(args, startTime);
  if (!ctx) return;
  if (parsed.status === 'schema_invalid') {
    await routeInputSchemaFailure(args, parsed.issues, ctx, startTime);
    return;
  }
  const result = validateSurfaceConformance(parsed.data.draft, parsed.data.surface);
  await emitValidationOutcome(args, result, ctx, startTime, 'CONTRACT_INPUT_INVALID');
  if (!result.valid) {
    getOrchestratorLogger().info(
      `[capability_validate_grants] task=${ctx.consumerTaskId} violations=${String(result.violations.length)}`,
    );
  }
}
