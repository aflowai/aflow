import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { createTenantContext, spaces, withTenantSchema, workflowRuns } from '@aflow/database';
import {
  BenchmarkAttemptResultSchema,
  BenchmarkMeasurementSpaceMarkerSchema,
  BenchmarkRunMarkerSchema,
  type BenchmarkArm,
  type BenchmarkAttemptResult,
  type BenchmarkMeasurementSpaceMarker,
  type BenchmarkRunMarker,
  type TenantId,
} from '@aflow/schemas';

import { completeRun, recordRunStart } from './ledger/runs.js';
import {
  writeRunEvaluationEnvelope,
  type RunEvaluationEnvelopeWrite,
} from './runEvaluationEnvelope.js';

/** The `spaces.metadata` key that marks the measurement space (Plan 341 D5). */
export const BENCHMARK_SPACE_METADATA_KEY = 'benchmarkMeasurement';
/** The `workflow_runs.metadata` key that marks a benchmark task attempt (Plan 341 D6). */
export const BENCHMARK_RUN_METADATA_KEY = 'benchmarkAttempt';
/** The workflow slug of a run the runner creates for the bare-harness arm. */
export const BARE_HARNESS_WORKFLOW_SLUG = 'swe-bench-pro-bare-harness';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The named run or space is not where a benchmark attempt may be recorded. */
export class BenchmarkTargetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkTargetRefusedError';
  }
}

/**
 * The envelope write one benchmark attempt makes. The verdict is the official
 * harness's alone (Plan 341 D2), and it lands in the benchmark slot only, so
 * it never replaces a production suite's `summary` on the same run.
 */
export function benchmarkEvaluationWrite(
  attempt: BenchmarkAttemptResult,
): RunEvaluationEnvelopeWrite {
  const parsed = BenchmarkAttemptResultSchema.parse(attempt);
  if (parsed.passed !== (parsed.failureClass === null)) {
    throw new Error(
      `A benchmark attempt names a failure class exactly when it did not pass. ${parsed.instanceId} has passed=${String(parsed.passed)} and failureClass=${String(parsed.failureClass)}.`,
    );
  }
  return { kind: 'benchmark', benchmark: parsed };
}

function requireSpaceUuid(spaceId: string): void {
  if (!UUID.test(spaceId)) {
    throw new BenchmarkTargetRefusedError(`The space id ${spaceId} is not a UUID.`);
  }
}

async function readMeasurementSpace(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<BenchmarkMeasurementSpaceMarker> {
  const rows = await tx
    .select({ metadata: spaces.metadata, archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new BenchmarkTargetRefusedError(`Space ${spaceId} is not in this tenant.`);
  if (row.archivedAt !== null) {
    throw new BenchmarkTargetRefusedError(`Space ${spaceId} is archived.`);
  }
  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null
      ? (row.metadata as Record<string, unknown>)
      : {};
  const marker = BenchmarkMeasurementSpaceMarkerSchema.safeParse(
    metadata[BENCHMARK_SPACE_METADATA_KEY],
  );
  if (!marker.success) {
    throw new BenchmarkTargetRefusedError(
      `Space ${spaceId} is not a measurement space. Mark it with the \`designate\` command first.`,
    );
  }
  return marker.data;
}

/**
 * Mark a space as the measurement space, the one place benchmark attempts are
 * recorded (Plan 341 D5). An operator names the space. Nothing defaults it.
 */
export async function designateMeasurementSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string },
): Promise<void> {
  requireSpaceUuid(params.spaceId);
  const marker: BenchmarkMeasurementSpaceMarker = { benchmark: 'swe-bench-pro' };
  await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) => {
    const updated = await tx
      .update(spaces)
      .set({
        metadata: sql`coalesce(${spaces.metadata}, '{}'::jsonb) || ${JSON.stringify({
          [BENCHMARK_SPACE_METADATA_KEY]: marker,
        })}::jsonb`,
      })
      .where(eq(spaces.id, params.spaceId))
      .returning({ id: spaces.id });
    if (updated.length === 0) {
      throw new BenchmarkTargetRefusedError(`Space ${params.spaceId} is not in this tenant.`);
    }
  });
}

/** Refuse a space that is not the measurement space, before any attempt starts. */
export async function assertMeasurementSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { spaceId: string },
): Promise<void> {
  requireSpaceUuid(params.spaceId);
  await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) => {
    await readMeasurementSpace(tx, params.spaceId);
  });
}

/**
 * Refuse a run that is not a benchmark run in the named measurement space.
 * The run must sit in that space and be no eval-batch trial. A run carrying
 * the benchmark marker must name this task and arm. A run without one is a
 * loop arm's run, because the runner marks every bare-harness run it creates.
 */
