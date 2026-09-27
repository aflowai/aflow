import type { SessionEvent as RedisRunEvent } from '@aflow/redis';
import type { ProjectionSpec, ApiSessionEvent, SessionId, PauseContract } from '@aflow/schemas';
import { PauseContractSchema } from '@aflow/schemas';
import type { EventLogRow } from '@aflow/database';

// ============================================================================
// Redis → API Projection
// ============================================================================

/**
 * Compile-time assertion: every key of RedisRunEvent is accounted for.
 * If SessionEventSchema gains a field and this record is not updated, TypeScript errors.
 */
const _REDIS_TO_API_SPEC: ProjectionSpec<RedisRunEvent> = {
  eventId: 'map',
  eventType: 'map',
  sessionId: 'map',
  timestamp: 'map', // epoch ms → ISO string
  stepId: 'rename', // top-level → data.stepId
  stepExecutionId: 'map',
  stepType: 'rename', // top-level → data.stepType
  attempt: 'rename', // top-level → data.attempt
  outputRef: 'rename', // top-level → data.payloadRef
  errorRef: 'rename', // top-level → data.errorRef
  requestedInputRef: 'rename', // top-level → data.requestedInputRef
  metadata: 'map',
  usage: 'map',
  usageSummary: 'map',
  runtimeStatePatch: 'rename', // top-level → data.runtimeStatePatch
  surfaceMutations: 'map',
  surfaceId: 'map',
  outputVariables: 'rename', // top-level → data.outputVariables
  workflowTaskUpdate: 'rename', // top-level → data.workflowTaskUpdate
  workflowRunUpdate: 'rename', // top-level → data.workflowRunUpdate
  workflowTaskActivity: 'rename', // top-level → data.workflowTaskActivity
  workflowTaskSurfaceUpdate: 'rename', // top-level → data.workflowTaskSurfaceUpdate
  presentation: 'rename', // top-level → data.presentation
};

// Ensure the spec variable isn't tree-shaken — it exists only for type-checking.
void _REDIS_TO_API_SPEC;

function decodePauseContract(
  eventType: string,
  requestedInputRef: string | undefined,
): PauseContract | undefined {
  if (eventType !== 'SessionPaused' || !requestedInputRef) return undefined;
  if (!requestedInputRef.startsWith('inline:')) return undefined;
  try {
    const encoded = requestedInputRef.slice('inline:'.length);
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    const result = PauseContractSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project a Redis SessionEvent into the canonical API event shape.
 */
export function projectRedisEventToApi(event: RedisRunEvent): ApiSessionEvent {
  const pauseContract = decodePauseContract(event.eventType, event.requestedInputRef);
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    sessionId: event.sessionId as SessionId,
    stepExecutionId: event.stepExecutionId,
    timestamp: new Date(event.timestamp).toISOString(),
    sequenceNumber: 0, // Redis doesn't use DB sequence numbers
    eventVersion: 1,
    data: {
      stepId: event.stepId ?? undefined,
      stepType: event.stepType ?? undefined,
      attempt: event.attempt ?? undefined,
      payloadRef: event.outputRef ?? undefined,
      errorRef: event.errorRef ?? undefined,
      requestedInputRef: event.requestedInputRef ?? undefined,
      runtimeStatePatch: event.runtimeStatePatch,
      outputVariables: event.outputVariables,
      ...(pauseContract ? { pauseContract } : {}),
      ...(event.workflowRunUpdate ? { workflowRunUpdate: event.workflowRunUpdate } : {}),
      ...(event.workflowTaskUpdate ? { workflowTaskUpdate: event.workflowTaskUpdate } : {}),
      ...(event.workflowTaskActivity ? { workflowTaskActivity: event.workflowTaskActivity } : {}),
      ...(event.workflowTaskSurfaceUpdate
        ? { workflowTaskSurfaceUpdate: event.workflowTaskSurfaceUpdate }
        : {}),
      ...(event.presentation ? { presentation: event.presentation } : {}),
    },
    metadata: event.metadata,
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.usageSummary ? { usageSummary: event.usageSummary } : {}),
    surfaceMutations: event.surfaceMutations,
    surfaceId: event.surfaceId,
  };
}

// ============================================================================
// Postgres → API Projection
// ============================================================================

/**
 * Compile-time assertion: every key of EventLogRow is accounted for.
 * If the event_log table gains a column, TypeScript errors here.
 */
const _POSTGRES_TO_API_SPEC: ProjectionSpec<EventLogRow> = {
  envelope: 'map',
  // sequenceNumber comes from the column (the bigserial), not the envelope —
  // Redis events carry sequenceNumber=0 by convention.
  sequenceNumber: 'map',
  // The rest are denormalized; the API event derives them from `envelope`
  // via projectRedisEventToApi.
  eventId: 'drop',
  eventType: 'drop',
  eventVersion: 'drop',
  sessionId: 'drop',
  stepExecutionId: 'drop',
  parentStepExecutionId: 'drop',
  stepId: 'drop',
  stepType: 'drop',
  attempt: 'drop',
  timestamp: 'drop',
  payloadRef: 'drop',
  errorRef: 'drop',
  requestedInputRef: 'drop',
  operationId: 'drop',
  idempotencyKey: 'drop',
};

void _POSTGRES_TO_API_SPEC;

export function projectPostgresEventToApi(event: EventLogRow): ApiSessionEvent {
  const envelope = event.envelope as Partial<RedisRunEvent> | null;
  if (!envelope || typeof envelope !== 'object' || !envelope.eventId) {
    throw new Error(
      `event_log row ${event.eventId} has no envelope (pre-cutover row before migration 76, or corrupt write). ` +
        `Postgres replay requires a full SessionEvent body in event_log.envelope.`,
    );
  }
  const api = projectRedisEventToApi(envelope as RedisRunEvent);
  return { ...api, sequenceNumber: event.sequenceNumber };
}
