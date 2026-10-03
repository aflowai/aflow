/**
 * @aflow/redis - Redis client and streams helpers for Aflow
 *
 * This package provides:
 * - Redis connection management
 * - Redis Streams for job scheduling and result transport
 * - Timer/delayed scheduling using sorted sets
 * - Hot state caching for run/step data
 *
 * @packageDocumentation
 */

// Connection management
export {
  type RedisConfig,
  type BlockingRedisConnection,
  getRedisConfig,
  getExecutorRedisConfig,
  getRedisConnection,
  createBlockingRedisConnection,
  streamIdToTimestampMs,
  closeRedisConnection,
  createRedisConnection,
  createSubscriberConnection,
  quitRedisWithTimeout,
  attachRedisErrorGuard,
  pingRedis,
  type RedisErrorGuardLogger,
} from './connection.js';

// Streams operations
export {
  type StreamEntry,
  type PendingEntry,
  ensureConsumerGroup,
  ensureJobStreamGroups,
  // Executor availability
  registerExecutorHeartbeat,
  unregisterExecutorHeartbeat,
  hasAvailableExecutor,
  isExecutorConsumerAlive,
  registerStepInFlight,
  clearStepInFlight,
  getStepInFlight,
  type StepInFlightStatus,
  listPendingStepJobs,
  claimPendingStepJobsByIds,
  NoExecutorAvailableError,
  // Stream hygiene
  type StreamCleanupResult,
  cleanupStaleConsumers,
  // Orchestrator heartbeat
  registerOrchestratorHeartbeat,
  unregisterOrchestratorHeartbeat,
  isOrchestratorAlive,
  isInstanceAlive,
  listLiveOrchestrators,
  INSTANCE_LEASE_TTL_MS,
  // Engine health
  type EngineHealthStatus,
  type QueueStats,
  getEngineHealth,
  // Job operations
  addStepJob,
  readStepJobs,
  ackStepJob,
  releaseStepJob,
  claimPendingStepJobs,
  addControlMessage,
  publishStepAbort,
  markStepCancelled,
  wasStepCancelled,
  claimControlDispatchIdempotency,
  releaseControlDispatchIdempotency,
  type StartRunIdempotencyClaim,
  addStepResult,
  armRetentionCandidate,
  claimRetentionCandidates,
  computeAckedFrontier,
  execAckPipeline,
  firstReplyString,
  peekRetentionCandidates,
  rearmRetentionCandidates,
  trimToAckedFrontier,
  type StreamRetentionResult,
  readShardControlMessages,
  readShardPendingControlMessages,
  ackShardControlMessage,
  readShardStepResults,
  readShardPendingStepResults,
  ackShardStepResult,
  batchAckShardStepResults,
  buildResultStreamSet,
  buildControlStreamSet,
  EMPTY_SHARD_STREAM_SET,
  type ShardStreamSet,
  ensureShardStreamGroups,
  scheduleShardTimer,
  claimDueShardTimers,
  ackShardTimer,
  ackShardTimerById,
  rescheduleClaimedTimer,
  repairDueShardIndex,
  migrateLegacyShardTimers,
  TIMER_CLAIM_PER_SHARD,
  TIMER_CLAIM_MAX_TOTAL,
  timerId,
  TIMER_LEASE_MS,
  TIMER_MAX_CLAIMS,
  timerShardKey,
  type ShardStreamType,
  listShardPendingMessages,
  claimShardPendingMessages,
  setSessionHotState,
  getSessionHotState,
  deleteSessionHotState,
  refreshSessionHotStateTtl,
  setRunMeta,
  getRunMeta,
  compareStreamIds as compareRedisStreamIds,
  isValidStreamId,
  nextStreamId,
  parseStreamId,
  tryParseStreamId,
  type ParsedStreamId,
} from './streams.js';

// DLQ utilities
export {
  type DLQMessage,
  type DLQStats,
  type ReplayResult,
  DLQInspector,
  DLQReplayer,
  createDLQInspector,
  createDLQReplayer,
} from './dlq.js';

