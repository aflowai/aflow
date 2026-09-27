import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type {
  AgentConditionDerivationPolicy,
  AgentConditionTraceMetrics,
  BlockerKind,
  EntityEventEnvelope,
  RunnerReflection,
} from '@aflow/schemas';
import {
  buildAgentCondition,
  DirectiveLearningPolicySchema,
  RunnerReflectionSchema,
} from '@aflow/schemas';
import { appendEntityEvent, readSessionEvents } from '@aflow/redis';
import { setTaskReflection } from './ledger/tasks.js';
import { loadSpaceDirectives } from './modelResolution.js';

// ============================================================================
// Completeness markers (Redis)
// ============================================================================

/**
 * Marker TTL — housekeeping retention, mirrors the 24h hot-state TTL. The
 * markers only matter between task completion and the run's finalize barrier
 * (seconds apart); anything older falls back to `'none'` + the DB rows.
 */
export const REFLECTION_MARKER_TTL_SECONDS = 24 * 60 * 60;

function reflectionMarkerKey(
  tenantId: string,
  runId: string,
  kind: 'expected' | 'captured' | 'snapshot',
): string {
  return `cybernetic:reflections:${tenantId}:${runId}:${kind}`;
}

/**
 * Record that a reflection capture is in flight for this run. Called
 * SYNCHRONOUSLY (one INCR, failure-isolated by the caller) before the task's
 * completion result is emitted, so the finalize barrier knows how many
 * captures to wait for.
 */
export async function markReflectionExpected(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const key = reflectionMarkerKey(tenantId, runId, 'expected');
  await redis.incr(key);
  await redis.expire(key, REFLECTION_MARKER_TTL_SECONDS);
}

/** Record that an async capture fully landed (entity event + DB persist). */
export async function recordReflectionCaptured(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const key = reflectionMarkerKey(tenantId, runId, 'captured');
  await redis.incr(key);
  await redis.expire(key, REFLECTION_MARKER_TTL_SECONDS);
}

export interface ReflectionCompletenessCounts {
  expected: number;
  captured: number;
}

export async function readReflectionCompleteness(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<ReflectionCompletenessCounts> {
  const [expected, captured] = await Promise.all([
    redis.get(reflectionMarkerKey(tenantId, runId, 'expected')),
    redis.get(reflectionMarkerKey(tenantId, runId, 'captured')),
  ]);
  return {
    expected: expected ? Number.parseInt(expected, 10) || 0 : 0,
    captured: captured ? Number.parseInt(captured, 10) || 0 : 0,
  };
}

// ============================================================================
// Finalize barrier + evidence-snapshot identity
// ============================================================================

/** The `reflectionCompleteness` half of the evidence-snapshot identity. */
export type ReflectionCompleteness = 'complete' | 'partial' | 'none';

const REFLECTION_COMPLETENESS_VALUES: ReadonlySet<string> = new Set([
  'complete',
  'partial',
  'none',
]);

export interface ReflectionBarrierKnobs {
  /** `learningPolicy.reflectionCapture.barrierTimeoutMs`. */
  barrierTimeoutMs: number;
  /** `learningPolicy.reflectionCapture.barrierPollMs`. */
  barrierPollMs: number;
}

/**
 * The bounded finalize-barrier. Waits for the completeness marker
 * (`captured >= expected`) or the timeout knob, then records the snapshot —
 * exactly once per run. A second resolve for the same `runId` returns the
 * recorded completeness WITHOUT waiting or re-deciding, so the activation
 * decision keyed on `{ runId, reflectionCompleteness }` is idempotent across
 * redeliveries even when a late reflection landed in between.
 */
export async function resolveReflectionEvidenceSnapshot(
  redis: Redis,
  params: { tenantId: string; runId: string } & ReflectionBarrierKnobs,
): Promise<ReflectionCompleteness> {
  const { tenantId, runId } = params;
  const snapshotKey = reflectionMarkerKey(tenantId, runId, 'snapshot');

  const recorded = await redis.get(snapshotKey);
  if (recorded !== null && REFLECTION_COMPLETENESS_VALUES.has(recorded)) {
    return recorded as ReflectionCompleteness;
  }

  const deadline = Date.now() + params.barrierTimeoutMs;
  let completeness: ReflectionCompleteness;
  // `expected` is final by barrier time (it is marked before each task's
  // completion result is emitted, and the run only finalizes after every
  // task completed) — so an `expected === 0` read means no capture will
  // ever come for this run and the barrier returns immediately.
  for (;;) {
    const counts = await readReflectionCompleteness(redis, tenantId, runId);
    if (counts.expected === 0) {
      completeness = 'none';
      break;
    }
    if (counts.captured >= counts.expected) {
      completeness = 'complete';
      break;
    }
    if (Date.now() >= deadline) {
      completeness = counts.captured > 0 ? 'partial' : 'none';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, params.barrierPollMs));
  }

  const setResult = await redis.set(
    snapshotKey,
    completeness,
    'EX',
    REFLECTION_MARKER_TTL_SECONDS,
    'NX',
  );
  if (setResult === null) {
    // A concurrent resolve won the SETNX — honor its snapshot.
    const winner = await redis.get(snapshotKey);
    if (winner !== null && REFLECTION_COMPLETENESS_VALUES.has(winner)) {
      return winner as ReflectionCompleteness;
    }
  }
  return completeness;
}

// ============================================================================
// Trace-metric derivation from session events
// ============================================================================

// Bounded-scan caps (housekeeping, not decision thresholds — mirrors the
// OBSERVATIONS_MAX_SCANNED precedent in facts/compileFacts.ts).
const SESSION_EVENT_SCAN_PAGE_SIZE = 500;
const SESSION_EVENT_MAX_SCANNED = 5_000;

