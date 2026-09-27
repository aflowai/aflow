/**
 * The durable half of a run's pinned simulation context.
 *
 * The hot copy lives on the session hash and expires with it. Everything the
 * pin exists to hold still outlives that: the journal is durable, freeze folds
 * it onto the version the run read, and the inspector reconstructs a decision
 * from both. A run whose pin aged out while its journal survived would re-pin
 * to the current artifact and the current latest baseline, and the fold would
 * then apply its deltas to a world the agent never saw — so the pin is written
 * here first, and read from here whenever the hot copy is gone.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { SimulationRunContextSchema, SimulationRunInputSchema } from '@aflow/schemas';
import type { SimulationRunContext, SimulationRunInput, TenantId } from '@aflow/schemas';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { simulationRunContexts } from '../schema/tenant/simulations.js';
import { workflowRuns } from '../schema/tenant/workflows.js';

export interface SimulationRunContextKey {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  runId: string;
  simulationId: string;
}

/**
 * A row whose stored context no longer validates names an artifact nobody can
 * answer from, and re-minting one is the corruption this table prevents, so the
 * caller is told the pin is broken rather than handed a fresh world.
 */
export class SimulationRunContextUnreadableError extends Error {
  constructor(
    readonly runId: string,
    readonly simulationId: string,
    readonly detail: string,
  ) {
    super(
      `Run ${runId} holds a durable pin for simulation "${simulationId}" that no longer reads as a run context: ${detail}`,
    );
    this.name = 'SimulationRunContextUnreadableError';
  }
}

function parseRow(
  key: Pick<SimulationRunContextKey, 'runId' | 'simulationId'>,
  contextJson: unknown,
): SimulationRunContext {
  const parsed = SimulationRunContextSchema.safeParse(contextJson);
  if (!parsed.success) {
    throw new SimulationRunContextUnreadableError(
      key.runId,
      key.simulationId,
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** What this run is pinned to for one simulation, or null if it never pinned. */
export async function readSimulationRunContext(
  key: SimulationRunContextKey,
): Promise<SimulationRunContext | null> {
  const tenantContext = createTenantContext(key.tenantId);
  const rows = await withTenantSchema(key.db, tenantContext, async (tx) =>
    tx
      .select({ contextJson: simulationRunContexts.contextJson })
      .from(simulationRunContexts)
      .where(
        and(
          eq(simulationRunContexts.spaceId, key.spaceId),
          eq(simulationRunContexts.runId, key.runId),
          eq(simulationRunContexts.simulationId, key.simulationId),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  return row === undefined ? null : parseRow(key, row.contextJson);
}

/**
 * Pin a run's world for one simulation, and return whatever it is pinned to.
 *
 * The conflict arm rewrites the row with its own value rather than the
 * proposed one, which is how the statement itself carries the pin-once rule:
 * one agent turn can dispatch several calls against a simulation at once, and
 * expressing "the first pin wins" anywhere but in the write would let the last
 * of them re-seed the world the first already answered from. Every caller
 * takes the returned context, never the one it passed in.
 */
export async function pinDurableSimulationRunContext(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  runId: string;
  context: SimulationRunContext;
}): Promise<SimulationRunContext> {
  const tenantContext = createTenantContext(params.tenantId);
  const rows = await withTenantSchema(params.db, tenantContext, async (tx) =>
    tx
      .insert(simulationRunContexts)
      .values({
        spaceId: params.spaceId,
        runId: params.runId,
        simulationId: params.context.simulationId,
        contextJson: params.context,
        snapshotRef: params.context.snapshotRef,
      })
      .onConflictDoUpdate({
        target: [
          simulationRunContexts.spaceId,
          simulationRunContexts.runId,
          simulationRunContexts.simulationId,
        ],
        set: { contextJson: sql`${simulationRunContexts.contextJson}` },
      })
      .returning({ contextJson: simulationRunContexts.contextJson }),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `Pinning simulation "${params.context.simulationId}" for run ${params.runId} returned no row.`,
    );
  }
  return parseRow(
    { runId: params.runId, simulationId: params.context.simulationId },
    row.contextJson,
  );
}

/** A run whose stored pins cannot be read. Never the same as a run with none. */
export class SimulationRunInputUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationRunInputUnreadable';
  }
}

/**
 * What the run was STARTED with, from the durable run row.
 *
 * The hot-state copy is written into a session's create literal, so it exists
 * only for runs that pass through `start_run`. An OPERATION task is dispatched
 * straight to an executor job stream and never does — its only record of the
 * run's pins is this one. Read on the mint alone, behind two cache misses, so a
 * pinned run pays nothing for it.
 */
export async function readDurableSimulationRunInput(key: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  runId: string;
}): Promise<SimulationRunInput | null> {
  const tenantContext = createTenantContext(key.tenantId);
  const rows = await withTenantSchema(key.db, tenantContext, async (tx) =>
    tx
      .select({ pins: workflowRuns.simulationRunInputJson })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.spaceId, key.spaceId), eq(workflowRuns.runId, key.runId)))
      .limit(1),
  );
  const stored = rows[0]?.pins;
  if (stored === undefined || stored === null) return null;
  const parsed = SimulationRunInputSchema.safeParse(stored);
  if (!parsed.success) {
    // No row means the run was started without pins; an unreadable row means it
    // WAS pinned and nobody can say to what. Answering the second as the first
    // reopens the split this read exists to close — an agent task refusing the
    // same row while an operation task quietly runs as another persona against
    // another world, and produces a measurement that reads as valid.
    throw new SimulationRunInputUnreadable(
      `Run ${key.runId} carries simulation pins that do not parse, so the world it was started against cannot be reconstructed: ${parsed.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
