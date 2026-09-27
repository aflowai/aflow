import type { Redis } from 'ioredis';
import { StreamKeys, type RecoveryEventEnvelope } from '@aflow/schemas';
import { appendRecoveryEventsToPipeline } from '../recoveryStream.js';
import type { SessionHotState } from './schemas.js';
import {
  HOT_STATE_TTL_SECONDS,
  CORRUPT_MARKER_TTL_SECONDS,
  SessionHotStateSchema,
} from './schemas.js';
import {
  serializeForHash,
  serializeForHashWithDeletes,
  deserializeFromHash,
} from './serialization.js';
import { syncQueuedSessionCandidate } from './queuedSessionCandidates.js';
import { syncStepStallCandidateForSession } from './stepStallCandidates.js';
import { syncDelegationSupervisionCandidate } from './delegationSupervisionCandidates.js';
import { markProjectionCandidate } from './projectionCandidates.js';
import { syncSessionMetadataCandidate } from './sessionMetadataCandidates.js';
import { sessionCandidateMember } from './candidateMember.js';

export async function setSessionState(
  redis: Redis,
  state: SessionHotState,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  const key = StreamKeys.sessionStateKey(state.tenantId, state.sessionId);
  const serialized = serializeForHash(state);

  const nowMs = Date.now();
  // MULTI, not a pipeline: the rewrite is DEL followed by HSET, and a pipeline
  // lets another client's read land between them and see the session as gone.
  // Callers treat a missing session as a real fact — one of them fabricates a
  // failure for a child whose state has vanished — so a torn read here is
  // indistinguishable from a session that genuinely expired.
  const pipeline = redis.multi();
  pipeline.del(key);
  pipeline.hset(key, serialized);
  pipeline.expire(key, ttlSeconds);
  syncQueuedSessionCandidate(
    pipeline,
    state.tenantId,
    state.sessionId,
    state.status,
    state.createdAt,
    nowMs,
  );
  syncStepStallCandidateForSession(pipeline, state.tenantId, state.sessionId, state.status);
  // Unconditional, unlike the others: they derive from `status` and a write
  // that carries none says nothing about them, but every field of a session is
  // durable, so any write at all is something Postgres has yet to see.
  markProjectionCandidate(pipeline, sessionCandidateMember(state.tenantId, state.sessionId));
  syncDelegationSupervisionCandidate(
    pipeline,
    state.tenantId,
    state.sessionId,
    state.status,
    nowMs,
  );
  await pipeline.exec();
}

export type GetSessionStateSafeResult =
  | { ok: true; state: SessionHotState }
  | { ok: false; kind: 'missing' }
  | { ok: false; kind: 'corrupt'; error: unknown };

