/**
 * Redis Streams helpers — thin barrel re-exporting stream family modules.
 */
export { serializeMessage, deserializeMessage } from './streams/serialization.js';

export type { StreamEntry, PendingEntry } from './streams/types.js';

export { ensureConsumerGroup, ensureJobStreamGroups } from './streams/consumerGroups.js';

export { type StreamCleanupResult, cleanupStaleConsumers } from './streams/hygiene.js';

export {
  registerExecutorHeartbeat,
  unregisterExecutorHeartbeat,
  hasAvailableExecutor,
  isExecutorConsumerAlive,
  registerStepInFlight,
  clearStepInFlight,
  getStepInFlight,
  type StepInFlightStatus,
} from './streams/executorHeartbeat.js';

export {
  registerOrchestratorHeartbeat,
  unregisterOrchestratorHeartbeat,
  isOrchestratorAlive,
  isInstanceAlive,
  listLiveOrchestrators,
  INSTANCE_LEASE_TTL_MS,
} from './streams/orchestratorHeartbeat.js';

export {
  type QueueStats,
  type EngineHealthStatus,
  getEngineHealth,
  NoExecutorAvailableError,
} from './streams/engineHealth.js';

export {
  addStepJob,
  readStepJobs,
  ackStepJob,
  claimPendingStepJobs,
  listPendingStepJobs,
  claimPendingStepJobsByIds,
} from './streams/jobs.js';

export {
  addControlMessage,
  publishStepAbort,
  markStepCancelled,
  wasStepCancelled,
  claimControlDispatchIdempotency,
  releaseControlDispatchIdempotency,
  type StartRunIdempotencyClaim,
} from './streams/control.js';

export { addStepResult } from './streams/results.js';

export {
  armRetentionCandidate,
  claimRetentionCandidates,
  computeAckedFrontier,
  execAckPipeline,
  firstReplyString,
  peekRetentionCandidates,
  rearmRetentionCandidates,
  trimToAckedFrontier,
  type StreamRetentionResult,
} from './streams/retention.js';

export {
  compareStreamIds,
  isValidStreamId,
  nextStreamId,
  parseStreamId,
  tryParseStreamId,
  type ParsedStreamId,
} from './streams/streamId.js';

export {
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
} from './streams/shardReads.js';

export { ensureShardStreamGroups } from './streams/shardGroups.js';

export {
  scheduleShardTimer,
  claimDueShardTimers,
  ackShardTimer,
  ackShardTimerById,
  rescheduleClaimedTimer,
  repairDueShardIndex,
  migrateLegacyShardTimers,
  TIMER_CLAIM_PER_SHARD,
  TIMER_CLAIM_MAX_TOTAL,
  timerShardKey,
  timerId,
  TIMER_LEASE_MS,
  TIMER_MAX_CLAIMS,
  type ClaimedTimers,
} from './streams/shardTimers.js';

export {
  type ShardStreamType,
  listShardPendingMessages,
  claimShardPendingMessages,
} from './streams/shardPending.js';

export {
  setSessionHotState,
  getSessionHotState,
  deleteSessionHotState,
  refreshSessionHotStateTtl,
  setRunMeta,
  getRunMeta,
} from './streams/legacyHotState.js';
