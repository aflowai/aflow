/**
 * Build execution context for a step job.
 */
import type { z } from 'zod';
import {
  StreamKeys,
  WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE,
  type StepJobMessage,
  type PayloadRef,
  type TenantId,
  type StepExecutionId,
  type OperationId,
  type StepDefinition,
  type OperationDefinition,
  type LiveDeltaChannel,
} from '@aflow/schemas';
import { appendSessionEvent, appendLiveDelta, type SessionEvent } from '@aflow/redis';
import {
  resolveAndValidate,
  ResolutionContextSchema,
  type ResolutionContext,
} from '@aflow/input-resolution';
import type {
  ExecutorContext,
  ExecutorDependencies,
  ExecutorLogger,
  ResolvedInput,
  SlotController,
} from '../types.js';
import { InputResolutionError } from '../types.js';
import { deriveExecutionRunId, deriveLogicalExecutionId } from './correlation.js';
import { retrievePayloadForTenant } from './payloadAccess.js';

export async function buildExecutionContext(
  deps: ExecutorDependencies,
  job: StepJobMessage,
  log: ExecutorLogger,
  slotController?: SlotController,
): Promise<ExecutorContext> {
  const payloadStore = deps.payloadStore;
  const tenantId = job.tenantId as TenantId;

  const stepDefinition = deps.resolveStepDefinition
    ? await deps.resolveStepDefinition(job.stepId)
    : undefined;

  const operationDefinition = deps.resolveOperationDefinition
    ? await deps.resolveOperationDefinition(job.operationId)
    : undefined;

  let resolutionContext: ResolutionContext | undefined;
  if (job.resolutionContextRef) {
    try {
      const rawContext = await retrievePayloadForTenant({
        payloadStore,
        ref: job.resolutionContextRef,
        tenantId,
      });
      const parsed = ResolutionContextSchema.safeParse(rawContext);
      if (parsed.success) {
        resolutionContext = parsed.data;
      } else {
        log.warn('Failed to parse resolution context', {
          error: parsed.error.message,
        });
      }
    } catch (err) {
      log.warn('Failed to load resolution context', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const executionRunId = deriveExecutionRunId(job);

  // Shared by the progress emitter and the live-delta wake below: a step a
  // workflow dispatched has a run and a task, not a session, so this stream is
  // the one road from the executor to whoever is watching the run.
  const emitWorkflowProgressEvent = async (evt: {
    eventType: string;
    metadata?: Record<string, unknown>;
    surfaceMutations?: Array<Record<string, unknown>>;
    surfaceId?: string;
    sequence?: number;
  }): Promise<void> => {
    if (!job.workflowExecution) return;
    try {
      const { runId, taskId } = job.workflowExecution;
      const streamKey = StreamKeys.workflowTaskProgressStream(job.tenantId, runId, taskId);
      const pipeline = deps.redis.pipeline();
      pipeline.xadd(
        streamKey,
        'MAXLEN',
        '~',
        '1000',
        '*',
        'eventType',
        evt.eventType,
        'tenantId',
        job.tenantId,
        'runId',
        runId,
        'taskId',
        taskId,
        'stepExecutionId',
        job.stepExecutionId,
        'attempt',
        String(job.attempt),
        'sequence',
        String(evt.sequence ?? 0),
        'timestamp',
        String(Date.now()),
        ...(evt.surfaceId ? ['surfaceId', evt.surfaceId] : []),
        ...(evt.surfaceMutations ? ['surfaceMutations', JSON.stringify(evt.surfaceMutations)] : []),
        ...(evt.metadata ? ['metadata', JSON.stringify(evt.metadata)] : []),
      );
      pipeline.expire(streamKey, 3600);
      // Same pipeline, so the producer's round-trip count is unchanged. The
      // consumer reads this index instead of scanning the keyspace for
      // streams, making its cost proportional to running tasks.
      pipeline.sadd(StreamKeys.workflowTaskProgressIndexKey, streamKey);
      await pipeline.exec();
    } catch (err) {
      log.warn('Failed to emit workflow-task progress event', {
        eventType: evt.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const baseContext = {
    job,
    tenantId,
    ...(job.spaceId !== undefined ? { spaceId: job.spaceId } : {}),
    runId: executionRunId,
    stepExecutionId: job.stepExecutionId as StepExecutionId,
    logicalExecutionId: deriveLogicalExecutionId(job),
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
    traceId: job.traceId,
    operationId: job.operationId as OperationId,
    ...(job.callerModel !== undefined ? { callerModel: job.callerModel } : {}),

    readPayload: async <T = unknown>(ref: PayloadRef): Promise<T> => {
      const data = await retrievePayloadForTenant({ payloadStore, ref, tenantId });
      return data as T;
    },

    writePayload: async (
      kind: 'output' | 'error' | 'input_request' | 'body' | 'raw_body' | 'activity' | 'patch',
      data: unknown,
    ): Promise<PayloadRef> => {
      const payloadKind = kind === 'input_request' ? ('requested_input' as const) : kind;
      return payloadStore.store({
        tenantId,
        runId: executionRunId,
        stepExecutionId: job.stepExecutionId as StepExecutionId,
        attempt: job.attempt,
        kind: payloadKind,
        data,
      });
    },

    outputExists: async (): Promise<PayloadRef | null> => {
      const outputRef = payloadStore.buildRef({
        tenantId,
        runId: executionRunId,
        stepExecutionId: job.stepExecutionId as StepExecutionId,
        attempt: job.attempt,
        kind: 'output',
      });
      const exists = await payloadStore.exists(outputRef);
      return exists ? outputRef : null;
    },

    resolveAndValidateInput: async <T>(
      inputTemplate: unknown,
      schema: z.ZodSchema<T>,
    ): Promise<ResolvedInput<T>> => {
      if (!resolutionContext) {
        throw new InputResolutionError(
          'Resolution context not available - resolutionContextRef was not provided in job',
          'resolution',
          'INPUT_REF_NOT_FOUND',
        );
      }

      const result = resolveAndValidate(inputTemplate, resolutionContext, schema);

      if (!result.success) {
        if (result.phase === 'resolution') {
          throw new InputResolutionError(
            result.error.message,
            'resolution',
            result.error.code,
            result.error,
          );
        } else {
          throw new InputResolutionError(
            result.error.message,
            'validation',
            result.error.code,
            result.error,
          );
        }
      }

      const resolvedInputRef = await payloadStore.store({
        tenantId,
        runId: executionRunId,
        stepExecutionId: job.stepExecutionId as StepExecutionId,
        attempt: job.attempt,
        kind: 'resolved_input',
        data: result.resolved,
      });

      return {
        data: result.data,
        resolvedInputRef,
      };
    },

    emitRunEvent: async (evt: {
      eventType: string;
      metadata?: Record<string, unknown>;
      surfaceMutations?: Array<Record<string, unknown>>;
      surfaceId?: string;
    }) => {
      if (!job.sessionId) return;
      try {
        const runEvent: SessionEvent = {
          eventId: crypto.randomUUID(),
          eventType: evt.eventType as SessionEvent['eventType'],
          timestamp: Date.now(),
          sessionId: job.sessionId,
          stepId: job.stepId,
          stepExecutionId: job.stepExecutionId,
          stepType: job.stepType,
          attempt: job.attempt,
          metadata: evt.metadata,
          surfaceMutations: evt.surfaceMutations,
          surfaceId: evt.surfaceId,
        };
        await appendSessionEvent(deps.redis, job.tenantId, job.sessionId, runEvent);
      } catch (err) {
        log.warn('Failed to emit run event', {
          eventType: evt.eventType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    emitLiveDelta: async (channel: LiveDeltaChannel, delta: string) => {
      if (!job.stepExecutionId || delta.length === 0) return;
      try {
        await appendLiveDelta(
          deps.redis,
          job.tenantId,
          job.sessionId ?? null,
          job.stepExecutionId,
          channel,
          delta,
        );
      } catch (err) {
        log.warn('Failed to append live delta', {
          channel,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Nothing to publish to when the job named no session, and the buffer
      // would sit there unread. Its readers are the run's, so the wake goes
      // down the road the task's progress already takes.
      if (job.sessionId === undefined) {
        await emitWorkflowProgressEvent({
          eventType: WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE,
          metadata: { channel },
        });
      }
    },

    emitWorkflowProgress: emitWorkflowProgressEvent,

    signal: new AbortController().signal,
    log,
    ...(slotController ? { slotController } : {}),
  };

  const ctx: ExecutorContext = baseContext;
  if (stepDefinition !== undefined) {
    (ctx as { stepDefinition: StepDefinition }).stepDefinition = stepDefinition;
  }
  if (operationDefinition !== undefined) {
    (ctx as { operationDefinition: OperationDefinition }).operationDefinition = operationDefinition;
  }
  if (resolutionContext !== undefined) {
    (ctx as { resolutionContext: ResolutionContext }).resolutionContext = resolutionContext;
  }

  return ctx;
}
