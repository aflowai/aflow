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
  extendStepInFlight,
  clearStepInFlight,
  getStepInFlight,
  type StepInFlightStatus,
} from './streams/executorHeartbeat.js';

export {
  EXECUTOR_WAIT_LOOKS,
  EXECUTOR_WAIT_FIRST_LOOK_MS,
  EXECUTOR_WAIT_LONGEST_LOOK_MS,
  executorWaitGapMs,
  executorWaitClockJumped,
} from './streams/executorWait.js';

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
  EXECUTOR_UNAVAILABLE_CODE,
} from './streams/engineHealth.js';

export {
  addStepJob,
  readStepJobs,
  ackStepJob,
  releaseStepJob,
  StepJobNotPendingError,
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
  getShardTimer,
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
  type TimerIdentity,
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
