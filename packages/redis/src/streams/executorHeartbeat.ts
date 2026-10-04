import type { Redis } from 'ioredis';
import { type StepType } from '@aflow/schemas';

// ============================================================================
// Executor Availability (Heartbeat Pattern)
// ============================================================================
//
// Per-consumer heartbeats: each executor instance has its own key so multiple
// consumers for the same step type do not overwrite each other. This enables

// 60s TTL with a 10s tick interval (see executor runtime) tolerates a
// single missed heartbeat without false-positive liveness loss. Critical
export const EXECUTOR_HEARTBEAT_TTL_SECONDS = 60;

/**
 * Build the per-consumer heartbeat key.
 * Key: aflow:executor-heartbeat:<stepType>:<consumerName>
 */
function executorConsumerHeartbeatKey(stepType: StepType, consumerName: string): string {
  return `aflow:executor-heartbeat:${stepType}:${consumerName}`;
}

/**
 * Build the heartbeat key prefix for a step type (for scanning).
 */
function executorHeartbeatPrefix(stepType: StepType): string {
  return `aflow:executor-heartbeat:${stepType}:`;
}

/**
 * Register executor consumer heartbeat. Call this periodically (e.g., every 10s).
 * Uses a per-consumer key so multiple consumers for the same step type do not
 * overwrite each other.
 */
export async function registerExecutorHeartbeat(
  redis: Redis,
  stepType: StepType,
  consumerName: string,
): Promise<void> {
  const key = executorConsumerHeartbeatKey(stepType, consumerName);
  await redis.setex(key, EXECUTOR_HEARTBEAT_TTL_SECONDS, `${consumerName}:${Date.now()}`);
}

/**
 * Unregister executor consumer heartbeat on shutdown.
 */
export async function unregisterExecutorHeartbeat(
  redis: Redis,
  stepType: StepType,
  consumerName: string,
): Promise<void> {
  const key = executorConsumerHeartbeatKey(stepType, consumerName);
  await redis.del(key);
}

/**
 * Check if a specific consumer is alive (heartbeat key exists).
 * Used by dead-consumer-aware reclaim to avoid stealing from slow-but-healthy consumers.
 */
export async function isExecutorConsumerAlive(
  redis: Redis,
  stepType: StepType,
  consumerName: string,
): Promise<boolean> {
  const key = executorConsumerHeartbeatKey(stepType, consumerName);
  const exists = await redis.exists(key);
  return exists === 1;
}

const executorsSeenSinceStart = new Set<StepType>();

/**
 * Check if any executor is available for a step type.
 * Scans for any heartbeat key with the step type prefix.
 */
export async function hasAvailableExecutor(redis: Redis, stepType: StepType): Promise<boolean> {
  const prefix = executorHeartbeatPrefix(stepType);
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) executorsSeenSinceStart.add(stepType);
  return keys.length > 0;
}

/**
 * Whether this process has found a heartbeat for `stepType` since it started.
 * Kept in the process rather than in Redis because a heartbeat outlives no
 * sleep, and a record the executor wrote would need its credential to reach a
 * key family beyond its heartbeat.
 */
export function executorSeenSinceStart(stepType: StepType): boolean {
  return executorsSeenSinceStart.has(stepType);
}

// ============================================================================
// Per-Step In-Flight Heartbeat
// ============================================================================
//
// Process-level executor heartbeats (above) only answer "is *some* executor for
// this step type alive". They cannot distinguish "actively running THIS step"
// from "process exists but this step's result is irrecoverably lost". The
// per-step in-flight key closes that gap: the executor refreshes it for the
// duration it owns a step, so the stall watchdog can tell a slow-but-healthy op
// from a disappeared executor. The key also carries the executor's own deadline
// (startedAt + effective timeout) so the watchdog's backstop reaps a wedged
// "zombie" executor at its real operation cap rather than a flat clock.

// TTL must exceed the executor's refresh interval (STEP_HEARTBEAT_INTERVAL_MS in
// @aflow/executor-runtime) with enough headroom to tolerate a missed beat
// without a false-positive liveness loss.
const STEP_INFLIGHT_HEARTBEAT_TTL_SECONDS = 90;

function stepInFlightKey(stepExecutionId: string): string {
  return `aflow:step-inflight:${stepExecutionId}`;
}

export interface StepInFlightStatus {
  alive: boolean;
  /** Epoch ms after which the executor's own timeout should have fired; null when not yet known. */
  deadlineAtMs: number | null;
}

/**
 * Register/refresh the per-step in-flight heartbeat. Call when a step is picked
 * up and periodically while it runs. `deadlineAtMs` is the executor's own
 * effective deadline (null until the timeout is resolved).
 */
export async function registerStepInFlight(
  redis: Redis,
  stepExecutionId: string,
  deadlineAtMs: number | null,
): Promise<void> {
  const key = stepInFlightKey(stepExecutionId);
  await redis.setex(key, STEP_INFLIGHT_HEARTBEAT_TTL_SECONDS, JSON.stringify({ deadlineAtMs }));
}

/**
 * Extend the lifetime of whatever in-flight record the step holds without
 * writing it: the deadline another executor recorded survives, and a record
 * already cleared stays cleared.
 */
export async function extendStepInFlight(redis: Redis, stepExecutionId: string): Promise<void> {
  await redis.expire(stepInFlightKey(stepExecutionId), STEP_INFLIGHT_HEARTBEAT_TTL_SECONDS);
}

/** Clear the per-step in-flight heartbeat. Idempotent. */
export async function clearStepInFlight(redis: Redis, stepExecutionId: string): Promise<void> {
  await redis.del(stepInFlightKey(stepExecutionId));
}

/**
 * Read the per-step in-flight status. `alive: false` means the executor that
 * owned this step has gone silent (key expired) — its result is lost.
 */
export async function getStepInFlight(
  redis: Redis,
  stepExecutionId: string,
): Promise<StepInFlightStatus> {
  const raw = await redis.get(stepInFlightKey(stepExecutionId));
  if (raw === null) return { alive: false, deadlineAtMs: null };
  try {
    const parsed = JSON.parse(raw) as { deadlineAtMs?: number | null };
    const deadlineAtMs = typeof parsed.deadlineAtMs === 'number' ? parsed.deadlineAtMs : null;
    return { alive: true, deadlineAtMs };
  } catch {
    return { alive: true, deadlineAtMs: null };
  }
}
