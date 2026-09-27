/**
 * The eval-batch engine's view of the shared due-pointer mechanism.
 *
 * Everything structural — why arming is a trigger, why nothing disarms, why the
 * seed lives in the installing migration — is in `tenantDue.ts`; the pointer's
 * own sources are in `duePointers.ts`. This file exists so the engine and its
 * migration name one domain rather than a generic pointer plus a constant.
 */
import { EVAL_BATCH_DUE_POINTER } from './duePointers.js';
import {
  tenantDuePointerDdl,
  tenantDueRecomputeSql,
  tenantDueSeedDdl,
  tenantDueTriggerDdl,
  type TenantDueSource,
} from './tenantDue.js';

export type EvalBatchDueSource = TenantDueSource;

export const EVAL_BATCH_DUE_SOURCES: readonly EvalBatchDueSource[] = EVAL_BATCH_DUE_POINTER.sources;
export const EVAL_BATCH_DUE_TABLE = EVAL_BATCH_DUE_POINTER.table;
export const EVAL_BATCH_DUE_TRIGGER = EVAL_BATCH_DUE_POINTER.trigger;

export function evalBatchDuePointerDdl(): string {
  return tenantDuePointerDdl(EVAL_BATCH_DUE_POINTER);
}

export function evalBatchDueTriggerDdl(schemaName: string): string {
  return tenantDueTriggerDdl(EVAL_BATCH_DUE_POINTER, schemaName);
}

export function evalBatchDueRecomputeSql(schemaName: string): string {
  return tenantDueRecomputeSql(EVAL_BATCH_DUE_POINTER, schemaName);
}

export function evalBatchDueSeedDdl(schemaName: string): string {
  return tenantDueSeedDdl(EVAL_BATCH_DUE_POINTER, schemaName);
}
