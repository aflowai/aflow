/**
 * Session Service — API layer for agent session operations.
 *
 * When database is connected:
 * - Uses SessionRepository for data access
 * - Queries database for session details and events
 *
 * When in mock mode:
 * - Returns simulated responses for development/testing
 */
import {
  deriveResolverPolicy,
  isResolverAllowed,
  AgentDefinitionSchema,
  MAX_INLINE_DEFINITION_BYTES,
  projectTargetColumns,
  StreamKeys,
} from '@aflow/schemas';
import type {
  TenantId,
  SessionId,
  AgentId,
  StepExecutionId,
  ActorContext,
  TraceId,
  IdempotencyKey,
  AgentDefinition,
  SessionAgentTarget,
  ReconcileReason,
  SessionBlockedOn,
  SimulationRunInput,
  SessionMetadata,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import {
  postRoomMessageDirect,
  rehydratePausedRun,
  type PostRoomMessageResponse,
} from './sessionRoomPost.js';

export {
  postRoomMessageDirect,
  rehydratePausedRun,
  type DirectRoomMessageInput,
  type PostRoomMessageResponse,
} from './sessionRoomPost.js';
import type { AppContext } from './context.js';
import { deriveSessionBlockedOn } from './deriveSessionBlockedOn.js';
import { projectSessionMetadata } from './sessionMetadataProjection.js';
import { loadPausePayload } from './pauseResolverPolicy.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  createSessionRepository,
  readSessionMetadata,
  withTenantSchema,
  idempotencyKeys,
  type SessionStatus as DbSessionStatus,
  type StoredSessionMetadata,
} from '@aflow/database';
import {
  addControlMessage,
  claimControlDispatchIdempotency,
  getSessionStateSafe,
  getStepState,
  isSessionCorrupt,
  appendSessionEvent,
  setSessionState,
  markSessionDirty,
  getSystemLoad,
  updateSessionState,
  type SessionHotState,
} from '@aflow/redis';
import { recordAdmissionReject } from '@aflow/observability';
import { dispatchResume, loadPendingWaitersForSession } from '@aflow/cybernetic-runtime';
import { createSessionTailService } from './sessionTail.js';

// ============================================================================
// Types
// ============================================================================

export type SessionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING_ON_CHILD'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'STALLED';

export type RunTrigger = 'chat' | 'api' | 'eval' | 'mcp' | 'schedule' | 'voice' | 'webhook';

export interface StartSessionRequest {
  tenantId: TenantId;
  target: SessionAgentTarget;
  /**
   * Optional convenience field. If present **and** `target.kind === 'inline-agent'`,
   * `startSession` encodes the definition as `inline:<base64>` and overwrites
   * `target.definitionRef`. Either supply `target.definitionRef` directly or
   * use this field; passing both is a 400.
   */
  inlineDefinition?: AgentDefinition | undefined;
  /** Agent version. Only meaningful for `custom-agent` target. Defaults to latest. */
  agentVersion?: string | undefined;
  /** Standard format: { input: <value>, config?: {...} }, bare value, or null. */
  input?: unknown;
  inputRef?: string | undefined;
  idempotencyKey?: string | undefined;
  traceId?: string | undefined;
  createdBy?: string | undefined;
  spaceId?: string | undefined;
  trigger?: RunTrigger | undefined;
  /** Whether the user is interacting via voice (set when mode='voice') */
  voiceMode?: boolean | undefined;
  actorContext?: ActorContext | undefined;
  clientMessageId?: string | undefined;
  /**
   * What this run pins its simulated worlds to — persona, baseline, seed, rule
   * profile, caller disclosure and generation model, each keyed by simulation.
   *
   * Set by the CALLER, never by the agent: a subject that could choose its own
   * seed or model would be choosing the environment it is measured in. Absent
   * means every simulation takes its declared defaults, which is what an
   * ordinary chat wants.
   */
  simulationRunInput?: SimulationRunInput | undefined;
}

/** Shape returned to clients for paused runs needing input. */
export interface RequiredInputInfo {
  stepExecutionId: StepExecutionId;
  prompt?: string | undefined;
  missingVariables?: Array<{
    variableId: string;
    name?: string;
    description?: string;
    typeSchema?: Record<string, unknown>;
    semanticType?: string;
    required?: boolean;
    responseOptions?: {
      type: 'single' | 'multi';
      options: Array<{ value: string; label?: string }>;
    };
  }>;
}

export interface StartSessionResponse {
  sessionId: SessionId;
  status: SessionStatus;
  eventsUrl: string;
  traceId: string;
  requiredInput?: RequiredInputInfo | undefined;
}

export interface ResumeSessionRequest {
  tenantId: TenantId;
  sessionId: SessionId;
  stepExecutionId: StepExecutionId;
  input?: unknown;
  inputRef?: string | undefined;
  idempotencyKey?: string | undefined;
  traceId?: string | undefined;
  actorContext?: ActorContext | undefined;
  /** Whether the user is interacting via voice (mutable per-turn) */
  voiceMode?: boolean | undefined;
  clientMessageId?: string | undefined;
}

export interface ResumeSessionResponse {
  status: SessionStatus;
  traceId: string;
  requiredInput?: RequiredInputInfo | undefined;
}

export interface RetrySessionRequest {
  tenantId: TenantId;
  sessionId: SessionId;
  input?: unknown;
  inputRef?: string | undefined;
  stepExecutionId?: StepExecutionId | undefined;
  idempotencyKey?: string | undefined;
  traceId?: string | undefined;
  actorContext?: ActorContext | undefined;
}

export interface RetrySessionResponse {
  status: SessionStatus;
  retryCount: number;
  traceId: string;
}

export interface CancelSessionRequest {
  tenantId: TenantId;
  sessionId: SessionId;
}

export interface CancelSessionResponse {
  status: SessionStatus;
  message: string;
}

export interface SessionDetails {
  sessionId: SessionId;
  target: SessionAgentTarget;
  /** Agent version (meaningful only for custom-agent target). */
  agentVersion: string;
  status: SessionStatus;
  createdAt: string;
  /** When the execution state last moved — tool results and all. */
  updatedAt: string;
  /**
   * When someone last spoke here, or the agent last answered them. What a
   * conversation list sorts on; falls back to when the session opened for
   * anything nobody has spoken in.
   */
  lastActivityAt?: string | undefined;
  /** Who opened this session. Provenance — authorization never reads it. */
  createdBy?: string | undefined;
  /** Name and synopsis. Absent on a session the metadata plane never saw. */
  metadata?: SessionMetadata | undefined;
  completedAt?: string | undefined;
  inputRef?: string | undefined;
  outputRef?: string | undefined;
  /** User-facing error summary (always included if run failed) */
  error?: UserFacingErrorSummary | undefined;
  /** Full error reference (role-gated, only for debugging) */
  errorRef?: string | undefined;
  stepCount: number;
  currentStepId?: string | undefined;
  requiredInput?: RequiredInputInfo | undefined;
  blockedOn?: SessionBlockedOn | null | undefined;
}

export interface UserFacingErrorSummary {
  /** Short title (e.g., "Connection Failed") */
  title: string;
  /** Friendly message explaining what happened */
  message: string;
  /** Error category for UI styling/routing */
  category:
    | 'network'
    | 'config'
    | 'permission'
    | 'rate_limit'
    | 'timeout'
    | 'budget'
    | 'validation'
    | 'system';
  /** Suggested next steps for the user */
  suggestedActions?: string[] | undefined;
  /** Whether the user can retry this operation */
  canRetry: boolean;
  /** Support reference (sessionId + traceId for support tickets) */
  supportRef?: string | undefined;
}

export interface ListSessionsQuery {
  tenantId: TenantId;
  targetKind?: 'platform-role' | 'custom-agent' | undefined;
  targetAgentId?: AgentId | undefined;
  targetSystemRole?: string | undefined;
  status?: SessionStatus | undefined;
  spaceId?: string | undefined;
  createdBy?: string | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  limit: number;
  cursor?: string | undefined;
  excludeTrigger?: string | undefined;
}

export interface ListSessionsResponse {
  sessions: SessionDetails[];
  nextCursor?: string | undefined;
  totalCount?: number | undefined;
}

