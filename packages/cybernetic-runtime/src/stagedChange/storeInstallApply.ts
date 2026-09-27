/**
 * Ratification handler for `store_install` proposals. The agent only ever
 * proposes; ratifying runs the same shared install execution the Store's
 * HTTP surface uses — including a fresh `expectedVersion` check against the
 * live catalog, so a listing that changed between propose and ratify fails
 * ratification visibly instead of installing content the operator never
 * reviewed.
 */
import type { StagedChange, TenantId } from '@aflow/schemas';
import { getCyberneticLogger } from '../logger.js';
import {
  executeStoreInstall,
  type ExecuteStoreInstallResult,
} from '../store/storeInstallExecution.js';
import type { ApplyContext, ApplyResult } from './applyRatifiedOps.js';
import { RatificationApplyError } from './applyRatifiedOps.js';

const TRANSIENT_CODES = new Set(['STORE_MUTATION_IN_PROGRESS', 'REMOVAL_IN_PROGRESS']);

function failureReason(failure: Extract<ExecuteStoreInstallResult, { ok: false }>) {
  if (failure.body.code !== undefined && TRANSIENT_CODES.has(failure.body.code)) {
    return 'transient' as const;
  }
  // A vanished or version-moved listing cannot be ratified — the proposal
  // must be re-authored against the current catalog.
  if (failure.statusCode === 404 || failure.body.code === 'CATALOG_CHANGED') {
    return 'target_skill_missing' as const;
  }
  return 'post_validation' as const;
}

export async function applyStoreInstallOps(
  ctx: ApplyContext,
  stagedChange: StagedChange,
): Promise<ApplyResult> {
  const logger = getCyberneticLogger();
  const op = stagedChange.proposal.ops[0];
  if (stagedChange.proposal.ops.length !== 1 || op?.op !== 'store_install') {
    throw new RatificationApplyError(
      op?.op ?? 'store_install',
      `A store_install proposal must carry exactly one 'store_install' op.`,
      'post_validation',
    );
  }

  const result = await executeStoreInstall({
    db: ctx.db,
    redis: ctx.redis ?? null,
    tenantId: ctx.tenantId as TenantId,
    spaceId: ctx.spaceId,
    actorUserId: ctx.actorUserId ?? 'operator',
    payloadStore: ctx.payloadStore,
    catalogId: op.catalogId,
    expectedVersion: op.expectedVersion,
    // The proposal id makes a re-clicked ratify replay the recorded install.
    idempotencyKey: stagedChange.id,
  });

  if (!result.ok) {
    throw new RatificationApplyError('store_install', result.body.error, failureReason(result));
  }

  logger.info(
    `[storeInstallApply] Installed '${op.catalogId}' v${String(op.expectedVersion)} ` +
      `(space ${ctx.spaceId}, proposal ${stagedChange.id})`,
  );

  const setupChecklist = result.response.setupChecklist;
  return {
    applied: true,
    appliedOps: ['store_install'],
    skippedOps: [],
    ...(setupChecklist.length > 0 ? { setupChecklist } : {}),
  };
}