// Hot state operations (Redis-first session execution)
export {
  type SessionHotState,
  SessionHotStateSchema,
  type SessionEvent,
  SessionEventSchema,
  type StepHotState,
  StepHotStateSchema,
  HOT_STATE_TTL_SECONDS,
  CORRUPT_MARKER_TTL_SECONDS,
  getSessionStateSafe,
  isSessionCorrupt,
  clearQuarantineMark,
  salvageCorruptStateFields,
  type SalvagedCorruptFields,
  type GetSessionStateSafeResult,
  setSessionState,
  getSessionState,
  updateSessionState,
  casUpdateSessionRuntimeState,
  readSpaceContextGen,
  bumpSpaceContextGen,
  setStepState,
  setStepStateIfAbsent,
  getStepState,
  updateStepState,
  markSessionDirty,
  appendSessionEvent,
  readSessionEvents,
  readSessionEventEntries,
  readSessionEventEntriesBefore,
  type SessionEventEntry,
  type ReadSessionEventEntriesResult,
  type ReadSessionEventEntriesBeforeResult,
  readDurableEventEntries,
  compareStreamIds,
  type DurableEventEntry,
  readLatestSessionPosition,
  deleteSessionEvents,
  appendLiveDelta,
  publishLiveDeltaWake,
  readLiveDeltaFrom,
  clearLiveBuffers,
  type LiveStreamChannel,
  type LiveStreamRead,
  appendRoomMessage,
  allocateMessageSeq,
  type AppendRoomMessageInput,
  type AppendRoomMessageResult,
  atomicCreateSession,
  atomicCompleteStep,
  atomicScheduleStep,
  addWaitingChild,
  removeWaitingChild,
  claimProjectionCandidates,
  ackProjection,
  dropProjectionCandidate,
  dropProjectionCandidateIfVersion,
  countProjectionCandidates,
  carryOverLegacyDirtySessions,
  type LegacyDirtyCarryOver,
  PROJECTION_CLAIM_LEASE_MS,
  type ProjectionCandidate,
  sessionCandidateMember,
  parseSessionCandidateMember,
  claimDueQueuedSessions,
  rearmQueuedSessionCandidate,
  dropQueuedSessionCandidate,
  QUEUED_SESSION_CLAIM_LEASE_MS,
  type QueuedSessionCandidate,
  claimSessionMetadataCandidates,
  settleSessionMetadata,
  requestSessionMetadataNow,
  dropSessionMetadataCandidate,
  sessionMetadataLeaseHeld,
  countSessionMetadataCandidates,
  SESSION_METADATA_CLAIM_LEASE_MS,
  type SessionMetadataCandidate,
  type SessionMetadataOutcome,
  type SettleSessionMetadataResult,
  peekDueStepStallCandidates,
  refreshStepStallCandidate,
  dropStepStallCandidate,
  stepStallEarliestReapAtMs,
  stepStallNextCheckAtMs,
  STEP_STALL_SCAN_INTERVAL_MS,
  STEP_SCHEDULED_STALL_GRACE_MS,
  STEP_STARTED_DEAD_EXECUTOR_GRACE_MS,
  STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS,
  STEP_DEADLINE_BACKSTOP_MS,
  type StepStallCandidate,
  peekDueDelegationSupervisionCandidates,
  refreshDelegationSupervisionCandidate,
  dropDelegationSupervisionCandidate,
  purgeDelegationSupervisionCandidate,
  countDelegationSupervisionCandidates,
  carryOverWaitingParents,
  DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
  type DelegationSupervisionCandidate,
  mayWake,
  claimEventDrivenTurn,
  returnEventDrivenTurn,
  type EventDrivenTurnClaim,
} from './hotState.js';