/**
 * Derive the 183d trace metrics from the Runner session's event stream:
 * `stepCount` = StepScheduled events (every tool call is a step),
 * `failedStepCount` = StepFailed events. Bounded scan; on overrun the counts
 * are a floor — fine for bucketing.
 */
export async function deriveSessionTraceMetrics(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<AgentConditionTraceMetrics> {
  let stepCount = 0;
  let failedStepCount = 0;
  let cursor = '0';
  let scanned = 0;
  while (scanned < SESSION_EVENT_MAX_SCANNED) {
    const { events, lastId } = await readSessionEvents(
      redis,
      tenantId,
      sessionId,
      cursor,
      SESSION_EVENT_SCAN_PAGE_SIZE,
    );
    if (events.length === 0 || lastId === cursor) break;
    scanned += events.length;
    for (const event of events) {
      if (event.eventType === 'StepScheduled') stepCount += 1;
      else if (event.eventType === 'StepFailed') failedStepCount += 1;
    }
    cursor = lastId;
  }
  return { stepCount, failedStepCount };
}

// ============================================================================
// Capture
// ============================================================================

export interface CaptureRunnerReflectionParams {
  db: PostgresJsDatabase;
  redis: Redis;
  tenantId: string;
  spaceId: string;
  /** The Runner session that produced the terminal. */
  runnerSessionId: string;
  /** The workflow-task correlation from the Runner's session hot state. */
  workflowExecution: { runId: string; taskId: string; attempt: number };
  workflowSlug?: string;
  source: 'submit_output' | 'signal_blocked';
  /** The block descriptor — present iff `source === 'signal_blocked'`. */
  blocked?: { category: BlockerKind; reason: string; needed?: string };
  /**
   * Test seam: derivation knobs override. Production callers omit it — the
   * capture reads `learningPolicy.agentCondition` from the space directives.
   */
  derivationPolicyOverride?: AgentConditionDerivationPolicy;
}

/**
 * The async capture body. Runs OFF the completion path (fire-and-forget at
 * the call site, errors logged, never rethrown into the handler): derives
 * trace metrics, builds the reflection, emits `entity.runner.reflection`,
 * persists `reflectionJson`, records the captured marker — in that order, so
 * `captured` implies both the event and the DB row exist.
 */
export async function captureRunnerReflectionForSession(
  params: CaptureRunnerReflectionParams,
): Promise<RunnerReflection> {
  const { db, redis, tenantId, spaceId, workflowExecution } = params;
  const { runId, taskId, attempt } = workflowExecution;

  let policy = params.derivationPolicyOverride;
  if (!policy) {
    try {
      const directives = await loadSpaceDirectives(db, tenantId, spaceId);
      policy = directives?.learningPolicy.agentCondition;
    } catch {
      // Fall through to schema-default knobs below.
    }
  }
  // Derived (not mirrored) schema defaults for spaces without directives.
  policy = policy ?? DirectiveLearningPolicySchema.parse({}).agentCondition;

  const trace = await deriveSessionTraceMetrics(redis, tenantId, params.runnerSessionId);

  const reflection: RunnerReflection = RunnerReflectionSchema.parse({
    taskId,
    runId,
    source: params.source,
    condition: buildAgentCondition(trace, policy),
    ...(params.blocked ? blockedReflectionFields(params.blocked) : {}),
    emittedAt: new Date().toISOString(),
  });

  await appendEntityEvent(redis, {
    tenantId,
    spaceId,
    event: {
      eventId: randomUUID(),
      eventType: 'entity.runner.reflection',
      spaceId,
      tenantId,
      timestamp: Date.now(),
      causedBySessionId: params.runnerSessionId,
      ...(params.workflowSlug ? { workflowSlug: params.workflowSlug } : {}),
      workflowRunId: runId,
      operatingMode: 'procedural',
      payload: { reflection, taskId, attempt, source: params.source },
      summary:
        params.source === 'submit_output'
          ? `Runner reflection for ${taskId}: ${reflection.condition?.disposition ?? 'captured'}`
          : `Runner blocked on ${taskId}: ${params.blocked?.category ?? 'other'}`,
    },
  });

  await setTaskReflection(db, tenantId, { runId, taskId, attempt, reflection });
  await recordReflectionCaptured(redis, tenantId, runId);
  return reflection;
}

function blockedReflectionFields(blocked: {
  category: BlockerKind;
  reason: string;
  needed?: string;
}): Partial<RunnerReflection> {
  const needed = blocked.needed?.trim();
  return {
    blockers: [{ kind: blocked.category, detail: blocked.reason.slice(0, 500) }],
    ...(needed && (blocked.category === 'missing_input' || blocked.category === 'data_unavailable')
      ? { missingInputs: [needed.slice(0, 200)] }
      : {}),
    ...(needed && blocked.category === 'capability_unavailable'
      ? { missingTools: [needed.slice(0, 128)] }
      : {}),
  };
}

// ============================================================================

/**
 * Re-derive a run's reflections from its entity-event stream. Pure: given
 * the same events, returns the same reflections — the activation decision
 * built on them is therefore reproducible in a deterministic test.
 */
export function reflectionsFromEntityEvents(
  events: readonly EntityEventEnvelope[],
  runId: string,
): RunnerReflection[] {
  const reflections: RunnerReflection[] = [];
  for (const event of events) {
    if (event.eventType !== 'entity.runner.reflection') continue;
    if (event.workflowRunId !== runId) continue;
    const parsed = RunnerReflectionSchema.safeParse(event.payload['reflection']);
    if (parsed.success) reflections.push(parsed.data);
  }
  return reflections;
}
