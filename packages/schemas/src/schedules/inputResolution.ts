/**
 * Source run context for on_completion schedules.
 */
export interface SourceRunContext {
  runId: string;
  status: string;
  output?: unknown;
  input?: unknown;
}

/**
 * Memory resolver function — provided by the orchestrator at fire time.
 * Reads a memory document by path within the schedule's space.
 */
export type MemoryResolver = (
  path: string,
  view: 'content' | 'metadata' | 'summary',
) => Promise<unknown>;

/**
 * Resolution context for input template processing.
 */
export interface InputResolutionContext {
  sourceRun?: SourceRunContext;
  resolveMemory?: MemoryResolver;
  now?: Date;
}

/**
 * Check if a value is a $memoryRef reference.
 */
function isMemoryRef(value: unknown): value is { $memoryRef: string; view?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$memoryRef' in value &&
    typeof (value as Record<string, unknown>)['$memoryRef'] === 'string'
  );
}

/**
 * Check if a value is a $sourceRef reference.
 */
function isSourceRef(value: unknown): value is { $sourceRef: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$sourceRef' in value &&
    typeof (value as Record<string, unknown>)['$sourceRef'] === 'string'
  );
}

/**
 * Check if a value is a $now reference.
 */
function isNowRef(value: unknown): value is { $now: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$now' in value &&
    typeof (value as Record<string, unknown>)['$now'] === 'string'
  );
}

/**
 * Resolve a single template value.
 */
async function resolveValue(value: unknown, ctx: InputResolutionContext): Promise<unknown> {
  if (value === null || value === undefined) return value;

  if (isNowRef(value)) {
    const now = ctx.now ?? new Date();
    switch (value.$now) {
      case 'iso':
        return now.toISOString();
      case 'date':
        return now.toISOString().slice(0, 10);
      case 'epoch':
        return now.getTime();
      default:
        return now.toISOString();
    }
  }

  if (isSourceRef(value)) {
    if (!ctx.sourceRun) {
      throw new Error(
        '$sourceRef used but no source run context available (not an on_completion schedule)',
      );
    }
    switch (value.$sourceRef) {
      case 'runId':
        return ctx.sourceRun.runId;
      case 'output':
        return ctx.sourceRun.output;
      case 'status':
        return ctx.sourceRun.status;
      case 'input':
        return ctx.sourceRun.input;
      default:
        throw new Error(`Unknown $sourceRef field: ${value.$sourceRef}`);
    }
  }

  if (isMemoryRef(value)) {
    if (!ctx.resolveMemory) {
      throw new Error('$memoryRef used but no memory resolver available');
    }
    const view = value.view === 'metadata' || value.view === 'summary' ? value.view : 'content';
    return ctx.resolveMemory(value.$memoryRef, view);
  }

  // Recurse into objects
  if (typeof value === 'object' && !Array.isArray(value)) {
    return resolveInputTemplate(value as Record<string, unknown>, ctx);
  }

  // Recurse into arrays
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const item of value) {
      resolved.push(await resolveValue(item, ctx));
    }
    return resolved;
  }

  // Literal passthrough
  return value;
}

/**
 * Resolve an input template, replacing all $memoryRef, $sourceRef,
 * and $now references with their resolved values.
 *
 * @param template - Input template from the schedule record
 * @param ctx - Resolution context with memory resolver and source run
 * @returns Resolved input object
 */
export async function resolveInputTemplate(
  template: Record<string, unknown>,
  ctx: InputResolutionContext,
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(template)) {
    resolved[key] = await resolveValue(value, ctx);
  }

  return resolved;
}