export {
  type DelegationPendingData,
  type ClaimedDelegation,
  upsertPendingDelegationCompletion,
  claimDuePendingDelegations,
  releasePendingDelegation,
  releasePendingDelegationAfterEscalation,
  completeDelegationLifecycle,
  abortDelegationLifecycle,
  getPendingDelegationData,
  getDelegationParent,
  getPendingDelegationCount,
} from './delegationPending.js';

// (re-open hotState block to keep grouped exports)
export {
  registerBarrierWatchdog,
  removeBarrierWatchdog,
  peekStaleBarriers,
  claimBarrier,
  refreshBarrier,
  dropBarrier,
  RUN_ACCESS_GRANT_FIELD,
  serializeRunAccessGrant,
  parseRunAccessGrant,
  getRunAccessGrant,
  setRunAccessGrant,
  simulationRunContextField,
  SIMULATION_RUN_INPUT_FIELD,
  getSimulationRunInput,
  serializeSimulationRunContext,
  parseSimulationRunContext,
  getSimulationRunContext,
  pinSimulationRunContext,
  DISCLOSED_CALLERS_FIELD,
  serializeDisclosedCallers,
  getDisclosedCallers,
} from './hotState.js';
export type { StaleBarrier } from './hotState.js';

// Write-action approval grants (Plan 253)
export {
  writeApprovalGrantKey,
  setWriteApprovalGrant,
  getWriteApprovalGrant,
  hostPushRequestHash,
} from './writeApproval.js';

// Memory embedding operations
export {
  MEMORY_EMBED_CONSUMER_GROUP,
  ensureMemoryEmbedConsumerGroup,
  publishMemoryEmbedJob,
  readMemoryEmbedJobs,
  ackMemoryEmbedJob,
  claimPendingMemoryEmbedJobs,
  publishMemoryEmbedJobToDlq,
} from './memoryEmbed.js';

// Memory v2 doc embedding operations
export {
  MEMORY_DOC_EMBED_CONSUMER_GROUP,
  ensureMemoryDocEmbedConsumerGroup,
  publishMemoryDocEmbedJob,
  readMemoryDocEmbedJobs,
  ackMemoryDocEmbedJob,
  claimPendingMemoryDocEmbedJobs,
} from './memoryDocEmbed.js';

// API catalog cache invalidation (Pub/Sub)
export {
  type ApiCatalogInvalidation,
  type ApiCatalogInvalidationCallback,
  publishApiCatalogInvalidation,
  subscribeApiCatalogInvalidation,
} from './apiCatalogCache.js';

export {
  type McpCatalogInvalidation,
  type McpCatalogInvalidationCallback,
  publishMcpCatalogInvalidation,
  subscribeMcpCatalogInvalidation,
} from './mcpCatalogCache.js';

export {
  type ProviderCredentialInvalidation,
  type ProviderCredentialInvalidationCallback,
  publishProviderCredentialInvalidation,
  subscribeProviderCredentialInvalidation,
} from './providerCredentialCache.js';

export {
  acquireMcpElicitationLease,
  refreshMcpElicitationLease,
  readMcpElicitationLease,
  releaseMcpElicitationLease,
  forceDeleteMcpElicitationLease,
} from './mcpElicitationLease.js';

export {
  MCP_ELICITATION_RECHECK_MS,
  type McpElicitationLeaseCandidate,
  mcpElicitationCandidateMember,
  parseMcpElicitationCandidateMember,
  mcpElicitationNextCheckAtMs,
  peekDueMcpElicitationLeaseCandidates,
  claimMcpElicitationLeaseCandidate,
  refreshMcpElicitationLeaseCandidate,
  dropMcpElicitationLeaseCandidate,
} from './mcpElicitationLeaseCandidates.js';

export {
  type McpElicitationLeaseSeedResult,
  seedMcpElicitationLeaseCandidatesOnce,
} from './mcpElicitationLeaseRollout.js';

export {
  type McpElicitationRequestEnvelope,
  type McpElicitationRequestCallback,
  publishMcpElicitationRequest,
  subscribeMcpElicitationRequests,
  publishMcpElicitationResponse,
  subscribeMcpElicitationResponse,
} from './mcpElicitation.js';

