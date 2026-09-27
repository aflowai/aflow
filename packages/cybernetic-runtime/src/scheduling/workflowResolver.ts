import { parseOutputPath, readParsedOutputPath, type OutputPathSegment } from './outputPath.js';

// ============================================================================
// Types
// ============================================================================

/** Snapshot of a completed task's output for resolver lookups. */
export interface TaskOutputSnapshot {
  /** Structured output object (decoded from outputRef). */
  output?: Record<string, unknown>;
  /** Metrics object (from metricsJson). */
  metrics?: Record<string, unknown>;
  /** Summary string. */
  summary?: string;
  /** Task completion status. */
  status: string;
}

/** Full workflow-run context available for resolution. */
export interface WorkflowRunContext {
  /** Run input object (materialized at run start). */
  runInput?: Record<string, unknown>;
  /** Completed task outputs indexed by taskId. */
  taskOutputs: Map<string, TaskOutputSnapshot>;
  /** Promoted state variable values indexed by variableId. */
  stateVariables: Map<string, unknown>;
  campaignConfig?: Record<string, unknown>;
}

/** Result of resolving a single value. */
export type ResolveResult = { ok: true; value: unknown } | { ok: false; reason: string };

// ============================================================================
// Path extraction (envelope over the shared output-path dialect)
// ============================================================================

function describeSegment(segment: OutputPathSegment): string {
  return segment.kind === 'key' ? `"${segment.key}"` : `[${String(segment.index)}]`;
}

export function extractByPath(obj: unknown, path: string): ResolveResult {
  if (!path || path.length === 0) {
    return { ok: true, value: obj };
  }

  const segments = parseOutputPath(path);
  if (segments === null) {
    return { ok: false, reason: `Path "${path}" is not a valid output path` };
  }

  let current: unknown = obj;
  for (const segment of segments) {
    const next = readParsedOutputPath(current, [segment]);
    if (next === undefined) {
      return {
        ok: false,
        reason: `Path "${path}" does not resolve at segment ${describeSegment(segment)}`,
      };
    }
    current = next;
  }

  return { ok: true, value: current };
}

// ============================================================================
// Input binding resolution
// ============================================================================

/**
 * Resolve a single input binding against the workflow-run context.
 */
export function resolveInputBinding(
  binding: {
    kind: string;
    path?: string;
    taskId?: string;
    metric?: string;
    variableId?: string;
  },
  context: WorkflowRunContext,
): ResolveResult {
  switch (binding.kind) {
    case 'run_input': {
      if (!context.runInput) {
        return { ok: false, reason: 'Run input not available' };
      }
      return extractByPath(context.runInput, binding.path ?? '');
    }

    case 'task_output': {
      const snapshot = context.taskOutputs.get(binding.taskId!);
      if (!snapshot) {
        return { ok: false, reason: `Task "${binding.taskId!}" has not completed` };
      }
      if (!snapshot.output) {
        return { ok: false, reason: `Task "${binding.taskId!}" has no structured output` };
      }
      return extractByPath(snapshot.output, binding.path ?? '');
    }

    case 'task_summary': {
      const snapshot = context.taskOutputs.get(binding.taskId!);
      if (!snapshot) {
        return { ok: false, reason: `Task "${binding.taskId!}" has not completed` };
      }
      if (snapshot.summary === undefined) {
        return { ok: false, reason: `Task "${binding.taskId!}" has no summary` };
      }
      return { ok: true, value: snapshot.summary };
    }

    case 'campaign_input': {
      if (!context.campaignConfig) {
        return { ok: false, reason: 'Campaign config not available' };
      }
      return extractByPath(context.campaignConfig, binding.path ?? '');
    }

    default:
      return { ok: false, reason: `Unknown binding kind: ${binding.kind}` };
  }
}

/**
 * Resolve all input bindings for a task.
 *
 * Starts from `baseInputs` (the literal `task.inputs` object),
 * overlays resolved binding values, and returns the merged result.
 *
 * @returns The merged input object, or an array of errors if any bindings failed.
 */
export function resolveTaskInputBindings(
  bindings: Record<
    string,
    { kind: string; path?: string; taskId?: string; metric?: string; variableId?: string }
  >,
  context: WorkflowRunContext,
  baseInputs?: Record<string, unknown>,
):
  | { ok: true; resolved: Record<string, unknown> }
  | { ok: false; errors: Array<{ field: string; reason: string }> } {
  const resolved: Record<string, unknown> = { ...baseInputs };
  const errors: Array<{ field: string; reason: string }> = [];

  for (const [fieldName, binding] of Object.entries(bindings)) {
    const result = resolveInputBinding(binding, context);
    if (result.ok) {
      resolved[fieldName] = result.value;
    } else {
      errors.push({ field: fieldName, reason: result.reason });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, resolved };
}
