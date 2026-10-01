/**
 * Redis-first hot state — thin barrel re-exporting domain modules.
 */
export type { SessionHotState, StepHotState, SessionEvent } from './hotState/schemas.js';
export {
  claimProjectionCandidates,
  ackProjection,
  dropProjectionCandidate,
  dropProjectionCandidateIfVersion,
  countProjectionCandidates,
  PROJECTION_CLAIM_LEASE_MS,
  type ProjectionCandidate,
} from './hotState/projectionCandidates.js';
export {
  carryOverLegacyDirtySessions,
  type LegacyDirtyCarryOver,
} from './hotState/legacyDirtyCarryOver.js';

export {
  peekDueDelegationSupervisionCandidates,
  refreshDelegationSupervisionCandidate,
  dropDelegationSupervisionCandidate,
  purgeDelegationSupervisionCandidate,
  countDelegationSupervisionCandidates,
  DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
  type DelegationSupervisionCandidate,
} from './hotState/delegationSupervisionCandidates.js';

export { carryOverWaitingParents } from './hotState/delegationSupervisionCarryOver.js';

export { sessionCandidateMember, parseSessionCandidateMember } from './hotState/candidateMember.js';

export {
  claimDueQueuedSessions,
  rearmQueuedSessionCandidate,
  dropQueuedSessionCandidate,
  QUEUED_SESSION_CLAIM_LEASE_MS,
  type QueuedSessionCandidate,
} from './hotState/queuedSessionCandidates.js';

export {
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
} from './hotState/sessionMetadataCandidates.js';

export {
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
} from './hotState/stepStallCandidates.js';

export {
  HOT_STATE_TTL_SECONDS,
  CORRUPT_MARKER_TTL_SECONDS,
  SessionHotStateSchema,
  StepHotStateSchema,
  SessionEventSchema,
} from './hotState/schemas.js';

export {
  type GetSessionStateSafeResult,
  type SalvagedCorruptFields,
  setSessionState,
  getSessionStateSafe,
  isSessionCorrupt,
  salvageCorruptStateFields,
  clearQuarantineMark,
  getSessionState,
  updateSessionState,
  casUpdateSessionRuntimeState,
  readSpaceContextGen,
  bumpSpaceContextGen,
} from './hotState/session.js';

export {
  setStepState,
  setStepStateIfAbsent,
  getStepState,
  updateStepState,
} from './hotState/step.js';

export { markSessionDirty } from './hotState/dirty.js';

export {
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
} from './hotState/events.js';

export {
  type LiveStreamChannel,
  type LiveStreamRead,
  appendLiveDelta,
  publishLiveDeltaWake,
  readLiveDeltaFrom,
  clearLiveBuffers,
} from './hotState/liveStream.js';

export {
  appendRoomMessage,
  allocateMessageSeq,
  type AppendRoomMessageInput,
  type AppendRoomMessageResult,
} from './hotState/roomMessages.js';

export {
  mayWake,
  claimEventDrivenTurn,
  returnEventDrivenTurn,
  type EventDrivenTurnClaim,
} from './hotState/eventWake.js';

export { atomicCreateSession, atomicCompleteStep, atomicScheduleStep } from './hotState/atomic.js';

export { addWaitingChild, removeWaitingChild } from './hotState/waitingChild.js';

export {
  registerBarrierWatchdog,
  removeBarrierWatchdog,
  peekStaleBarriers,
  claimBarrier,
  refreshBarrier,
  dropBarrier,
} from './hotState/barriers.js';
export type { StaleBarrier } from './hotState/barriers.js';

export {
  RUN_ACCESS_GRANT_FIELD,
  serializeRunAccessGrant,
  parseRunAccessGrant,
  getRunAccessGrant,
  setRunAccessGrant,
} from './hotState/grants.js';

export {
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
} from './hotState/simulationRunContext.js';
