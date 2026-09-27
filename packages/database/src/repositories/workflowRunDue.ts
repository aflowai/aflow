/**
 * The workflow-run reconciler's reader over the shared due-pointer mechanism.
 * Claim, settle, and lease semantics all live in `tenantDue.ts`.
 */
import type postgres from 'postgres';
import { WORKFLOW_RUN_DUE_POINTER } from '../tenant/duePointers.js';
import {
  armTenantDueFromTenant,
  claimDueTenants,
  clearTenantDue,
  releaseTenantDueClaim,
  settleTenantDue,
  type TenantDueClaim,
  type TenantDueSettlement,
} from './tenantDue.js';

export type WorkflowRunDueClaim = TenantDueClaim;
export type WorkflowRunDueSettlement = TenantDueSettlement;

export async function claimDueWorkflowRunTenants(
  sqlClient: postgres.Sql,
  args: { limit: number; leaseMs: number; claimToken: string },
): Promise<WorkflowRunDueClaim[]> {
  return claimDueTenants(sqlClient, WORKFLOW_RUN_DUE_POINTER, args);
}

export async function settleWorkflowRunTenantDue(
  sqlClient: postgres.Sql,
  claim: WorkflowRunDueClaim,
  claimToken: string,
): Promise<WorkflowRunDueSettlement> {
  return settleTenantDue(sqlClient, WORKFLOW_RUN_DUE_POINTER, claim, claimToken);
}

export async function releaseWorkflowRunTenantClaim(
  sqlClient: postgres.Sql,
  tenantId: string,
  claimToken: string,
): Promise<void> {
  return releaseTenantDueClaim(sqlClient, WORKFLOW_RUN_DUE_POINTER, tenantId, claimToken);
}

export async function armWorkflowRunDueFromTenant(
  sqlClient: postgres.Sql,
  tenantId: string,
): Promise<boolean> {
  return armTenantDueFromTenant(sqlClient, WORKFLOW_RUN_DUE_POINTER, tenantId);
}

export async function clearWorkflowRunDueForTenant(
  sqlClient: postgres.Sql,
  tenantId: string,
): Promise<void> {
  return clearTenantDue(sqlClient, [WORKFLOW_RUN_DUE_POINTER], tenantId);
}
