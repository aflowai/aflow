import type { Redis } from 'ioredis';
import {
  StreamKeys,
  type AflowError,
  type ErrorClassification,
  type StepType,
} from '@aflow/schemas';
import { getOrchestratorHealth, type OrchestratorHealth } from './orchestratorHeartbeat.js';
// ============================================================================
// Engine Health (combined liveness check for UI/API)
// ============================================================================

export interface QueueStats {
  streamLen: number;
  pending: number;
  lag: number | null;
}

export interface EngineHealthStatus {
  orchestrator: OrchestratorHealth;
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

  const orchestrator = await getOrchestratorHealth(redis);

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
    orchestrator,
    executors,
    queues,
  };
}

export const EXECUTOR_UNAVAILABLE_CODE = 'EXECUTOR_UNAVAILABLE';

/**
 * The host and browser lanes run on the operator's own machine, outside the
 * appliance, so their executor is off whenever that machine sleeps or they
 * have not started it — and only they can start it, so the message says how.
 */
function missingExecutorMessage(stepType: StepType): string {
  if (stepType === 'host') {
    return (
      'No host executor is connected. This lane runs on the operator machine rather than in ' +
      'the appliance, so folders are reachable only while it runs there — ' +
      '`yarn workspace @aflow/aflow-executor-host start` on that machine.'
    );
  }
  if (stepType === 'browser') {
    return (
      'No browser is connected. The browser runs on the operator machine through its host ' +
      'executor rather than in the appliance, so pages open only while it runs there — ' +
      '`yarn workspace @aflow/aflow-executor-host start` on that machine.'
    );
  }
  return `No executor available for step type: ${stepType}. Ensure the ${stepType} executor is running.`;
}

/**
 * No executor for a step type has a live heartbeat. An `AflowError` in its own
 * right, so a log or a result that carries it says what it is: an executor that
 * is away — asleep, restarting, not yet ticked — is transient, and the work
 * waits for it before it fails. A wait that ends without this orchestrator ever
 * having seen one reclassifies it as `configuration`: that executor was never
 * started, and no retry starts it.
 */
export class NoExecutorAvailableError extends Error {
  readonly stepType: StepType;
  readonly code = EXECUTOR_UNAVAILABLE_CODE;
  readonly classification = 'transient' satisfies ErrorClassification;
  readonly retryable = true;
  readonly timestamp: string;

  constructor(stepType: StepType) {
    super(missingExecutorMessage(stepType));
    this.name = 'NoExecutorAvailableError';
    this.stepType = stepType;
    this.timestamp = new Date().toISOString();
  }

  toAflowError(): AflowError {
    return {
      code: this.code,
      message: this.message,
      classification: this.classification,
      retryable: this.retryable,
      timestamp: this.timestamp,
    };
  }
}
