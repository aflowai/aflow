/**
 * The eval-batch engine's reader over the shared due-pointer mechanism.
 * Claim, settle, and lease semantics all live in `tenantDue.ts`.
 */
import type postgres from 'postgres';
import { EVAL_BATCH_DUE_POINTER } from '../tenant/duePointers.js';
import {
  claimDueTenants,
  clearTenantDue,
  releaseTenantDueClaim,
  settleTenantDue,
  type TenantDueClaim,
  type TenantDueSettlement,
} from './tenantDue.js';

export type EvalBatchDueClaim = TenantDueClaim;
export type EvalBatchDueSettlement = TenantDueSettlement;

export async function claimDueEvalBatchTenants(
  sqlClient: postgres.Sql,
  args: { limit: number; leaseMs: number; claimToken: string },
): Promise<EvalBatchDueClaim[]> {
  return claimDueTenants(sqlClient, EVAL_BATCH_DUE_POINTER, args);
}

export async function settleEvalBatchTenantDue(
  sqlClient: postgres.Sql,
  claim: EvalBatchDueClaim,
  claimToken: string,
): Promise<EvalBatchDueSettlement> {
  return settleTenantDue(sqlClient, EVAL_BATCH_DUE_POINTER, claim, claimToken);
}

export async function releaseEvalBatchTenantClaim(
  sqlClient: postgres.Sql,
  tenantId: string,
  claimToken: string,
): Promise<void> {
  return releaseTenantDueClaim(sqlClient, EVAL_BATCH_DUE_POINTER, tenantId, claimToken);
}

export async function clearEvalBatchDueForTenant(
  sqlClient: postgres.Sql,
  tenantId: string,
): Promise<void> {
  return clearTenantDue(sqlClient, [EVAL_BATCH_DUE_POINTER], tenantId);
}
