import type { Redis } from 'ioredis';
import { StreamKeys, type StepType } from '@aflow/schemas';
import { INSTANCE_LEASE_TTL_MS, listLiveOrchestrators } from './orchestratorHeartbeat.js';
// ============================================================================
// Engine Health (combined liveness check for UI/API)
// ============================================================================

export interface QueueStats {
  streamLen: number;
  pending: number;
  lag: number | null;
}

export interface EngineHealthStatus {
  orchestrator: {
    alive: boolean;
    lastHeartbeat: string | null;
    heartbeatAgeMs: number | null;
  };
  executors: Record<
    string,
    {
      alive: boolean;
      lastHeartbeat: string | null;
      heartbeatAgeMs: number | null;
    }
  >;
  queues: Record<string, QueueStats>;
}

/**
 * Get the engine health status: orchestrator and executor heartbeat ages.
 */
export async function getEngineHealth(redis: Redis): Promise<EngineHealthStatus> {
  const now = Date.now();

  // Fleet liveness, rather than a single shared key that one instance's
  // shutdown could clear. The reported age is the freshest instance's, since the
  // question is whether the fleet is healthy — the member list is score-ascending,
  // so that is the last one.
  const liveInstances = await listLiveOrchestrators(redis);
  const orchAlive = liveInstances.length > 0;
  let orchTs: string | null = null;
  let orchAgeMs: number | null = null;
  const freshest = liveInstances[liveInstances.length - 1];
  if (freshest !== undefined) {
    const score = await redis.zscore(StreamKeys.orchestratorLivenessKey, freshest);
    const expiresAt = score !== null ? Number(score) : null;
    if (expiresAt !== null && Number.isFinite(expiresAt)) {
      const lastBeat = expiresAt - INSTANCE_LEASE_TTL_MS;
      orchTs = new Date(lastBeat).toISOString();
      orchAgeMs = Math.max(0, now - lastBeat);
    }
  }

  // Executor heartbeats (scan for all executor heartbeat keys)
  // Key format: aflow:executor-heartbeat:<stepType>:<consumerName>
  const executors: EngineHealthStatus['executors'] = {};
  const keys = await redis.keys('aflow:executor-heartbeat:*');
  for (const key of keys) {
    const suffix = key.replace('aflow:executor-heartbeat:', '');
    const colonIdx = suffix.indexOf(':');
    const stepType = colonIdx >= 0 ? suffix.slice(0, colonIdx) : suffix;
    const value = await redis.get(key);
    if (value) {
      const parts = value.split(':');
      const tsStr = parts[parts.length - 1] ?? '';
      const ts = parseInt(tsStr, 10);
      // Keep most recent heartbeat per step type
      const existing = executors[stepType];
      const ageMs = !isNaN(ts) ? now - ts : null;
      if (
        !existing ||
        (ageMs !== null && (existing.heartbeatAgeMs === null || ageMs < existing.heartbeatAgeMs))
      ) {
        executors[stepType] = {
          alive: true,
          lastHeartbeat: !isNaN(ts) ? new Date(ts).toISOString() : null,
          heartbeatAgeMs: ageMs,
        };
      }
    } else if (!(stepType in executors)) {
      executors[stepType] = {
        alive: false,
        lastHeartbeat: null,
        heartbeatAgeMs: null,
      };
    }
  }

  // Queue stats per step type — use known step types from heartbeats plus
  // any job streams that exist.  Avoid expensive KEYS scan by probing
  // known step types derived from the heartbeat keys we already discovered.
  const KNOWN_JOB_STEP_TYPES = ['ai', 'memory', 'api', 'user', 'mock'];
  const seenStepTypes = new Set([...Object.keys(executors), ...KNOWN_JOB_STEP_TYPES]);

  const queues: Record<string, QueueStats> = {};
  for (const st of seenStepTypes) {
    const streamKey = StreamKeys.jobStream(st);
    try {
      const streamLen = await redis.xlen(streamKey);
      let pending = 0;
      let lag: number | null = null;

      if (streamLen > 0) {
        try {
          const groups = (await redis.xinfo('GROUPS', streamKey)) as Array<Array<string | number>>;
          for (const group of groups) {
            // XINFO GROUPS returns flat arrays: [field, value, field, value, ...]
            const flat = group;
            for (let i = 0; i < flat.length - 1; i += 2) {
              if (flat[i] === 'pending') pending += Number(flat[i + 1] ?? 0);
              if (flat[i] === 'lag') {
                const l = Number(flat[i + 1] ?? 0);
                lag = (lag ?? 0) + l;
              }
            }
          }
        } catch {
          // Group may not exist yet — that's fine
        }
      }

      if (streamLen > 0 || pending > 0) {
        queues[st] = { streamLen, pending, lag };
      }
    } catch {
      // Stream may not exist — skip
    }
  }

  return {
    orchestrator: {
      alive: orchAlive,
      lastHeartbeat: orchTs,
      heartbeatAgeMs: orchAgeMs,
    },
    executors,
    queues,
  };
}

/**
 * Error thrown when no executor is available for a step type.
 */
export class NoExecutorAvailableError extends Error {
  readonly stepType: StepType;

  constructor(stepType: StepType) {
    super(
      `No executor available for step type: ${stepType}. Ensure the ${stepType} executor is running.`,
    );
    this.name = 'NoExecutorAvailableError';
    this.stepType = stepType;
  }
}
