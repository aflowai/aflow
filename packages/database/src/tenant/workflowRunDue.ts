/**
 * The workflow-run reconciler's view of the shared due-pointer mechanism.
 *
 * Everything structural — why arming is a trigger, why nothing disarms, why the
 * seed lives in the installing migration — is in `tenantDue.ts`; the pointer's
 * own sources are in `duePointers.ts`. This file exists so the reconciler and
 * its migration name one domain rather than a generic pointer plus a constant.
 */
import { WORKFLOW_RUN_DUE_POINTER } from './duePointers.js';
import {
  tenantDuePointerDdl,
  tenantDueRecomputeSql,
  tenantDueSeedDdl,
  tenantDueTriggerDdl,
  tenantDueTriggerName,
  type TenantDueSource,
} from './tenantDue.js';

export type WorkflowRunDueSource = TenantDueSource;

export const WORKFLOW_RUN_DUE_SOURCES: readonly WorkflowRunDueSource[] =
  WORKFLOW_RUN_DUE_POINTER.sources;
export const WORKFLOW_RUN_DUE_TABLE = WORKFLOW_RUN_DUE_POINTER.table;
export const WORKFLOW_RUN_DUE_TRIGGER = WORKFLOW_RUN_DUE_POINTER.trigger;

export function workflowRunDuePointerDdl(): string {
  return tenantDuePointerDdl(WORKFLOW_RUN_DUE_POINTER);
}

export function workflowRunDueTriggerDdl(schemaName: string): string {
  return tenantDueTriggerDdl(WORKFLOW_RUN_DUE_POINTER, schemaName);
}

export function workflowRunDueTriggerNameFor(source: WorkflowRunDueSource): string {
  return tenantDueTriggerName(WORKFLOW_RUN_DUE_POINTER, source);
}

export function workflowRunDueRecomputeSql(schemaName: string): string {
  return tenantDueRecomputeSql(WORKFLOW_RUN_DUE_POINTER, schemaName);
}

export function workflowRunDueSeedDdl(schemaName: string): string {
  return tenantDueSeedDdl(WORKFLOW_RUN_DUE_POINTER, schemaName);
}
