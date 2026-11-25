import type { Database } from '@aflow/database';
import { readWorkflowRunDryRun } from '@aflow/database';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { internalError } from '@aflow/executor-runtime';
import type { Redis } from '@aflow/redis';
import { resolveSessionDryRun } from '@aflow/cybernetic-runtime';
import {
  buildDryRunHeldOutput,
  effectiveWriteRiskTier,
  previewWrite,
  requiresWriteApproval,
  WRITE_HOLD_EVERY_TIER,
  type DryRunHeldOutput,
  type DryRunHeldWrite,
} from '@aflow/schemas';
import type { SaveResponseTarget } from './saveResponse.js';
import { ApiExecutionError, type ResolvedCall } from './types.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a resolved call writes. An endpoint call writes when the go-live
 * rehearsal's hold of every tier would hold it, so the two hold the same
 * calls. A direct-URL call carries no tier and writes unless its method reads.
 */
export function resolvedCallWrites(resolved: Pick<ResolvedCall, 'endpoint' | 'method'>): boolean {
  if (resolved.endpoint) {
    return requiresWriteApproval(effectiveWriteRiskTier(resolved.endpoint), WRITE_HOLD_EVERY_TIER);
  }
  return !READ_METHODS.has(resolved.method.toUpperCase());
}

/**
 * The dry run this call's step works for, or null for a live step, read from
 * Postgres at the moment of the call. A workflow operation task reads its
 * run's row. A session step resolves through the session's durable link to
 * its run's row, with the session hash as a fast path only, so a corrupt or
 * deleted hash never sends a write live. Without the stores to read, or when
 * the link or row cannot be read, the call is refused and nothing is sent.
 */
async function dryRunOfStep(
  ctx: ExecutorContext,
  deps: { db?: Database | undefined; redis?: Redis | undefined },
): Promise<string | null> {
  if (!deps.db) {
    throw new ApiExecutionError(
      internalError(
        'A write needs database access to read whether its run is a dry run (server misconfiguration). The write was not sent.',
        { retryable: false },
      ),
    );
  }
  const workflowRunId = ctx.job.workflowExecution?.runId;
  if (workflowRunId !== undefined) {
    return (await readWorkflowRunDryRun(deps.db, ctx.tenantId, workflowRunId))
      ? workflowRunId
      : null;
  }
  if (!deps.redis) {
    throw new ApiExecutionError(
      internalError(
        'A session write needs Redis access to read whether its session works for a dry run (server misconfiguration). The write was not sent.',
        { retryable: false },
      ),
    );
  }
  const dryRun = await resolveSessionDryRun(
    { db: deps.db, redis: deps.redis },
    ctx.tenantId,
    ctx.runId,
  );
  if (dryRun.kind === 'unknown') {
    throw new ApiExecutionError(
      internalError(
        `Whether this session works for a dry run could not be read, so the write was not sent: ${dryRun.reason}`,
        { retryable: false },
      ),
    );
  }
  return dryRun.kind === 'dry_run' ? dryRun.runId : null;
}

export interface HeldApiWrite {
  held: DryRunHeldWrite;
  output: DryRunHeldOutput;
}

/**
 * Hold a resolved API write when its step works for a dry run. A call that
 * saves its response writes a memory document whatever its method or tier, so
 * it is held too, and every `api.http.download` is one. Returns null for a
 * read that saves nothing, and for a write of a live step, which then
 * proceeds to the write-approval gate. Runs after the body is resolved, so
 * the held record previews the exact bytes the call would have sent.
 */
export async function holdDryRunApiWrite(
  ctx: ExecutorContext,
  resolved: ResolvedCall,
  deps: { db?: Database | undefined; redis?: Redis | undefined },
  saveTo?: SaveResponseTarget,
): Promise<HeldApiWrite | null> {
  if (saveTo === undefined && !resolvedCallWrites(resolved)) return null;
  const runId = await dryRunOfStep(ctx, deps);
  if (runId === null) return null;
  const endpointName = resolved.endpoint?.endpointId ?? resolved.endpointId;
  const where = endpointName !== undefined ? `${resolved.apiId ?? ''}/${endpointName}` : '';
  let host = resolved.url;
  try {
    host = new URL(resolved.url).host;
  } catch {
    // An unparsable URL is named as given.
  }
  const saved = saveTo !== undefined ? ` saved to memory ${saveTo.path}` : '';
  const preview = previewWrite(resolved.body);
  const held: DryRunHeldWrite = {
    runId,
    operationId: ctx.operationId,
    target: `${resolved.method.toUpperCase()} ${where !== '' ? `${where} ` : ''}(${host})${saved}`,
    ...(preview !== undefined ? { preview } : {}),
  };
  return {
    held,
    output: buildDryRunHeldOutput(held, saveTo !== undefined ? { path: saveTo.path } : {}),
  };
}