export {
  type StoredMcpElicitationRequest,
  setMcpElicitationRequest,
  getMcpElicitationRequest,
  deleteMcpElicitationRequest,
} from './mcpElicitationRequest.js';

export { appendGuardrailCheck, readGuardrailLog } from './guardrailLog.js';

export {
  markPresent,
  markAway,
  readPresence,
  readPresenceForSessions,
  subscribeToPresence,
} from './presence.js';

export { publishAppletInstanceDelta, subscribeToAppletInstance } from './appletInstance.js';

export { setAppletFocus, getAppletFocus, clearAppletFocus } from './appletFocus.js';

export {
  buildCatchUpDelta,
  markSeen,
  markSeenThroughMessage,
  readLastSeen,
  takeRoomMessagePosition,
  type SeenMarker,
} from './catchUp.js';

export {
  buildTranscript,
  type TranscriptBuilderDeps,
  type PayloadRetriever,
} from './evalTranscript.js';

export {
  allocateRecoverySeq,
  allocateRecoverySeqBatch,
  buildRecoveryEvent,
  appendRecoveryEvent,
  appendRecoveryEventsToPipeline,
  readRecoveryEvents,
  getRecoveryEventCount,
  resetRecoveryEventCount,
  trimRecoveryStream,
  deleteRecoveryData,
} from './recoveryStream.js';

export {
  SHARD_COUNT,
  SHARD_LEASE_TTL_SECONDS,
  shardFor,
  acquireShard,
  acquireAvailableShards,
  releaseShards,
  getShardOwnerMap,
  getShardRegistryEntry,
  getShardOwners,
  renewLegacyShardHeartbeats,
  clearLegacyShardHeartbeats,
  getShardFencingToken,
  validateShardOwnership,
  type ShardLeaseEntry,
  markRunActive,
  markRunInactive,
  getActiveShardIds,
  reconcileActiveRuns,
  getShardActiveRuns,
  getSystemLoad,
  type SystemLoad,
} from './shard.js';

export { appendErrorReport } from './errorReports.js';

export {
  publishActionCenterFocus,
  publishActionCenterWake,
  type ActionCenterFocusMessage,
  type ActionCenterWakeMessage,
} from './actionCenterFocus.js';

export {
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
  type WorkspaceManifestScope,
  type WorkspaceManifestScopeValue,
  WorkspaceManifestSchema,
  WorkspaceManifestEntrySchema,
  WorkspaceManifestScopeSchema,
  WORKSPACE_MANIFEST_DEFAULT_TTL_SECONDS,
  workspaceManifestKey,
  setWorkspaceManifest,
  getWorkspaceManifest,
  deleteWorkspaceManifest,
} from './computeWorkspace.js';

export {
  ENTITY_EVENTS_MAXLEN,
  ENTITY_EVENTS_TTL_SECONDS,
  ENTITY_EVENTS_STREAM_KEY,
  ENTITY_EVENTS_PUBSUB_CHANNEL,
  appendEntityEvent,
  readEntityEvents,
  readEntityEventStreamEntries,
  type EntityStreamEntry,
} from './entityEvents.js';

export {
  relabelEntityEventStreams104a,
  relabelEntityEventStream104aForSpace,
} from './entityEventsLegacyRelabel.js';

// Re-export Redis type for convenience
export type { Redis } from 'ioredis';

export {
  consumeEmbeddingBudget,
  estimateEmbeddingTokens,
  type EmbeddingBudgetLimits,
  type EmbeddingBudgetResult,
} from './embeddingBudget.js';

export {
  reserveComputeSeconds,
  settleComputeSeconds,
  type ComputeBudgetLimits,
  type ComputeBudgetResult,
} from './computeBudget.js';

export * from './hostInventory.js';
export * from './browserHandoff.js';
export * from './sessionResidue.js';
