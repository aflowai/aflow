/**
 * What makes two media requests the same paid work.
 *
 * One derivation for every media operation: the async-job row, the request key
 * on the receipt, and the asset ids all hang off this identity, so a
 * re-dispatch of an attempt adopts the paid job AND resolves to the same
 * assets. A second derivation would let those three disagree.
 */
import { createHash } from 'node:crypto';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { AsyncJobIdentity, MediaCapabilityRoute } from '@aflow/schemas';
import { ASYNC_JOB_LIFECYCLE_OPERATIONS } from './mediaBudget.js';

/**
 * Read off the request rather than listed field by field: a field the provider
 * acts on that a list forgot would let two different renders share one row, and
 * the conflict path would hand the second one the first's job.
 */
export function hashMediaRequest(model: string, request: Record<string, unknown>): string {
  // A field left unset and a field set to undefined are the same render.
  const defined = Object.entries(request).filter(([, value]) => value !== undefined);
  defined.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash('sha256').update(
    JSON.stringify({ model, request: Object.fromEntries(defined) }),
  );
  // Truncated because the derived job key concatenates the whole identity and
  // the record schema caps it at 200 characters; 128 bits still cannot collide
  // within one (run, step, attempt).
  return hash.digest('hex').slice(0, 32);
}

export interface MediaRequestIdentityParams {
  provider: string;
  /** The model id the route resolved, not the key the caller named. */
  model: string;
  request: Record<string, unknown>;
}

/**
 * The route as one identity. The dispatch mode is part of it because the same
 * model line served synchronously and served as a durable job offers different
 * continuity: only the second one has a provider job to reconcile against.
 */
export function mediaCapabilityRoute(
  ctx: ExecutorContext,
  params: { provider: string; model: string; requestedModel?: string | undefined },
): MediaCapabilityRoute {
  const dispatch = ASYNC_JOB_LIFECYCLE_OPERATIONS.has(ctx.operationId) ? 'async_job' : 'sync';
  return {
    routeId: `${params.provider}:${params.model}:${dispatch}`,
    ...(params.requestedModel !== undefined ? { requestedModel: params.requestedModel } : {}),
  };
}

export function mediaRequestIdentity(
  ctx: ExecutorContext,
  params: MediaRequestIdentityParams,
): AsyncJobIdentity {
  return {
    runId: ctx.runId,
    logicalExecutionId: ctx.logicalExecutionId,
    attempt: ctx.job.attempt,
    operationId: ctx.operationId,
    provider: params.provider,
    model: params.model,
    inputHash: hashMediaRequest(params.model, params.request),
  };
}
