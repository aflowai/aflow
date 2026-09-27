import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  createMemoryDocRepository,
  type TenantContext,
} from '@aflow/database';
import type { StagedChange, TenantId } from '@aflow/schemas';
import { StagedChangeSchema } from '@aflow/schemas';
import { proposalPath } from './resolveProposalRoute.js';
import type { RatificationApplyError } from './applyRatifiedOps.js';
import { getCyberneticLogger } from '../logger.js';

export interface PersistRatificationErrorContext {
  tenantId: string;
  spaceId: string;
  db: PostgresJsDatabase;
}

/**
 * Update the staged-change doc with a `lastRatificationError` snapshot.
 *
 * Best-effort: callers should still surface the original
 * `RatificationApplyError` to the operator (this helper updates state
 * for the next page-load; the operator sees the error on the current
 * page via the error response).
 *
 * Returns the updated `StagedChange` on success, or `null` if the proposal
 * doc could not be loaded / re-persisted. Failures are logged but never
 * thrown — a write failure here must not bubble up and confuse the caller,
 * who is already returning a 422 from the original apply failure.
 */
export async function persistRatificationError(
  ctx: PersistRatificationErrorContext,
  sc: StagedChange,
  err: RatificationApplyError,
): Promise<StagedChange | null> {
  const logger = getCyberneticLogger();
  try {
    const tenantCtx: TenantContext = createTenantContext(ctx.tenantId as TenantId);
    const docRepo = createMemoryDocRepository(ctx.db, tenantCtx);
    const path = proposalPath(sc.resolutionRoute, sc.id);

    // Clamp before validation: `StagedChangeSchema` caps `op` at 120 chars
    // and `detail` at 500. Real RatificationApplyError sites emit full Zod
    // messages / graph-validation details that easily blow past those
    // limits — pre-clamping is essential so the snapshot doesn't get
    // silently dropped on parse failure.
    const clampedOp = err.op.length > 120 ? `${err.op.slice(0, 117)}...` : err.op;
    const clampedDetail = err.detail.length > 500 ? `${err.detail.slice(0, 497)}...` : err.detail;

    const updated: StagedChange = {
      ...sc,
      lastRatificationError: {
        reason: err.reason,
        op: clampedOp,
        detail: clampedDetail,
        at: new Date().toISOString(),
      },
    };

    // Re-validate before writing — guards against drift if StagedChangeSchema
    // ever loses the field or constraints change.
    const validated = StagedChangeSchema.parse(updated);
    const content = JSON.stringify(validated, null, 2);

    await docRepo.put({
      path,
      writeMode: 'upsert',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags:
        validated.resolutionRoute === 'platform_issue'
          ? ['coach', 'platform-issue']
          : ['coach', 'staged'],
      summary: validated.proposal.summary,
      semanticType: 'staged_change',
      indexing: 'disabled',
      scope: { spaceId: ctx.spaceId },
      provenance: { actor: 'system:ratification-error-persist' },
    });

    return validated;
  } catch (persistErr) {
    logger.warn('persistRatificationError: failed to update proposal doc', {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      proposalId: sc.id,
      reason: err.reason,
      op: err.op,
      error: persistErr instanceof Error ? persistErr.message : String(persistErr),
    });
    return null;
  }
}
