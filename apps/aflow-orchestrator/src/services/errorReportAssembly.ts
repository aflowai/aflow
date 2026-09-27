import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AflowError } from '@aflow/schemas';
import { shouldCreateErrorReport, createErrorReport, agentTargetKey } from '@aflow/schemas';
import { sql } from 'drizzle-orm';
import { appendErrorReport, type SessionHotState } from '@aflow/redis';
import { errorReports } from '@aflow/database';
import { logOrchestratorError } from '../lib/orchestratorLogger.js';
import { toDateSafe } from '../lib/toDateSafe.js';

export interface ErrorReportPayloadRetriever {
  retrieve(ref: string): Promise<unknown>;
}

export interface AssembleErrorReportArgs {
  redis: Redis;
  db: PostgresJsDatabase;
  payloadStore: ErrorReportPayloadRetriever | undefined;
  tenantId: string;
  runId: string;
  runState: SessionHotState;
}

/**
 * Durably record why a run failed, for the error-report surface.
 *
 * Runs on the projection path rather than at failure time because it needs the
 * error payload resolved from its ref, and because a report for a run whose
 * durable row never landed would point at nothing.
 *
 * Shared so the projection worker and the flush worker it replaces cannot
 * diverge: a failed run that produced a report under one and not the other is a
 * silent gap in the operator's only view of failures.
 */
export async function assembleErrorReport({
  redis,
  db,
  payloadStore,
  tenantId,
  runId,
  runState,
}: AssembleErrorReportArgs): Promise<void> {
  try {
    if (!runState.errorRef || !payloadStore) return;

    const errorData = await payloadStore.retrieve(runState.errorRef);
    if (!errorData || typeof errorData !== 'object') return;

    const aflowError = errorData as AflowError;
    if (!aflowError.code) return;

    if (!shouldCreateErrorReport(aflowError.classification, runState.status)) return;

    const context = {
      tenantId,
      runId,
      ...(runState.target ? { flowId: agentTargetKey(runState.target) } : {}),
      ...(runState.traceId ? { traceId: runState.traceId } : {}),
      ...(runState.currentStepId ? { stepId: runState.currentStepId } : {}),
      ...(runState.currentStepExecutionId
        ? { stepExecutionId: runState.currentStepExecutionId }
        : {}),
    };

    const report = createErrorReport(aflowError, context);

    const reportTimestamp = toDateSafe(report.timestamp, new Date(), 'errorReport.timestamp');
    await db
      .insert(errorReports)
      .values({
        id: report.id,
        timestamp: reportTimestamp,
        tenantId: report.tenantId,
        runId: report.runId,
        ...(report.stepExecutionId ? { stepExecutionId: report.stepExecutionId } : {}),
        ...(report.attempt !== undefined ? { attempt: report.attempt } : {}),
        ...(report.flowId ? { flowId: report.flowId } : {}),
        ...(report.flowName ? { flowName: report.flowName } : {}),
        ...(report.stepId ? { stepId: report.stepId } : {}),
        ...(report.stepType ? { stepType: report.stepType } : {}),
        ...(report.operationId ? { operationId: report.operationId } : {}),
        ...(report.traceId ? { traceId: report.traceId } : {}),
        ...(report.spanId ? { spanId: report.spanId } : {}),
        ...(report.providerRequestId ? { providerRequestId: report.providerRequestId } : {}),
        classification: report.classification,
        code: report.code,
        message: report.message,
        ...(report.stack ? { stack: report.stack } : {}),
        ...(report.cause ? { cause: report.cause } : {}),
        ...(report.intent ? { intent: report.intent } : {}),
        ...(report.provider ? { provider: report.provider } : {}),
        severity: report.severity,
        fingerprint: report.fingerprint,
        occurrenceCount: 1,
        ...(report.suggestedAction ? { suggestedAction: report.suggestedAction } : {}),
      })
      .onConflictDoUpdate({
        target: errorReports.fingerprint,
        set: {
          occurrenceCount: sql`${errorReports.occurrenceCount} + 1`,
          timestamp: reportTimestamp,
          runId: report.runId,
          message: report.message,
        },
      });

    await appendErrorReport(redis, report);
  } catch (err) {
    // Nobody learning why a run failed must not stop the failure becoming durable.
    logOrchestratorError(`[errorReport] Error assembling error report for run ${runId}:`, err, {
      tenantId,
      runId,
    });
  }
}
