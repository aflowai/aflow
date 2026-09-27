import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  DEFAULT_CYBERNETIC_MODEL,
  type TaskContextSpec,
  type TaskCapabilityGrant,
} from '@aflow/schemas';
import { assembleContext } from './contextAssembler.js';
import { formatLearningLines } from './learningRender.js';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Fallback model when no caller-supplied or directive-resolved model is provided. */
const RUNNER_MODEL_FALLBACK = DEFAULT_CYBERNETIC_MODEL;

// ============================================================================
// Types
// ============================================================================

export interface RunnerDelegationContext {
  /** Model to use for the Runner. */
  runnerModel: string;
  /**
   * Reasoning effort override for the Runner — propagated from the space's
   * `reasoningDefaults.runner` via `resolveRunnerReasoningHot`. Undefined →
   * the catalog model's default reasoning applies (or provider default if
   * the model declares none).
   */
  runnerReasoningEffort?: 'off' | 'low' | 'medium' | 'high' | undefined;
  /** Generated system prompt for the Runner. */
  runnerSystemPrompt: string;
  /** Tool IDs the Runner should have. */
  runnerTools: string[];
  capabilityGrants?: TaskCapabilityGrant;
  /** Assembled context as a formatted string for injection ('' when none). */
  taskContext: string;
  /** Learnings formatted for injection ('' when none). */
  taskLearnings: string;
  /** Output schema for submit_output validation (104j §6.9). */
  outputSchema?: Record<string, unknown>;
  taskInputs?: Record<string, unknown>;
}

export interface WorkerTask {
  taskId: string;
  name: string;
  goal: string;
  outputContract?: {
    metrics?: Record<string, string>;
    artifacts?: string[];
    schema?: Record<string, unknown>;
    // validatorRefs removed 2026-05-06 with the runtime provenance gate.
  };
}

// ============================================================================
// Formatters
// ============================================================================

/**
 * Build the Runner system prompt from the task definition.
 */
function buildRunnerSystemPrompt(task: WorkerTask): string {
  const lines: string[] = [
    'You are executing a specific task within a procedure.',
    '',
    `TASK: ${task.name}`,
    `GOAL: ${task.goal}`,
  ];

  // Derive DONE WHEN from outputContract
  const doneConditions: string[] = [];

  if (task.outputContract?.metrics) {
    for (const [metric, description] of Object.entries(task.outputContract.metrics)) {
      doneConditions.push(`- ${metric}: ${description}`);
    }
  }

  if (task.outputContract?.artifacts) {
    for (const artifact of task.outputContract.artifacts) {
      doneConditions.push(`- Produce artifact: ${artifact}`);
    }
  }

  if (doneConditions.length > 0) {
    lines.push('', 'DONE WHEN:', ...doneConditions);
  }

  lines.push(
    '',
    'CONSTRAINTS:',
    '- Use only the tools provided.',
    '- Complete the task or report why you cannot.',
    '- Do not explore tangentially.',
  );

  return lines.join('\n');
}

/**
 * Format assembled memory content into a readable text block.
 */
function formatTaskContext(
  memoryContent: Array<{ path: string; content: string; preview?: string }>,
): string {
  if (memoryContent.length === 0) return '';

  const blocks: string[] = [];

  for (const doc of memoryContent) {
    const header = `--- ${doc.path} ---`;
    const body = doc.content || doc.preview || '(empty)';
    blocks.push(`${header}\n${body}`);
  }

  return blocks.join('\n\n');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build the delegation context for the cybernetic Runner.
 *
 * Assembles the task context (if a contextSpec is provided), builds the
 * Runner system prompt, and formats all state variables the Runner receives.
 */
export async function buildRunnerDelegationContext(params: {
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  task: WorkerTask;
  contextSpec?: TaskContextSpec;
  runId?: string;
  runnerModel?: string;
  /**
   * Reasoning effort override resolved by the caller via
   * `resolveRunnerReasoningHot`. Undefined → catalog model default applies.
   */
  runnerReasoningEffort?: 'off' | 'low' | 'medium' | 'high' | undefined;
  db: PostgresJsDatabase;
  taskInputs?: Record<string, unknown>;
}): Promise<RunnerDelegationContext> {
  const {
    tenantId,
    spaceId,
    workflowSlug,
    task,
    contextSpec,
    runId,
    runnerModel,
    runnerReasoningEffort,
    db,
    taskInputs,
  } = params;

  const logger = getCyberneticLogger();
  logger.debug(
    `delegationContextBuilder: building for task=${task.taskId}, workflow=${workflowSlug}`,
  );

  // 1. Assemble context if spec exists
  const assembled = contextSpec
    ? await assembleContext({
        tenantId,
        spaceId,
        taskContextSpec: contextSpec,
        workflowSlug,
        taskId: task.taskId,
        db,
        ...(runId != null ? { runId } : {}),
      })
    : undefined;

  // 2. Build Runner system prompt
  const runnerSystemPrompt = buildRunnerSystemPrompt(task);

  // 3. Format context blocks
  const taskContext = assembled ? formatTaskContext(assembled.memoryContent) : '';

  const taskLearnings = assembled ? formatLearningLines(assembled.learnings) : '';

  // 4. Collect tools
  const runnerTools = assembled ? assembled.tools : [];

  // 5. Select model — caller already applied the
  //    task.model → directives.modelDefaults.runner → default chain.
  const resolvedRunnerModel = runnerModel ?? RUNNER_MODEL_FALLBACK;

  const result: RunnerDelegationContext = {
    runnerModel: resolvedRunnerModel,
    ...(runnerReasoningEffort !== undefined ? { runnerReasoningEffort } : {}),
    runnerSystemPrompt,
    runnerTools,
    ...(assembled?.capabilityGrants ? { capabilityGrants: assembled.capabilityGrants } : {}),
    taskContext,
    taskLearnings,
    ...(task.outputContract?.schema ? { outputSchema: task.outputContract.schema } : {}),
    // outputValidatorRefs propagation removed 2026-05-06 with the runtime
    // provenance gate.
    ...(taskInputs && Object.keys(taskInputs).length > 0 ? { taskInputs } : {}),
  };

  return result;
}