export async function assertBenchmarkRun(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; spaceId: string; instanceId: string; arm: BenchmarkArm },
): Promise<void> {
  requireSpaceUuid(params.spaceId);
  await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) => {
    const rows = await tx
      .select({
        spaceId: workflowRuns.spaceId,
        evalBatchId: workflowRuns.evalBatchId,
        metadata: workflowRuns.metadata,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, params.runId))
      .limit(1);
    const run = rows[0];
    if (!run) throw new BenchmarkTargetRefusedError(`Run ${params.runId} is not in this tenant.`);
    if (run.spaceId !== params.spaceId) {
      throw new BenchmarkTargetRefusedError(
        `Run ${params.runId} is in space ${run.spaceId}, not in the measurement space ${params.spaceId}.`,
      );
    }
    if (run.evalBatchId !== null) {
      throw new BenchmarkTargetRefusedError(
        `Run ${params.runId} is an eval-batch trial, not a benchmark attempt.`,
      );
    }
    await readMeasurementSpace(tx, params.spaceId);
    const metadata =
      typeof run.metadata === 'object' && run.metadata !== null
        ? (run.metadata as Record<string, unknown>)
        : {};
    const raw = metadata[BENCHMARK_RUN_METADATA_KEY];
    if (raw === undefined) {
      if (params.arm === 'bare_harness') {
        throw new BenchmarkTargetRefusedError(
          `Run ${params.runId} carries no benchmark marker, so it is no bare-harness run the runner created.`,
        );
      }
      return;
    }
    const marker = BenchmarkRunMarkerSchema.safeParse(raw);
    if (
      !marker.success ||
      marker.data.instanceId !== params.instanceId ||
      marker.data.arm !== params.arm
    ) {
      throw new BenchmarkTargetRefusedError(
        `Run ${params.runId} is marked as another attempt than the ${params.arm} attempt at ${params.instanceId}.`,
      );
    }
  });
}

/**
 * Plan 341 D6 — create the workflow run for one bare-harness attempt, in the
 * measurement space, once the attempt has ended. The run is written terminal
 * at once, because no orchestrator drives it and a running run with no driver
 * would be read as stalled. No post-run hook fires for it either, so it
 * records its Plan 269 decision here. No suite evaluates a bare-harness run,
 * so that decision is `no_suite`.
 */
export async function createBareHarnessRun(
  db: PostgresJsDatabase,
  tenantId: string,
  params: {
    spaceId: string;
    attempt: BenchmarkAttemptResult;
    startedAt: Date;
    completedAt: Date;
  },
): Promise<{ runId: string }> {
  const attempt = BenchmarkAttemptResultSchema.parse(params.attempt);
  if (attempt.arm !== 'bare_harness') {
    throw new Error(`The runner creates runs for the bare-harness arm only, not ${attempt.arm}.`);
  }
  await assertMeasurementSpace(db, tenantId, { spaceId: params.spaceId });
  const runId = randomUUID();
  const marker: BenchmarkRunMarker = {
    benchmark: attempt.benchmark,
    instanceId: attempt.instanceId,
    arm: attempt.arm,
  };
  await recordRunStart(db, tenantId, {
    spaceId: params.spaceId,
    workflowSlug: BARE_HARNESS_WORKFLOW_SLUG,
    runId,
    workflowRevision: 1,
    startedAt: params.startedAt,
    metadata: { [BENCHMARK_RUN_METADATA_KEY]: marker },
  });
  const agentEnded =
    attempt.failureClass === 'agent_failed' ||
    attempt.failureClass === 'agent_timeout' ||
    attempt.failureClass === 'materialize_failed';
  const totals = {
    ...(attempt.tokens !== null ? { totalTokens: attempt.tokens } : {}),
    ...(attempt.costUsd !== null ? { totalCostCents: Math.round(attempt.costUsd * 100) } : {}),
  };
  await completeRun(
    db,
    tenantId,
    agentEnded
      ? {
          runId,
          completedAt: params.completedAt,
          status: 'failed',
          failure: {
            reason: `benchmark_${String(attempt.failureClass)}`,
            message: attempt.detail ?? `The attempt ended as ${String(attempt.failureClass)}.`,
          },
          ...totals,
        }
      : { runId, completedAt: params.completedAt, status: 'completed', ...totals },
  );
  await writeRunEvaluationEnvelope(db, tenantId, {
    runId,
    write: { kind: 'decision', decision: 'no_suite' },
  });
  return { runId };
}

/**
 * Plan 341 D6 — record one benchmark attempt on its workflow run, through the
 * one evaluation writer. The run is confirmed a benchmark run in the named
 * measurement space before anything is written, so a mistyped run id cannot
 * reach a production run.
 */
export async function writeBenchmarkAttemptEvaluation(
  db: PostgresJsDatabase,
  tenantId: string,
  params: { runId: string; spaceId: string; attempt: BenchmarkAttemptResult },
): Promise<{ written: boolean; storedBenchmark?: BenchmarkAttemptResult }> {
  const write = benchmarkEvaluationWrite(params.attempt);
  await assertBenchmarkRun(db, tenantId, {
    runId: params.runId,
    spaceId: params.spaceId,
    instanceId: params.attempt.instanceId,
    arm: params.attempt.arm,
  });
  return writeRunEvaluationEnvelope(db, tenantId, { runId: params.runId, write });
}