export type GetSessionEventsResult =
  | {
      kind: 'events';
      events: SessionEvent[];
      nextCursor?: string;
      hasMore: boolean;
    }
  | {
      kind: 'reconcile_required';
      reason: ReconcileReason;
      /** Last known good cursor before the gap, when known. */
      cursor?: string;
    };

export interface SessionEvent {
  eventId: string;
  eventType: string;
  sessionId: SessionId;
  stepExecutionId?: string | undefined;
  timestamp: string;
  /** Sequence number for durable cursor-based pagination */
  sequenceNumber: number;
  /** Event schema version for compatibility checks */
  eventVersion: number;
  data: {
    stepId?: string | undefined;
    stepType?: string | undefined;
    attempt?: number | undefined;
    payloadRef?: string | undefined;
    /** Error reference for StepFailed/FlowRunFailed events */
    errorRef?: string | undefined;
    /** Input ref for StepPaused (user input required) events */
    requestedInputRef?: string | undefined;
    [key: string]: unknown;
  };
  /** Event metadata from the orchestrator (e.g., stepName, operationId, displayOutput) */
  metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// Session Service Interface
// ============================================================================

/** Inline agent config from the API */
export interface InlineAgentConfig {
  name?: string | undefined;
  startStepId?: string | undefined;
  steps: Array<{
    stepId: string;
    type: string;
    operation: string;
    config?: Record<string, unknown> | undefined;
    outputMapping?: Record<string, string> | undefined;
    name?: string | undefined;
    description?: string | undefined;
    onSuccess?: { next: Array<{ stepId: string; priority: number }> } | undefined;
    onFailure?: { next: Array<{ stepId: string; priority: number }> } | undefined;
  }>;
}

export function buildInlineAgentDefinition(config: InlineAgentConfig): AgentDefinition {
  const flowId = `inline-${crypto.randomUUID()}`;
  const version = '1';
  const name = config.name ?? 'inline-flow';

  const flowDefinition = {
    flowId,
    version,
    metadata: {
      name,
      description: `Inline flow created via API (${new Date().toISOString()})`,
      system: false,
    },
    steps: config.steps.map((step) => ({
      stepId: step.stepId,
      stepType: step.type,
      operation: step.operation,
      config: step.config ?? {},
      outputMapping: step.outputMapping,
      name: step.name,
      description: step.description,
      onSuccess: step.onSuccess ?? { next: [] as Array<{ stepId: string; priority: number }> },
      onFailure: step.onFailure ?? { next: [] as Array<{ stepId: string; priority: number }> },
    })),
    startStepId: (() => {
      const first = config.steps[0];
      if (!first) throw new Error('Flow config must have at least one step');
      return config.startStepId ?? first.stepId;
    })(),
  };

  for (let i = 0; i < flowDefinition.steps.length - 1; i++) {
    const currentStep = flowDefinition.steps[i];
    const nextStep = flowDefinition.steps[i + 1];
    if (!currentStep || !nextStep) continue;
    if (currentStep.onSuccess.next.length === 0) {
      currentStep.onSuccess = {
        next: [{ stepId: nextStep.stepId, priority: 50 }],
      };
    }
  }

  return AgentDefinitionSchema.parse(flowDefinition);
}

export interface AgentDebugInfo {
  stepId: string;
  conversationStateRef?: string | undefined;
  lastDecision?:
    | {
        action: string;
        stepId?: string | undefined;
        message?: string | undefined;
        callCount?: number | undefined;
        callStepIds?: string[] | undefined;
      }
    | undefined;
}

/** Current step execution state for debugging */
export interface CurrentStepDebugInfo {
  stepExecutionId: string;
  stepId: string;
  stepType: string;
  operationId: string;
  status: string;
  scheduledAt: number;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  inputRef: string;
  outputRef?: string | undefined;
  errorRef?: string | undefined;
  parentStepExecutionId?: string | undefined;
}

/** Dynamic step summary for debugging */
export interface DynamicStepDebugInfo {
  stepId: string;
  stepType: string;
  operation: string;
  status?: string | undefined;
  stepExecutionId?: string | undefined;
  error?: { message: string } | undefined;
  durationMs?: number | undefined;
}

export interface DelegationTreeEntry {
  childSessionId: string;
  target?: SessionAgentTarget | undefined;
  status?: string | undefined;
  depth: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

export interface SessionDebugView {
  session: SessionDetails;
  recentEvents: SessionEvent[];
  runtimeState?: Record<string, unknown> | undefined;
  agent?: Record<string, AgentDebugInfo> | undefined;
  currentStep?: CurrentStepDebugInfo | undefined;
  dynamicSteps?: DynamicStepDebugInfo[] | undefined;
  delegationTree?: DelegationTreeEntry[] | undefined;
  /**
   * Parent session ID when this session is a child subflow.
   * Sourced from the hot state's parentSessionId linkage. Unavailable once the
   * hot state has been reaped — treat as best-effort for debugging.
   */
  parentSessionId?: string | undefined;
  refs: {
    inputRef?: string | undefined;
    outputRef?: string | undefined;
    errorRef?: string | undefined;
    requestedInputRef?: string | undefined;
  };
  warnings?: string[] | undefined;
}

export interface SessionStateView {
  sessionHotState: {
    sessionId: string;
    tenantId: string;
    target: SessionAgentTarget | null;
    agentVersion: string;
    status: string;
    currentStepId?: string | undefined;
    createdAt: number;
    startedAt?: number | undefined;
    endedAt?: number | undefined;
    inputRef?: string | undefined;
    finalOutputRef?: string | undefined;
    errorRef?: string | undefined;
    pauseReason?: string | undefined;
    requestedInputRef?: string | undefined;
    traceId?: string | undefined;
    lastUpdatedAt: number;
  };
  runtimeState?:
    | {
        variables: Record<string, { ref?: string | undefined; summary?: string | undefined }>;
        version?: number | undefined;
        updatedAtMs?: number | undefined;
      }
    | undefined;
  dynamicStepsCount?: number | undefined;
  variableDefsOverlay?: Record<string, unknown> | undefined;
  isCorrupt?: boolean | undefined;
  corruptMarkerRef?: string | undefined;
}

export interface SessionService {
  startSession(request: StartSessionRequest, baseUrl: string): Promise<StartSessionResponse>;
  resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  retrySession(request: RetrySessionRequest): Promise<RetrySessionResponse>;
  cancelSession(request: CancelSessionRequest): Promise<CancelSessionResponse>;
  interruptSession(request: {
    tenantId: TenantId;
    sessionId: SessionId;
  }): Promise<{ status: SessionStatus; message: string }>;
  getSessionById(tenantId: TenantId, sessionId: SessionId): Promise<SessionDetails | null>;
  listSessions(query: ListSessionsQuery): Promise<ListSessionsResponse>;
  getSessionEvents(
    tenantId: TenantId,
    sessionId: SessionId,
    afterEventId?: string,
    limit?: number,
  ): Promise<GetSessionEventsResult>;
  /**
   * The page ending at `beforeCursor`, or the newest page when it is absent.
   *
   * The other direction. A reader with no position wants the END of a history,
   * not its beginning — a page from the start plus a live tail leaves the
   * middle of a long session unreachable.
   */
  getSessionEventsBefore(
    tenantId: TenantId,
    sessionId: SessionId,
    beforeCursor?: string,
    limit?: number,
  ): Promise<GetSessionEventsBeforeResult>;
  isSessionCorrupt(tenantId: TenantId, sessionId: SessionId): Promise<boolean>;
  getSessionDebug(
    tenantId: TenantId,
    sessionId: SessionId,
    options?: { eventsLimit?: number },
  ): Promise<SessionDebugView | null>;
  getSessionStateView(tenantId: TenantId, sessionId: SessionId): Promise<SessionStateView | null>;
  postRoomMessage(request: PostRoomMessageRequest): Promise<PostRoomMessageResponse>;
}

export type GetSessionEventsBeforeResult =
  | {
      kind: 'events';
      events: SessionEvent[];
      /** Where live tailing resumes — the newest event in the page. */
      nextCursor?: string;
      /** Where to ask for the next page back, absent when none exists. */
      olderCursor?: string;
      hasOlder: boolean;
    }
  | { kind: 'reconcile_required'; reason: ReconcileReason; cursor?: string };

export interface PostRoomMessageRequest {
  tenantId: TenantId;
  sessionId: SessionId;
  body: string;
  actorContext: ActorContext;
  clientMessageId?: string;
  /**
   * Whether this message also asks the agent to act. Posting alone never
   * advances a run; a wake is the message plus the ask, recorded together so
   * the log says which message it was that set the agent going.
   */
  wakeHelmsman?: boolean;
}

// ============================================================================
// Mock Run Service (for development without database)
// ============================================================================

/* eslint-disable @typescript-eslint/require-await -- Mock SessionService; methods satisfy interface with sync results */
function createMockSessionService(): SessionService {
  // In-memory store for mock runs
  const mockSessions = new Map<string, SessionDetails>();
  const mockEvents = new Map<string, SessionEvent[]>();

  return {
    async startSession(request, baseUrl) {
      const sessionId = crypto.randomUUID() as SessionId;
      const traceId = request.traceId ?? crypto.randomUUID();
      const now = new Date().toISOString();

      const session: SessionDetails = {
        sessionId,
        target: request.target,
        agentVersion: request.agentVersion ?? '1',
        status: 'RUNNING',
        createdAt: now,
        updatedAt: now,
        stepCount: 0,
      };

      mockSessions.set(sessionId, session);

      // Create initial event
      const event: SessionEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'FlowRunStarted',
        sessionId,
        timestamp: now,
        sequenceNumber: 1,
        eventVersion: 1,
        data: { target: request.target, status: 'RUNNING' },
      };
      mockEvents.set(sessionId, [event]);

      return {
        sessionId,
        status: 'RUNNING',
        eventsUrl: `${baseUrl}/v1/sessions/${sessionId}/events`,
        traceId,
      };
    },

    async resumeSession(request) {
      const run = mockSessions.get(request.sessionId);
      if (!run) {
        throw new Error(`Run ${request.sessionId} not found`);
      }
      if (run.status !== 'PAUSED') {
        throw new Error(`Run ${request.sessionId} is not paused`);
      }

      run.status = 'RUNNING';
      run.updatedAt = new Date().toISOString();
      run.requiredInput = undefined;

      return {
        status: 'RUNNING',
        traceId: request.traceId ?? crypto.randomUUID(),
      };
    },

    async retrySession(request: RetrySessionRequest): Promise<RetrySessionResponse> {
      const run = mockSessions.get(request.sessionId);
      if (!run) {
        throw new Error(`Run ${request.sessionId} not found`);
      }
      if (run.status !== 'FAILED') {
        throw new Error(`Run ${request.sessionId} is not failed (current status: ${run.status})`);
      }

      run.status = 'RUNNING';
      run.updatedAt = new Date().toISOString();

      return {
        status: 'RUNNING',
        retryCount: 1,
        traceId: request.traceId ?? crypto.randomUUID(),
      };
    },

    async cancelSession(request) {
      const run = mockSessions.get(request.sessionId);
      if (!run) {
        throw new Error(`Run ${request.sessionId} not found`);
      }

      run.status = 'CANCELLED';
      run.updatedAt = new Date().toISOString();
      run.completedAt = run.updatedAt;

      return {
        status: 'CANCELLED',
        message: 'Run cancelled',
      };
    },

    async interruptSession(request) {
      const run = mockSessions.get(request.sessionId);
      if (!run) {
        throw new Error(`Run ${request.sessionId} not found`);
      }
      return {
        status: 'RUNNING',
        message: 'Interrupt requested',
      };
    },

    async getSessionById(_tenantId, sessionId) {
      return mockSessions.get(sessionId) ?? null;
    },

    async listSessions(query) {
      const sessions = Array.from(mockSessions.values())
        .filter((r) => !query.targetKind || r.target.kind === query.targetKind)
        .filter(
          (r) =>
            !query.targetAgentId ||
            (r.target.kind === 'custom-agent' && r.target.agentId === query.targetAgentId),
        )
        .filter(
          (r) =>
            !query.targetSystemRole ||
            (r.target.kind === 'platform-role' && r.target.systemRole === query.targetSystemRole),
        )
        .filter((r) => !query.status || r.status === query.status)
        .slice(0, query.limit);

      return { sessions };
    },

    async getSessionEventsBefore(_tenantId, sessionId, beforeCursor, limit = 100) {
      const events = mockEvents.get(sessionId) ?? [];
      const endIndex =
        beforeCursor === undefined
          ? events.length
          : Math.max(
              0,
              events.findIndex((e) => e.eventId === beforeCursor),
            );
      const startIndex = Math.max(0, endIndex - limit);
      return {
        kind: 'events' as const,
        events: events.slice(startIndex, endIndex),
        hasOlder: startIndex > 0,
        ...(startIndex > 0 && events[startIndex]
          ? { olderCursor: events[startIndex].eventId }
          : {}),
      };
    },

    async getSessionEvents(_tenantId, sessionId, afterEventId, limit = 100) {
      const events = mockEvents.get(sessionId) ?? [];
      let startIndex = 0;

      if (afterEventId) {
        const idx = events.findIndex((e) => e.eventId === afterEventId);
        if (idx >= 0) {
          startIndex = idx + 1;
        }
      }

      const slice = events.slice(startIndex, startIndex + limit + 1);
      const hasMore = slice.length > limit;
      const returned = hasMore ? slice.slice(0, -1) : slice;
      const last = returned[returned.length - 1];
      return {
        kind: 'events',
        events: returned,
        ...(last ? { nextCursor: last.eventId } : {}),
        hasMore,
      };
    },

    async isSessionCorrupt(_tenantId, _sessionId) {
      return false;
    },

    async getSessionDebug(_tenantId, sessionId, options) {
      const session = mockSessions.get(sessionId);
      if (!session) return null;
      const events = mockEvents.get(sessionId) ?? [];
      const limit = options?.eventsLimit ?? 200;
      return {
        session,
        recentEvents: events.slice(-limit),
        refs: {
          inputRef: session.inputRef,
          outputRef: session.outputRef,
          errorRef: session.errorRef,
        },
      };
    },

    async getSessionStateView() {
      return null; // Mock has no Redis hot state
    },

    async postRoomMessage() {
      return { messageSeq: 1, eventId: crypto.randomUUID(), postedAt: new Date().toISOString() };
    },
  };
}
/* eslint-enable @typescript-eslint/require-await */

// ============================================================================
// Helpers
// ============================================================================

async function hydrateRequestedInput(
  store: PayloadStore,
  ref: string,
): Promise<{
  prompt?: string;
  missingVariables?: RequiredInputInfo['missingVariables'];
  placement?: string;
} | null> {
  try {
    const data = (await store.retrieve(ref as never)) as Record<string, unknown>;
    const result: {
      prompt?: string;
      missingVariables?: RequiredInputInfo['missingVariables'];
      placement?: string;
    } = {};
    if (typeof data['prompt'] === 'string') {
      result.prompt = data['prompt'];
    }
    const mv = data['missingVariables'];
    if (Array.isArray(mv) && mv.length > 0) {
      result.missingVariables = mv as RequiredInputInfo['missingVariables'];
    }
    if (typeof data['placement'] === 'string') {
      result.placement = data['placement'];
    }
    return result;
  } catch {
    return null;
  }
}

// ============================================================================

// ============================================================================
// On-demand rehydration for PAUSED runs
// ============================================================================

// ============================================================================
// Real Run Service (with database)
// ============================================================================

function createRealSessionService(ctx: AppContext): SessionService {
  const db = ctx.db;
  const { redis, payloadStore } = ctx;

  if (!db) {
    throw new Error('Database connection required for real run service');
  }

  const dbTyped = db as PostgresJsDatabase;

  return {
    async startSession(request, baseUrl) {
      if (!redis) {
        throw new Error('Redis required for run execution. Set REDIS_URL.');
      }

      const maxConcurrentRuns = parseInt(process.env['MAX_CONCURRENT_RUNS'] ?? '0', 10);
      if (maxConcurrentRuns > 0) {
        const load = await getSystemLoad(redis);
        if (load.totalActiveRuns >= maxConcurrentRuns) {
          recordAdmissionReject({ tenant_id: request.tenantId });
          const error = new Error(
            `System at capacity (${String(load.totalActiveRuns)}/${String(maxConcurrentRuns)} concurrent runs). Try again later.`,
          ) as Error & { statusCode: number; code: string };
          error.statusCode = 429;
          error.code = 'SYSTEM_AT_CAPACITY';
          throw error;
        }
      }

      // Resolve inline-agent target. The API encodes the AgentDefinition as
      // an `inline:<base64>` PayloadRef when it's small enough to fit in a
      // Redis stream entry; for larger definitions the caller must pre-persist
      // via PayloadStore and pass a `gs://` ref directly. Callers may either
      // pass `target.definitionRef` already-populated or use the
      // `inlineDefinition` convenience field; passing both is a 400.
      let resolvedTarget: SessionAgentTarget = request.target;
      if (request.target.kind === 'inline-agent' && request.inlineDefinition) {
        if (request.target.definitionRef && request.target.definitionRef.length > 0) {
          const err = new Error(
            'Pass exactly one of target.definitionRef or inlineDefinition',
          ) as Error & { statusCode: number; code: string };
          err.statusCode = 400;
          err.code = 'INLINE_DEFINITION_AMBIGUOUS';
          throw err;
        }
        const defJson = JSON.stringify(request.inlineDefinition);
        if (Buffer.byteLength(defJson, 'utf8') > MAX_INLINE_DEFINITION_BYTES) {
          // Bail early — embedding this into Redis streams would blow past
          // the per-entry metadata cap and bloat hot state. The route layer
          // can intercept this and route through PayloadStore.store() with a
          // session-scoped path, then re-call us with the resulting `gs://`
          // ref already in `target.definitionRef`.
          const err = new Error(
            `inlineDefinition exceeds inline encoding limit (${MAX_INLINE_DEFINITION_BYTES} bytes). ` +
              `Persist via PayloadStore and pass the resulting ref in target.definitionRef.`,
          ) as Error & { statusCode: number; code: string };
          err.statusCode = 413;
          err.code = 'INLINE_DEFINITION_TOO_LARGE';
          throw err;
        }
        const defBase64 = Buffer.from(defJson).toString('base64');
        resolvedTarget = { kind: 'inline-agent', definitionRef: `inline:${defBase64}` };
      } else if (
        request.target.kind === 'inline-agent' &&
        (!request.target.definitionRef || request.target.definitionRef.length === 0)
      ) {
        const err = new Error(
          'inline-agent target requires either target.definitionRef or inlineDefinition',
        ) as Error & { statusCode: number; code: string };
        err.statusCode = 400;
        err.code = 'INLINE_DEFINITION_REQUIRED';
        throw err;
      }

      let version = request.agentVersion ?? '';
      if (!version) {
        if (resolvedTarget.kind === 'platform-role' || resolvedTarget.kind === 'inline-agent') {
          version = '1';
        } else {
          const { loadAgentTargetDefinition } = await import('@aflow/database');
          const resolved = await loadAgentTargetDefinition(
            dbTyped,
            request.tenantId,
            resolvedTarget,
            'latest',
          );
          version = resolved.version;
        }
      }

      // Encode input as-is — the orchestrator's startRun applies the canonical
      let inputRef: string;
      if (request.inputRef) {
        inputRef = request.inputRef;
      } else if (request.input !== undefined && request.input !== null) {
        const inputBase64 = Buffer.from(JSON.stringify(request.input)).toString('base64');
        inputRef = `inline:${inputBase64}`;
      } else {
        const emptyBase64 = Buffer.from('{}').toString('base64');
        inputRef = `inline:${emptyBase64}`;
      }

      const traceId = request.traceId ?? crypto.randomUUID();
      const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();

      // ================================================================
      // REDIS-FIRST: All run lifecycle state goes to Redis.
      // DB is populated asynchronously by the projection worker.
      // This keeps the hot path DB-free.
      // ================================================================

      let runId: SessionId = crypto.randomUUID() as SessionId;
      const now = Date.now();

      const claim = await claimControlDispatchIdempotency(redis, idempotencyKey, runId);

      if (!claim.claimed) {
        if (claim.existingRunId) {
          runId = claim.existingRunId as SessionId;
        }
      } else {
        // First-seen: create QUEUED state in Redis + emit FlowRunQueued event

        // 1) Write QUEUED hot state so getRunById can find it immediately.
        //    `resolvedTarget` carries a valid PayloadRef for inline (we
        //    encoded `inlineDefinition` as `inline:<base64>` above) so the
        //    queued state is well-formed end-to-end with no placeholders.
        const queuedState: SessionHotState = {
          sessionId: runId,
          tenantId: request.tenantId,
          target: resolvedTarget,
          agentVersion: version,
          status: 'QUEUED',
          createdAt: now,
          startedAt: now,
          inputRef: inputRef,
          createdBy: request.createdBy,
          traceId,
          idempotencyKey,
          ...(request.spaceId ? { spaceId: request.spaceId } : {}),
          lastUpdatedAt: now,
        };
        await setSessionState(redis, queuedState);

        // 2) Emit FlowRunQueued event to the Redis event stream
        //    (SSE reads from this stream for active runs)
        await appendSessionEvent(redis, request.tenantId, runId, {
          eventId: crypto.randomUUID(),
          eventType: 'SessionQueued',
          timestamp: now,
          sessionId: runId,
          metadata: {
            target: resolvedTarget,
            agentVersion: version,
          },
        });

        // 3) Mark run as a projection candidate so it eventually reaches the DB
        await markSessionDirty(redis, request.tenantId, runId);

        // 4) Enqueue control message for orchestrator.
        //    The tagged `resolvedTarget` carries a valid PayloadRef end-to-end
        //    (no placeholder shapes). Inline definitions live as
        //    `inline:<base64>` inside `target.definitionRef`.
        await addControlMessage(redis, {
          messageVersion: 1,
          type: 'start_run',
          tenantId: request.tenantId,
          runId,
          target: resolvedTarget,
          agentVersion: version,
          inputRef: inputRef,
          traceId: traceId as TraceId,
          idempotencyKey: idempotencyKey as IdempotencyKey,
          createdBy: request.createdBy,
          requestedAtMs: now,
          ...(request.spaceId ? { spaceId: request.spaceId } : {}),
          ...(request.trigger ? { trigger: request.trigger } : {}),
          ...(request.voiceMode ? { voiceMode: true } : {}),
          ...(request.actorContext ? { actorContext: request.actorContext } : {}),
          ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
          ...(request.simulationRunInput ? { simulationRunInput: request.simulationRunInput } : {}),
        });
      }

      return {
        sessionId: runId,
        status: 'QUEUED',
        eventsUrl: `${baseUrl}/v1/sessions/${runId}/events`,
        traceId,
      };
    },

    async resumeSession(request) {
      if (!redis) {
        throw new Error('Redis required for run execution. Set REDIS_URL.');
      }

      // Store inline input if provided
      let inputRef: string;
      if (request.inputRef) {
        inputRef = request.inputRef;
      } else if (request.input) {
        // Encode input as inline base64 payload
        const inputBase64 = Buffer.from(JSON.stringify(request.input)).toString('base64');
        inputRef = `inline:${inputBase64}`;
      } else {
        // Empty input - encode as empty object
        const emptyBase64 = Buffer.from('{}').toString('base64');
        inputRef = `inline:${emptyBase64}`;
      }

      const traceId = request.traceId ?? crypto.randomUUID();
      const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();

      // Validate resume input against the pause schema (best-effort, but blocks on mismatch)
      // This enforces structured `typeSchema` from StepService waitForInput missingVariables.
      let stateResult = await getSessionStateSafe(redis, request.tenantId, request.sessionId);

      // On-demand rehydration: if Redis state is missing (TTL expired), reconstruct
      // from the Postgres hot_state_snapshot that was saved when the run was flushed.
      if (!stateResult.ok) {
        const rehydrated = await rehydratePausedRun(
          redis,
          dbTyped,
          request.tenantId,
          request.sessionId,
        );
        if (rehydrated) {
          stateResult = { ok: true, state: rehydrated };
        }
      }

      if (!stateResult.ok) {
        throw new Error(`Run ${request.sessionId} not found`);
      }

      const state = stateResult.state;
      if (state.status !== 'PAUSED') {
        throw new Error(`Run ${request.sessionId} is not paused`);
      }

      // Guard: reject resume for sessions that are paused because they are
      // waiting on a child sub-agent (delegationPauseSource='child_running').
      // These pauses auto-resolve when the child completes — user input would
      // interrupt the delegation and orphan the child's result.
      if (state.delegationPauseSource === 'child_running') {
        const err = new Error(
          `Run ${request.sessionId} is waiting on a sub-agent and cannot be resumed directly. ` +
            `It will resume automatically when the sub-agent completes or pauses.`,
        );
        Object.assign(err, { statusCode: 409, currentStatus: state.status });
        throw err;
      }

      if (
        state.currentStepExecutionId &&
        state.currentStepExecutionId !== request.stepExecutionId
      ) {
        throw new Error(
          `Resume mismatch: run ${request.sessionId} is paused at stepExecutionId ` +
            `${state.currentStepExecutionId} but request provided ${request.stepExecutionId}`,
        );
      }

      // A pause that names its approvers is answered here as well as from the
      // Action Center, so the allowlist has to hold on both paths. Callers with
      // no actor context are the platform resuming its own work (OAuth
      // callbacks, timers, delegation), which no human targeting applies to.
      if (request.actorContext) {
        const pausePayload = await loadPausePayload(payloadStore, state.requestedInputRef);
        const resolverPolicy = deriveResolverPolicy(pausePayload);
        const permitted = isResolverAllowed(resolverPolicy, {
          actorUserId: request.actorContext.userId,
          actorSpaceRole: request.actorContext.spaceRole ?? 'viewer',
        });
        if (!permitted) {
          const err = new Error(
            `This request is waiting on a specific approver, so it cannot be resolved by you.`,
          );
          Object.assign(err, { statusCode: 403 });
          throw err;
        }
      }

      await dispatchResume(dbTyped, redis, {
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        stepExecutionId: request.stepExecutionId,
        inputRef,
        idempotencyKey,
        traceId: traceId as TraceId,
        ...(request.actorContext ? { actorContext: request.actorContext } : {}),
        ...(request.voiceMode !== undefined ? { voiceMode: request.voiceMode } : {}),
        ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
      });

      // When the resume is rerouted to a child (child_input), the orchestrator
      // will transition the parent back to WAITING_ON_CHILD, not RUNNING.
      // Return the expected status so the UI doesn't briefly show RUNNING.
      const expectedStatus: SessionStatus =
        state.delegationPauseSource === 'child_input' ? 'WAITING_ON_CHILD' : 'RUNNING';

      return {
        status: expectedStatus,
        traceId,
      };
    },

    async retrySession(request: RetrySessionRequest): Promise<RetrySessionResponse> {
      if (!redis) {
        throw new Error('Redis required for run execution. Set REDIS_URL.');
      }

      // Store inline input if provided
      let inputRef: string | undefined;
      if (request.inputRef) {
        inputRef = request.inputRef;
      } else if (request.input !== undefined) {
        // Encode input as inline base64 payload
        const inputBase64 = Buffer.from(JSON.stringify(request.input)).toString('base64');
        inputRef = `inline:${inputBase64}`;
      }

      const traceId = request.traceId ?? crypto.randomUUID();
      const idempotencyKey = request.idempotencyKey ?? crypto.randomUUID();

      // Validate the run is in FAILED status
      const stateResult = await getSessionStateSafe(redis, request.tenantId, request.sessionId);
      if (!stateResult.ok) {
        throw new Error(`Run ${request.sessionId} not found`);
      }

      const state = stateResult.state;
      if (state.status !== 'FAILED') {
        throw new Error(`Run ${request.sessionId} is not failed (current status: ${state.status})`);
      }

      // Idempotency at API boundary
      const tenantContext = createTenantContext(request.tenantId);
      const scope = `retry_run:${request.sessionId}`;
      let firstSeen = true;

      await withTenantSchema(dbTyped, tenantContext, async (tx: PostgresJsDatabase) => {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        try {
          await tx.insert(idempotencyKeys).values({
            idempotencyKey,
            scope,
            sessionId: request.sessionId,
            ...(request.stepExecutionId ? { stepExecutionId: request.stepExecutionId } : {}),
            expiresAt,
          });
        } catch {
          firstSeen = false;
        }
      });

      if (firstSeen) {
        await addControlMessage(redis, {
          messageVersion: 1,
          type: 'retry_run',
          tenantId: request.tenantId,
          runId: request.sessionId,
          ...(request.stepExecutionId ? { stepExecutionId: request.stepExecutionId } : {}),
          ...(inputRef ? { inputRef } : {}),
          traceId: traceId as TraceId,
          idempotencyKey: idempotencyKey as IdempotencyKey,
          requestedAtMs: Date.now(),
          ...(request.actorContext ? { actorContext: request.actorContext } : {}),
        });
      }

      return {
        status: 'RUNNING',
        retryCount: 1,
        traceId,
      };
    },

    async cancelSession(request) {
      if (!redis) {
        throw new Error('Redis required for run execution. Set REDIS_URL.');
      }

      // Guard: only cancel RUNNING or QUEUED runs (not PAUSED/WAITING_ON_CHILD/FAILED/terminal)
      const stateResult = await getSessionStateSafe(redis, request.tenantId, request.sessionId);
      if (stateResult.ok) {
        const s = stateResult.state.status;
        if (
          s === 'CANCELLED' ||
          s === 'SUCCEEDED' ||
          s === 'FAILED' ||
          s === 'PAUSED' ||
          s === 'WAITING_ON_CHILD'
        ) {
          const err = new Error(`Run ${request.sessionId} cannot be cancelled: status is ${s}`);
          Object.assign(err, { statusCode: 409, currentStatus: s });
          throw err;
        }
      }

      const traceId = crypto.randomUUID();
      const idempotencyKey = `cancel:${request.sessionId}`;

      await addControlMessage(redis, {
        messageVersion: 1,
        type: 'cancel_run',
        tenantId: request.tenantId,
        runId: request.sessionId,
        traceId: traceId as TraceId,
        idempotencyKey: idempotencyKey as IdempotencyKey,
        requestedAtMs: Date.now(),
      });

      return {
        status: 'CANCELLING',
        message: 'Cancellation requested',
      };
    },

    async interruptSession(request: { tenantId: TenantId; sessionId: SessionId }) {
      if (!redis) {
        throw new Error('Redis required for run execution. Set REDIS_URL.');
      }

      // Validate run is in a state that can be interrupted
      const stateResult = await getSessionStateSafe(redis, request.tenantId, request.sessionId);
      if (!stateResult.ok) {
        throw new Error(`Run ${request.sessionId} not found`);
      }
      const state = stateResult.state;

      const isDelegationWait =
        state.status === 'WAITING_ON_CHILD' ||
        (state.status === 'PAUSED' &&
          state.delegationPauseSource === 'child_input' &&
          Boolean(state.pausedChildSessionId));

      const workflowWaiters =
        state.status === 'PAUSED'
          ? await loadPendingWaitersForSession(
              dbTyped,
              request.tenantId as string,
              request.sessionId as string,
            )
          : [];
      const isWorkflowDelegationWait = workflowWaiters.length > 0;

      // Idempotent: interrupt already requested — surface current status.
      if (state.interruptRequested) {
        return {
          status: state.status as SessionStatus,
          message: 'Interrupt already requested',
        };
      }

      // Already paused (terminal pause, neither delegation-wait kind) — nothing to do.
      if (state.status === 'PAUSED' && !isDelegationWait && !isWorkflowDelegationWait) {
        return {
          status: 'PAUSED' as const,
          message: 'Run is already paused',
        };
      }

      // Idempotent for terminal/non-interruptible states — return current status
      // so UI can reconcile without a 409 error
      if (
        state.status !== 'RUNNING' &&
        state.status !== 'QUEUED' &&
        !isDelegationWait &&
        !isWorkflowDelegationWait
      ) {
        return {
          status: state.status as SessionStatus,
          message:
            state.status === 'FAILED'
              ? 'Run has already failed. Use retry to resume.'
              : `Run is in terminal state: ${state.status}`,
        };
      }

      const traceId = crypto.randomUUID();
      const idempotencyKey = `interrupt:${request.sessionId}`;

      try {
        await updateSessionState(redis, request.tenantId, request.sessionId, {
          interruptRequested: true,
        });
      } catch {
        // Best-effort. The control-message path below is the durable terminator;
        // the flag is just for read-side latency.
      }

      await addControlMessage(redis, {
        messageVersion: 1,
        type: 'interrupt_run',
        tenantId: request.tenantId,
        runId: request.sessionId,
        traceId: traceId as TraceId,
        idempotencyKey: idempotencyKey as IdempotencyKey,
        requestedAtMs: Date.now(),
      });

      return {
        status: 'RUNNING' as const,
        message: 'Interrupt requested — run will pause after the current step completes',
      };
    },

    async isSessionCorrupt(tenantId, sessionId) {
      if (!redis) return false;
      return isSessionCorrupt(redis, tenantId, sessionId);
    },

    async getSessionById(tenantId, sessionId) {
      // Metadata is durable-only — the hot state carries execution, not
      // presentation — so it is read alongside whichever path answers below
      // rather than being lost on the Redis fast path.
      const storedMetadata: StoredSessionMetadata | null = db
        ? await readSessionMetadata(dbTyped, tenantId, sessionId)
        : null;
      const metadata = storedMetadata ? projectSessionMetadata(storedMetadata) : undefined;

      if (redis) {
        const result = await getSessionStateSafe(redis, tenantId, sessionId);
        if (result.ok) {
          const redisState = result.state;
          let requiredInput: RequiredInputInfo | undefined;
          if (redisState.currentStepExecutionId && redisState.pauseReason) {
            requiredInput = {
              stepExecutionId: redisState.currentStepExecutionId as StepExecutionId,
            };
            if (redisState.requestedInputRef && payloadStore) {
              const hydrated = await hydrateRequestedInput(
                payloadStore,
                redisState.requestedInputRef,
              );
              if (hydrated) {
                if (hydrated.prompt && hydrated.placement !== 'chat_inline') {
                  requiredInput.prompt = hydrated.prompt;
                }
                if (hydrated.missingVariables && hydrated.missingVariables.length > 0) {
                  requiredInput.missingVariables = hydrated.missingVariables;
                }
              }
            }
          }
          const blockedOn = deriveSessionBlockedOn(redisState, requiredInput?.stepExecutionId);

          return {
            sessionId: redisState.sessionId as SessionId,
            target: redisState.target,
            agentVersion: redisState.agentVersion,
            status: redisState.status as SessionStatus,
            createdAt: new Date(redisState.createdAt).toISOString(),
            updatedAt: new Date(redisState.lastUpdatedAt).toISOString(),
            lastActivityAt: new Date(
              redisState.lastActivityAt ?? redisState.startedAt ?? redisState.createdAt,
            ).toISOString(),
            ...(redisState.createdBy ? { createdBy: redisState.createdBy } : {}),
            ...(metadata ? { metadata } : {}),
            completedAt: redisState.endedAt
              ? new Date(redisState.endedAt).toISOString()
              : undefined,
            inputRef: redisState.inputRef ?? undefined,
            outputRef: redisState.finalOutputRef ?? undefined,
            stepCount: 0,
            currentStepId: redisState.currentStepId ?? undefined,
            requiredInput,
            blockedOn,
          };
        }
      }

      // Fallback to Postgres (or corrupt/missing: try Postgres)
      const tenantContext = createTenantContext(tenantId);
      const runRepo = createSessionRepository(dbTyped, tenantContext);

      const run = await runRepo.getById(sessionId);
      if (!run) {
        return null;
      }

      return {
        sessionId: run.sessionId as SessionId,
        target: projectTargetColumns({
          targetKind: run.targetKind,
          targetSystemRole: run.targetSystemRole,
          targetAgentId: run.targetAgentId,
          targetInlineDefRef: run.targetInlineDefRef,
        }),
        agentVersion: run.agentVersion,
        status: run.status as SessionStatus,
        createdAt: run.startedAt.toISOString(),
        updatedAt: (run.hotStateUpdatedAt ?? run.startedAt).toISOString(),
        lastActivityAt: (run.lastActivityAt ?? run.startedAt).toISOString(),
        ...(run.createdBy ? { createdBy: run.createdBy } : {}),
        ...(metadata ? { metadata } : {}),
        completedAt: run.endedAt?.toISOString(),
        inputRef: run.requestedInputRef ?? undefined,
        outputRef: run.finalOutputRef ?? undefined,
        stepCount: 0, // Would need step count query
        currentStepId: run.startStepId ?? undefined,
        requiredInput:
          run.currentStepExecutionId && run.pauseReason
            ? {
                stepExecutionId: run.currentStepExecutionId as StepExecutionId,
              }
            : undefined,
      };
    },

    async listSessions(query) {
      const tenantContext = createTenantContext(query.tenantId);
      const runRepo = createSessionRepository(dbTyped, tenantContext);

      // Over-fetch when excludeTrigger is set so we can filter post-query
      // and still return the requested number of results.
      const overFetchFactor = query.excludeTrigger ? 3 : 1;

      // Build filter options - only include defined values (exactOptionalPropertyTypes)
      const listOptions: {
        targetKind?: 'platform-role' | 'custom-agent';
        targetAgentId?: AgentId;
        targetSystemRole?: string;
        status?: DbSessionStatus;
        spaceId?: string;
        createdBy?: string;
        limit?: number;
        cursor?: string;
      } = {
        limit: query.limit * overFetchFactor,
      };
      if (query.targetKind !== undefined) listOptions.targetKind = query.targetKind;
      if (query.targetAgentId !== undefined) listOptions.targetAgentId = query.targetAgentId;
      if (query.targetSystemRole !== undefined)
        listOptions.targetSystemRole = query.targetSystemRole;
      if (query.status !== undefined) listOptions.status = query.status as DbSessionStatus;
      if (query.spaceId !== undefined) listOptions.spaceId = query.spaceId;
      if (query.createdBy !== undefined) listOptions.createdBy = query.createdBy;
      let runs = await runRepo.list(listOptions);

      if (query.excludeTrigger && redis) {
        const triggerToExclude = query.excludeTrigger;
        const filtered = [];
        for (const run of runs) {
          const result = await getSessionStateSafe(redis, query.tenantId, run.sessionId);
          if (result.ok && result.state.trigger === triggerToExclude) {
            continue; // Skip this run
          }
          // If hot state is not available (flushed), include the run
          // since we can't determine the trigger.
          filtered.push(run);
          if (filtered.length >= query.limit) break;
        }
        runs = filtered;
      }

      return {
        sessions: runs.slice(0, query.limit).map((run) => ({
          sessionId: run.sessionId as SessionId,
          target: projectTargetColumns({
            targetKind: run.targetKind,
            targetSystemRole: run.targetSystemRole,
            targetAgentId: run.targetAgentId,
            targetInlineDefRef: run.targetInlineDefRef,
          }),
          agentVersion: run.agentVersion,
          status: run.status as SessionStatus,
          createdAt: run.startedAt.toISOString(),
          // The execution clock, which the projection advances on every step.
          // What a conversation list sorts on is `lastActivityAt`.
          updatedAt: (run.hotStateUpdatedAt ?? run.startedAt).toISOString(),
          lastActivityAt: (run.lastActivityAt ?? run.startedAt).toISOString(),
          completedAt: run.endedAt?.toISOString(),
          stepCount: 0,
          currentStepId: run.startStepId ?? undefined,
          // Who opened it. A shared space lists everyone's conversations
          // together, so without this they are indistinguishable.
          ...(run.createdBy ? { createdBy: run.createdBy } : {}),
          // From the same row the listing already read — a conversation list
          // that hydrated a transcript per row would not be one.
          metadata: projectSessionMetadata(run),
        })),
      };
    },

    async getSessionEvents(tenantId, sessionId, afterEventId, limit = 100) {
      if (!db) {
        return { kind: 'events', events: [], hasMore: false };
      }
      const tailService = createSessionTailService({
        db: dbTyped,
        redis,
        pubsubSubscriber: null, // not used by `tailAfter`
      });
      const result = await tailService.tailAfter(tenantId, sessionId, afterEventId, { limit });
      if (result.kind === 'reconcile_required') {
        return {
          kind: 'reconcile_required',
          reason: result.reason,
          ...(result.cursor ? { cursor: result.cursor } : {}),
        };
      }
      return {
        kind: 'events',
        events: result.events,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        hasMore: result.hasMore,
      };
    },

    async getSessionEventsBefore(tenantId, sessionId, beforeCursor, limit = 100) {
      if (!db) {
        return { kind: 'events', events: [], hasOlder: false };
      }
      const tailService = createSessionTailService({
        db: dbTyped,
        redis,
        pubsubSubscriber: null, // not used by `tailBefore`
      });
      const result = await tailService.tailBefore(tenantId, sessionId, beforeCursor, { limit });
      if ('kind' in result) {
        return {
          kind: 'reconcile_required',
          reason: result.reason,
          ...(result.cursor ? { cursor: result.cursor } : {}),
        };
      }
      return {
        kind: 'events',
        events: result.events,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        ...(result.olderCursor !== undefined ? { olderCursor: result.olderCursor } : {}),
        hasOlder: result.hasOlder,
      };
    },

    /* Event and payload shapes are dynamic; optional chaining is defensive */
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    async getSessionDebug(
      this: SessionService,
      tenantId: TenantId,
      sessionId: SessionId,
      options?: { eventsLimit?: number },
    ) {
      const session = await this.getSessionById(tenantId, sessionId);
      if (!session) return null;

      // `getSessionEvents(undefined, ...)` always returns `kind: 'events'`
      // — reconcile is only possible with a cursor the service can't
      // resolve. Without a cursor there is nothing to seek past.
      const result = await this.getSessionEvents(
        tenantId,
        sessionId,
        undefined,
        options?.eventsLimit ?? 200,
      );
      const events = result.kind === 'events' ? result.events : [];

      const warnings: string[] = [];
      let runtimeState: Record<string, unknown> | undefined;
      const agent: Record<string, AgentDebugInfo> = {};
      let requestedInputRef: string | undefined;
      let hotState: SessionHotState | undefined;

      // Extract runtime state and agent info from Redis if available
      if (redis) {
        const result = await getSessionStateSafe(redis, tenantId, sessionId);
        if (result.ok) {
          const state = result.state;
          hotState = state;
          requestedInputRef = state.requestedInputRef ?? undefined;
          const rs = state.runtimeState;
          if (rs?.variables) {
            const vars = rs.variables;
            runtimeState = {};

            for (const [key, entry] of Object.entries(vars)) {
              if (typeof entry !== 'object' || entry === null) continue;
              const ref = (entry as Record<string, unknown>)['ref'] as
                { kind: string; payloadRef?: string; value?: unknown } | undefined;
              if (!ref) continue;

              if (ref.kind === 'ref' && ref.payloadRef) {
                runtimeState[key] = { ref: ref.payloadRef };
              } else if (ref.kind === 'inline') {
                const val = ref.value;
                const summary =
                  typeof val === 'string'
                    ? val.length > 200
                      ? `${val.slice(0, 200)}...`
                      : val
                    : Array.isArray(val)
                      ? `[${val.length} items]`
                      : JSON.stringify(val).length > 200
                        ? JSON.stringify(val).slice(0, 200) + '...'
                        : val;
                runtimeState[key] = { summary };
              }

              if (key.startsWith('ai.agent.conversation.')) {
                const stepId = key.replace('ai.agent.conversation.', '');
                const payloadRef = ref.kind === 'ref' ? ref.payloadRef : undefined;
                agent[stepId] = agent[stepId] ?? { stepId };
                agent[stepId].conversationStateRef = payloadRef;
              }
            }
          }
        } else if (result.kind === 'corrupt') {
          warnings.push('Run hot state is marked corrupt');
        }
      }

      // ── Priority C: Current step hot state ──
      let currentStep: CurrentStepDebugInfo | undefined;
      if (redis && hotState?.currentStepExecutionId) {
        const stepState = await getStepState(redis, tenantId, hotState.currentStepExecutionId);
        if (stepState) {
          currentStep = {
            stepExecutionId: stepState.stepExecutionId,
            stepId: stepState.stepId,
            stepType: stepState.stepType,
            operationId: stepState.operationId,
            status: stepState.status,
            scheduledAt: stepState.scheduledAt,
            startedAt: stepState.startedAt,
            endedAt: stepState.endedAt,
            inputRef: stepState.inputRef,
            outputRef: stepState.outputRef,
            errorRef: stepState.errorRef,
            parentStepExecutionId: stepState.parentStepExecutionId,
          };
        }
      }

      // ── Priority D: Latest agent decision from output payload ──
      if (payloadStore) {
        for (const info of Object.values(agent)) {
          // Extract decision from the agent turn's OUTPUT payload.
          // Find the latest StepSucceeded event for this agent step to get its outputRef.
          const latestSucceeded = [...events]
            .reverse()
            .find(
              (e) =>
                e.eventType === 'StepSucceeded' &&
                e.data?.stepId === info.stepId &&
                (e.metadata?.['operationId'] === 'ai.agent.turn' ||
                  e.data?.['operationId'] === 'ai.agent.turn'),
            );
          const outputRef = latestSucceeded?.data?.['outputRef'];
          if (typeof outputRef === 'string') {
            try {
              const output = (await payloadStore.retrieve(outputRef as never)) as Record<
                string,
                unknown
              >;
              const decision = output?.['decision'] as Record<string, unknown> | undefined;
              if (decision?.['action']) {
                const calls = decision['calls'] as Array<{ stepId?: string }> | undefined;
                const msg = decision['message'] as string | undefined;
                info.lastDecision = {
                  action: decision['action'] as string,
                  ...(decision['stepId'] ? { stepId: decision['stepId'] as string } : {}),
                  ...(msg ? { message: msg.length > 200 ? msg.slice(0, 200) + '...' : msg } : {}),
                  ...(calls
                    ? {
                        callCount: calls.length,
                        callStepIds: calls
                          .map((c) => c.stepId)
                          .filter((s): s is string => typeof s === 'string'),
                      }
                    : {}),
                };
              }
            } catch {
              /* hydration failed — skip */
            }
          }
        }
      }

      // ── Priority E: Dynamic steps list (enriched with status from events) ──
      let dynamicSteps: DynamicStepDebugInfo[] | undefined;
      if (hotState?.dynamicSteps) {
        try {
          const parsed = JSON.parse(hotState.dynamicSteps) as unknown[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Build a per-stepId index of the latest status-bearing event
            const stepStatusMap = new Map<
              string,
              {
                status: string;
                stepExecutionId?: string;
                errorMessage?: string;
                durationMs?: number;
              }
            >();
            for (const evt of events) {
              const sid = evt.data?.stepId;
              if (!sid) continue;
              const et = evt.eventType;
              const seId = evt.stepExecutionId; // string | undefined
              if (et === 'StepScheduled') {
                // Only set if we haven't seen a later terminal event
                if (!stepStatusMap.has(sid)) {
                  const entry: { status: string; stepExecutionId?: string } = {
                    status: 'SCHEDULED',
                  };
                  if (seId) entry.stepExecutionId = seId;
                  stepStatusMap.set(sid, entry);
                }
              } else if (et === 'StepStarted') {
                const prev = stepStatusMap.get(sid);
                if (!prev || prev.status === 'SCHEDULED') {
                  const entry: { status: string; stepExecutionId?: string } = { status: 'RUNNING' };
                  if (seId) entry.stepExecutionId = seId;
                  stepStatusMap.set(sid, entry);
                }
              } else if (et === 'StepSucceeded') {
                const scheduledEvt = events.find(
                  (e) => e.eventType === 'StepScheduled' && e.data?.stepId === sid,
                );
                const scheduledTs = scheduledEvt ? new Date(scheduledEvt.timestamp).getTime() : 0;
                const succeededTs = new Date(evt.timestamp).getTime();
                const entry: { status: string; stepExecutionId?: string; durationMs?: number } = {
                  status: 'SUCCEEDED',
                };
                if (seId) entry.stepExecutionId = seId;
                if (scheduledTs > 0) entry.durationMs = succeededTs - scheduledTs;
                stepStatusMap.set(sid, entry);
              } else if (et === 'StepFailed') {
                const scheduledEvt = events.find(
                  (e) => e.eventType === 'StepScheduled' && e.data?.stepId === sid,
                );
                const scheduledTs = scheduledEvt ? new Date(scheduledEvt.timestamp).getTime() : 0;
                const failedTs = new Date(evt.timestamp).getTime();
                const errMsg =
                  (evt.metadata?.['errorMessage'] as string | undefined) ??
                  (evt.data?.['errorMessage'] as string | undefined);
                const entry: {
                  status: string;
                  stepExecutionId?: string;
                  errorMessage?: string;
                  durationMs?: number;
                } = {
                  status: 'FAILED',
                };
                if (seId) entry.stepExecutionId = seId;
                if (errMsg) entry.errorMessage = errMsg;
                if (scheduledTs > 0) entry.durationMs = failedTs - scheduledTs;
                stepStatusMap.set(sid, entry);
              } else if (et === 'StepPaused') {
                const entry: { status: string; stepExecutionId?: string } = { status: 'PAUSED' };
                if (seId) entry.stepExecutionId = seId;
                stepStatusMap.set(sid, entry);
              }
            }

            const toStr = (v: unknown) =>
              typeof v === 'object' && v !== null
                ? JSON.stringify(v)
                : String((v ?? '') as string | number | boolean);
            dynamicSteps = parsed.map((s) => {
              const entry = s as Record<string, unknown>;
              const stepId = toStr(entry['stepId'] ?? '');
              const info = stepStatusMap.get(stepId);
              const base: DynamicStepDebugInfo = {
                stepId,
                stepType: toStr(entry['stepType'] ?? ''),
                operation: toStr(entry['operation'] ?? ''),
              };
              if (info) {
                base.status = info.status;
                if (info.stepExecutionId) base.stepExecutionId = info.stepExecutionId;
                if (info.errorMessage) base.error = { message: info.errorMessage };
                if (info.durationMs !== undefined) base.durationMs = info.durationMs;
              }
              return base;
            });
          }
        } catch {
          /* ignore parse errors */
        }
      }

      let delegationTree: DelegationTreeEntry[] | undefined;

      if (redis && hotState) {
        const childIds = hotState.waitingForChildSessionIds ?? [];
        // Also check events for completed children (no longer in waitingForChildSessionIds)
        const delegateEvents = events.filter(
          (e) =>
            e.eventType === 'StepSucceeded' &&
            (e.metadata?.['operationId'] === 'agent.control.delegate' ||
              e.data?.['operationId'] === 'agent.control.delegate'),
        );
        const childSessionIds = new Set<string>(childIds);
        for (const evt of delegateEvents) {
          const output = evt.data?.['output'] as Record<string, unknown> | undefined;
          const csId = output?.['childSessionId'] as string | undefined;
          if (csId) childSessionIds.add(csId);
        }

        if (childSessionIds.size > 0) {
          delegationTree = [];
          for (const childId of childSessionIds) {
            const childState = await getSessionStateSafe(redis, tenantId, childId as SessionId);
            if (childState.ok) {
              const entry: DelegationTreeEntry = {
                childSessionId: childId,
                target: childState.state.target,
                status: childState.state.status,
                depth: childState.state.delegationDepth ?? 1,
              };
              if (childState.state.startedAt != null) entry.startedAt = childState.state.startedAt;
              if (childState.state.endedAt != null) entry.completedAt = childState.state.endedAt;
              delegationTree.push(entry);
            } else {
              delegationTree.push({
                childSessionId: childId,
                depth: 1,
              });
            }
          }
        }
      }

      return {
        session,
        recentEvents: events,
        runtimeState,
        agent: Object.keys(agent).length > 0 ? agent : undefined,
        currentStep,
        dynamicSteps,
        delegationTree,
        ...(hotState?.parentSessionId ? { parentSessionId: hotState.parentSessionId } : {}),
        refs: {
          inputRef: session.inputRef,
          outputRef: session.outputRef,
          errorRef: session.errorRef,
          requestedInputRef,
        },
        warnings: warnings.length > 0 ? warnings : undefined,
      } satisfies SessionDebugView;
    },
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    async getSessionStateView(tenantId, sessionId) {
      if (!redis) return null;

      const result = await getSessionStateSafe(redis, tenantId, sessionId);
      if (!result.ok) {
        if (result.kind === 'corrupt') {
          return {
            sessionHotState: {
              sessionId,
              tenantId,
              // Corrupt state — `target` is explicitly null. Inspecting tools
              // branch on `isCorrupt` to decide whether to show the target.
              target: null,
              agentVersion: '',
              status: 'STALLED',
              createdAt: 0,
              lastUpdatedAt: 0,
            },
            isCorrupt: true,
            // Note: this is a Redis key (not a payload ref). Useful for redis-cli inspection.
            corruptMarkerRef: StreamKeys.sessionCorruptMarkerKey(tenantId, sessionId),
          };
        }
        return null;
      }

      const state = result.state;
      const variables: Record<string, { ref?: string; summary?: string }> = {};

      if (state.runtimeState?.variables) {
        for (const [key, entry] of Object.entries(state.runtimeState.variables)) {
          if (typeof entry !== 'object' || entry === null) continue;
          const ref = (entry as Record<string, unknown>)['ref'] as
            { kind: string; payloadRef?: string; value?: unknown } | undefined;
          if (!ref) continue;

          if (ref.kind === 'ref' && ref.payloadRef) {
            variables[key] = { ref: ref.payloadRef };
          } else if (ref.kind === 'inline') {
            const val = ref.value;
            const summary =
              typeof val === 'string'
                ? val.length > 100
                  ? `${val.slice(0, 100)}...`
                  : val
                : Array.isArray(val)
                  ? `[${val.length} items]`
                  : JSON.stringify(val).length > 100
                    ? JSON.stringify(val).slice(0, 100) + '...'
                    : String(val);
            variables[key] = { summary };
          }
        }
      }

      const dynamicSteps = state.dynamicSteps;
      const dynamicStepsCount = dynamicSteps ? (JSON.parse(dynamicSteps) as unknown[]).length : 0;

      return {
        sessionHotState: {
          sessionId: state.sessionId,
          tenantId: state.tenantId,
          target: state.target,
          agentVersion: state.agentVersion,
          status: state.status,
          currentStepId: state.currentStepId,
          createdAt: state.createdAt,
          startedAt: state.startedAt,
          endedAt: state.endedAt,
          inputRef: state.inputRef,
          finalOutputRef: state.finalOutputRef,
          errorRef: state.errorRef,
          pauseReason: state.pauseReason,
          requestedInputRef: state.requestedInputRef,
          traceId: state.traceId,
          lastUpdatedAt: state.lastUpdatedAt,
        },
        runtimeState: {
          variables,
          version: state.runtimeState?.version,
          updatedAtMs: state.runtimeState?.updatedAtMs,
        },
        dynamicStepsCount,
        variableDefsOverlay: state.variableDefsOverlay
          ? (() => {
              try {
                return JSON.parse(state.variableDefsOverlay) as Record<string, unknown>;
              } catch {
                return undefined;
              }
            })()
          : undefined,
      };
    },

    async postRoomMessage(request) {
      if (!redis) throw new Error('Room messages require Redis');

      return postRoomMessageDirect(redis, dbTyped, {
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        actorUserId: request.actorContext.userId,
        body: request.body,
        ...(request.actorContext.displayName
          ? { actorDisplayName: request.actorContext.displayName }
          : {}),
        ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
        ...(request.wakeHelmsman ? { wakeHelmsman: true } : {}),
      });
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a session service based on the application context.
 * Uses mock service when no database is available.
 */
export function createSessionService(ctx: AppContext): SessionService {
  if (ctx.isMock || !ctx.db) {
    return createMockSessionService();
  }
  return createRealSessionService(ctx);
}