export async function getSessionStateSafe(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<GetSessionStateSafeResult> {
  const corruptKey = StreamKeys.sessionCorruptMarkerKey(tenantId, runId);
  if ((await redis.exists(corruptKey)) === 1) {
    return { ok: false, kind: 'corrupt', error: { message: 'Run state marked corrupt' } };
  }

  const key = StreamKeys.sessionStateKey(tenantId, runId);
  const data = await redis.hgetall(key);

  if (Object.keys(data).length === 0) {
    return { ok: false, kind: 'missing' };
  }

  try {
    const parsed = deserializeFromHash(data);
    const state = SessionHotStateSchema.parse(parsed);
    return { ok: true, state };
  } catch (error) {
    await quarantineCorruptRunState(redis, tenantId, runId, data, error);
    return { ok: false, kind: 'corrupt', error };
  }
}

export async function isSessionCorrupt(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<boolean> {
  const key = StreamKeys.sessionCorruptMarkerKey(tenantId, runId);
  return (await redis.exists(key)) === 1;
}

/**
 * Quarantine corrupt run state: set marker, move raw data to quarantine key, delete active key.
 * Best-effort; if quarantine write fails, corrupt marker is still set.
 */
async function quarantineCorruptRunState(
  redis: Redis,
  tenantId: string,
  runId: string,
  rawData: Record<string, string>,
  parseError: unknown,
): Promise<void> {
  const corruptKey = StreamKeys.sessionCorruptMarkerKey(tenantId, runId);
  const stateKey = StreamKeys.sessionStateKey(tenantId, runId);
  const tsMs = Date.now();
  const quarantineKey = StreamKeys.sessionQuarantineKey(tenantId, runId, tsMs);

  const markerValue = JSON.stringify({
    tsMs,
    reason: 'schema_validation_failed',
    schema: 'SessionHotState',
    errorSummary: parseError instanceof Error ? parseError.message : String(parseError),
  });

  const pipeline = redis.pipeline();
  pipeline.setex(corruptKey, CORRUPT_MARKER_TTL_SECONDS, markerValue);
  pipeline.hset(quarantineKey, {
    ...rawData,
    _parseError: parseError instanceof Error ? parseError.message : String(parseError),
    _quarantinedAtMs: String(tsMs),
  });
  pipeline.del(stateKey);

  try {
    await pipeline.exec();
  } catch (err) {
    console.error('Quarantine pipeline failed, setting corrupt marker only:', err);
    try {
      await redis.setex(corruptKey, CORRUPT_MARKER_TTL_SECONDS, markerValue);
    } catch {
      // Best effort
    }
  }
}

/**
 * Read salvageable fields from the most-recent quarantined copy of a corrupt
 * run's hot state. Used by the orchestrator to convert a corrupt-quarantine
 * into a clean FAILED transition with a proper parent cascade — see
 * `failCorruptSessionAndCascade` in the orchestrator. Without this, a
 * corrupt session is a silent black hole: every step result destined for it
 * is dropped, parent stays WAITING_ON_CHILD forever, the user sees the
 * whole delegation chain wedge with no chat-visible error.
 *
 * Returns string-typed fields we can read directly from the raw hash (no
 * type coercion or schema parse). The caller uses these to rebuild a
 * minimal valid hot state in `'RUNNING'` status which `failRun` then
 * transitions to `FAILED` with proper event emission + parent cascade.
 *
 * Returns `null` when no quarantine copy exists for this run.
 */
export interface SalvagedCorruptFields {
  /**
   * Best-effort recovered target. Quarantine hashes flatten the tagged
   * target into 4 fields (target_kind / target_system_role / target_agent_id
   * / target_inline_def_ref). When salvage can reconstruct all required
   * fields for a kind, this is set; otherwise undefined and the caller
   * falls back to a placeholder.
   */
  target?:
    | { kind: 'platform-role'; systemRole: string }
    | { kind: 'custom-agent'; agentId: string }
    | { kind: 'inline-agent'; definitionRef: string };
  agentVersion?: string;
  parentSessionId?: string;
  parentStepExecutionId?: string;
  spaceId?: string;
  traceId?: string;
  createdBy?: string;
  /** When known — the parse error from the quarantine marker. */
  parseError?: string;
}

export async function salvageCorruptStateFields(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<SalvagedCorruptFields | null> {
  // Find the latest quarantine copy (key format includes tsMs suffix).
  const pattern = `aflow:session:${tenantId}:${runId}:state:corrupt:*`;
  const keys = await redis.keys(pattern);
  if (keys.length === 0) return null;
  // Sort by tsMs suffix descending — pick the most recent.
  keys.sort((a, b) => {
    const aTs = parseInt(a.split(':').pop() ?? '0', 10);
    const bTs = parseInt(b.split(':').pop() ?? '0', 10);
    return bTs - aTs;
  });
  const latestKey = keys[0]!;
  const raw = await redis.hgetall(latestKey);
  if (Object.keys(raw).length === 0) return null;

  const result: SalvagedCorruptFields = {};
  const targetKind = typeof raw['target_kind'] === 'string' ? raw['target_kind'] : undefined;
  if (targetKind === 'platform-role' && typeof raw['target_system_role'] === 'string') {
    result.target = { kind: 'platform-role', systemRole: raw['target_system_role'] };
  } else if (targetKind === 'custom-agent' && typeof raw['target_agent_id'] === 'string') {
    result.target = { kind: 'custom-agent', agentId: raw['target_agent_id'] };
  } else if (targetKind === 'inline-agent' && typeof raw['target_inline_def_ref'] === 'string') {
    result.target = { kind: 'inline-agent', definitionRef: raw['target_inline_def_ref'] };
  }
  if (typeof raw['agentVersion'] === 'string') result.agentVersion = raw['agentVersion'];
  if (typeof raw['parentSessionId'] === 'string') {
    result.parentSessionId = raw['parentSessionId'];
  }
  if (typeof raw['parentStepExecutionId'] === 'string') {
    result.parentStepExecutionId = raw['parentStepExecutionId'];
  }
  if (typeof raw['spaceId'] === 'string') result.spaceId = raw['spaceId'];
  if (typeof raw['traceId'] === 'string') result.traceId = raw['traceId'];
  if (typeof raw['createdBy'] === 'string') result.createdBy = raw['createdBy'];
  if (typeof raw['_parseError'] === 'string') result.parseError = raw['_parseError'];
  return result;
}

export async function clearQuarantineMark(
  redis: Redis,
  tenantId: string,
  runId: string,
  options?: { deleteQuarantined?: boolean },
): Promise<void> {
  const corruptKey = StreamKeys.sessionCorruptMarkerKey(tenantId, runId);
  await redis.del(corruptKey);

  if (options?.deleteQuarantined) {
    const pattern = `aflow:run:${tenantId}:${runId}:state:corrupt:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

export async function getSessionState(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<SessionHotState | null> {
  const result = await getSessionStateSafe(redis, tenantId, runId);
  if (result.ok) return result.state;
  return null;
}

export async function updateSessionState(
  redis: Redis,
  tenantId: string,
  runId: string,
  updates: Partial<SessionHotState>,
  recoveryEvents?: readonly RecoveryEventEnvelope[],
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<void> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  const { toSet, toDelete } = serializeForHashWithDeletes({
    ...updates,
    lastUpdatedAt: Date.now(),
  });

  const nowMs = Date.now();
  const pipeline = redis.pipeline();
  if (Object.keys(toSet).length > 0) {
    pipeline.hset(key, toSet);
  }
  if (toDelete.length > 0) {
    pipeline.hdel(key, ...toDelete);
  }
  pipeline.expire(key, ttlSeconds);
  syncQueuedSessionCandidate(pipeline, tenantId, runId, updates.status, updates.createdAt, nowMs);
  syncStepStallCandidateForSession(pipeline, tenantId, runId, updates.status);
  markProjectionCandidate(pipeline, sessionCandidateMember(tenantId, runId));
  syncDelegationSupervisionCandidate(pipeline, tenantId, runId, updates.status, nowMs);
  syncSessionMetadataCandidate(pipeline, tenantId, runId, updates.lastActivityAt, nowMs);
  if (recoveryEvents && recoveryEvents.length > 0) {
    appendRecoveryEventsToPipeline(pipeline, tenantId, runId, [...recoveryEvents], ttlSeconds);
  }
  await pipeline.exec();
}

/**
 * Atomic compare-and-set on the serialized `runtimeState` hash field: replace it
 * ONLY IF its current `version` still equals `expectedVersion`. Returns true if
 * written, false if a concurrent writer already advanced the version (the caller
 * must NOT blindly retry — the concurrent write is authoritative).
 *
 * `runtimeState` is stored as a single `JSON.stringify`'d hash field, so the
 * version check + write must be one atomic Redis op; `updateSessionState` is
 * last-write-wins and would clobber a concurrent legitimate mutation. Used by
 * the barrier sweep so a synthetic recovery can never overwrite a tool-result
 * decrement that landed in the read→write window (Plan 230 §5).
 */
const CAS_RUNTIME_STATE_LUA = `
local cur = redis.call('HGET', KEYS[1], 'runtimeState')
if not cur then return 0 end
local ok, obj = pcall(cjson.decode, cur)
if not ok then return 0 end
if tostring(obj.version) ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'runtimeState', ARGV[2], 'lastUpdatedAt', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

export async function casUpdateSessionRuntimeState(
  redis: Redis,
  tenantId: string,
  runId: string,
  expectedVersion: number,
  newRuntimeState: SessionHotState['runtimeState'],
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<boolean> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  const res = await redis.eval(
    CAS_RUNTIME_STATE_LUA,
    1,
    key,
    String(expectedVersion),
    JSON.stringify(newRuntimeState),
    String(Date.now()),
    String(ttlSeconds),
  );
  return res === 1;
}

/**
 * Read the current per-space SpaceContext generation. A missing key reads as 0
 * (never mutated, or reset by a Redis restart) — the same value a fresh cache
 * records, so an untouched space keeps reusing its cache. Best-effort: any read
 * failure returns 0, and the 1h context TTL remains the staleness backstop.
 */
export async function readSpaceContextGen(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<number> {
  try {
    const raw = await redis.get(StreamKeys.spaceContextGenKey(tenantId, spaceId));
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Bump the per-space SpaceContext generation after a space-visible mutation.
 * Every OTHER live run in the space reuses a cached context up to the 1h TTL;
 * this INCR lets those runs detect the mutation and rebuild on their next turn.
 *
 * Returns whether the generation actually moved. A failure is survivable — the
 * TTL still bounds the staleness — but it is not nothing, and a caller that
 * reports the invalidation to an operator needs to be able to tell the
 * difference. Swallowing it here left every such caller stating a bump that
 * never happened.
 */
export async function bumpSpaceContextGen(
  redis: Redis,
  tenantId: string,
  spaceId: string,
): Promise<boolean> {
  try {
    await redis.incr(StreamKeys.spaceContextGenKey(tenantId, spaceId));
    return true;
  } catch {
    return false;
  }
}
