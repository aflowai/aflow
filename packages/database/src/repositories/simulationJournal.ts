/**
 * Reads over a simulation's durable world: the run journal and the pinned
 * baseline.
 *
 * The journal is the source of truth for what a run's world holds, and three
 * callers need the same rows — the api executor answering a call, the
 * inspector reconstructing a decision, and freeze promoting a warm world into
 * a baseline. Two readers disagreeing about ordering would make the inspector
 * describe a world the agent never saw.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SimulationCallRecord, TenantId } from '@aflow/schemas';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import { simulationCallRecords, simulationEntities } from '../schema/tenant/simulations.js';

export interface SimulationJournalScope {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  runId: string;
}

const recordColumns = {
  logicalExecutionId: simulationCallRecords.logicalExecutionId,
  simulationId: simulationCallRecords.simulationId,
  bindingId: simulationCallRecords.bindingId,
  apiId: simulationCallRecords.apiId,
  endpointId: simulationCallRecords.endpointId,
  requestJson: simulationCallRecords.requestJson,
  matchedJson: simulationCallRecords.matchedJson,
  responseStatus: simulationCallRecords.responseStatus,
  responseRef: simulationCallRecords.responseRef,
  deltaRef: simulationCallRecords.deltaRef,
  ordinal: simulationCallRecords.ordinal,
  worldVersionBefore: simulationCallRecords.worldVersionBefore,
  worldVersionAfter: simulationCallRecords.worldVersionAfter,
  clockMs: simulationCallRecords.clockMs,
};

function toCallRecord(row: {
  logicalExecutionId: string;
  simulationId: string;
  bindingId: string;
  apiId: string;
  endpointId: string;
  requestJson: SimulationCallRecord['request'];
  matchedJson: SimulationCallRecord['matched'];
  responseStatus: number;
  responseRef: string;
  deltaRef: string | null;
  ordinal: number;
  worldVersionBefore: number;
  worldVersionAfter: number;
  clockMs: number;
}): SimulationCallRecord {
  return {
    logicalExecutionId: row.logicalExecutionId,
    simulationId: row.simulationId,
    bindingId: row.bindingId,
    apiId: row.apiId,
    endpointId: row.endpointId,
    request: row.requestJson,
    matched: row.matchedJson,
    responseStatus: row.responseStatus,
    responseRef: row.responseRef,
    ...(row.deltaRef === null ? {} : { deltaRef: row.deltaRef }),
    ordinal: row.ordinal,
    worldVersionBefore: row.worldVersionBefore,
    worldVersionAfter: row.worldVersionAfter,
    clockMs: row.clockMs,
  };
}

/**
 * One simulation's journal within a run, oldest first.
 *
 * Scoped by simulation and not by run alone: two simulations answering one run
 * hold separate worlds, and a fold that took every row would apply one
 * simulation's delta to the other wherever their collection names coincide.
 *
 * Ordered by `worldVersionAfter` and not by `ordinal`: the ordinal counts calls
 * per endpoint, while the world version is monotonic across the simulation's
 * whole journal by construction. For a call carrying a scheduled-call identity
 * that version is a function of the identity, so this ordering IS the canonical
 * replay order — the sequence the agent decided on, not the one its executors
 * happened to finish in.
 */
export async function readCallRecords(
  scope: SimulationJournalScope & { simulationId: string },
): Promise<SimulationCallRecord[]> {
  const tenantContext = createTenantContext(scope.tenantId);
  const rows = await withTenantSchema(scope.db, tenantContext, async (tx) =>
    tx
      .select(recordColumns)
      .from(simulationCallRecords)
      .where(
        and(
          eq(simulationCallRecords.spaceId, scope.spaceId),
          eq(simulationCallRecords.runId, scope.runId),
          eq(simulationCallRecords.simulationId, scope.simulationId),
        ),
      )
      .orderBy(asc(simulationCallRecords.worldVersionAfter)),
  );
  return rows.map(toCallRecord);
}

/** The head of one simulation's journal within a run, and its mutating deltas. */
export interface JournalIndexEntry {
  logicalExecutionId: string;
  worldVersionAfter: number;
  deltaRef: string | null;
}

/**
 * The index the fold walks: one row per call, without the request, response or
 * match detail the fold never reads.
 */
export async function readJournalIndex(
  scope: SimulationJournalScope & { simulationId: string },
): Promise<JournalIndexEntry[]> {
  const tenantContext = createTenantContext(scope.tenantId);
  return withTenantSchema(scope.db, tenantContext, async (tx) =>
    tx
      .select({
        logicalExecutionId: simulationCallRecords.logicalExecutionId,
        worldVersionAfter: simulationCallRecords.worldVersionAfter,
        deltaRef: simulationCallRecords.deltaRef,
      })
      .from(simulationCallRecords)
      .where(
        and(
          eq(simulationCallRecords.spaceId, scope.spaceId),
          eq(simulationCallRecords.runId, scope.runId),
          eq(simulationCallRecords.simulationId, scope.simulationId),
        ),
      ),
  );
}

/**
 * The receipt for one unit of work. A crash between committing and persisting
 * the step's output replays the handler — `outputExists()` short-circuits
 * before it, not inside it — so the answer to a call that already committed
 * comes from here rather than from a second run down the ladder.
 */
export async function findCallRecord(
  scope: SimulationJournalScope & { logicalExecutionId: string },
): Promise<SimulationCallRecord | null> {
  const tenantContext = createTenantContext(scope.tenantId);
  const rows = await withTenantSchema(scope.db, tenantContext, async (tx) =>
    tx
      .select(recordColumns)
      .from(simulationCallRecords)
      .where(
        and(
          eq(simulationCallRecords.spaceId, scope.spaceId),
          eq(simulationCallRecords.runId, scope.runId),
          eq(simulationCallRecords.logicalExecutionId, scope.logicalExecutionId),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  return row === undefined ? null : toCallRecord(row);
}

function asBody(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** One baseline version's entities, optionally narrowed to a single collection. */
export async function readBaselineEntities(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  simulationId: string;
  version: number;
  collection?: string;
}): Promise<Array<{ collection: string; entityId: string; body: Record<string, unknown> }>> {
  const tenantContext = createTenantContext(params.tenantId);
  const scoped = and(
    eq(simulationEntities.spaceId, params.spaceId),
    eq(simulationEntities.simulationId, params.simulationId),
    eq(simulationEntities.version, params.version),
    ...(params.collection === undefined
      ? []
      : [eq(simulationEntities.collection, params.collection)]),
  );
  const rows = await withTenantSchema(params.db, tenantContext, async (tx) =>
    tx
      .select({
        collection: simulationEntities.collection,
        entityId: simulationEntities.entityId,
        bodyJson: simulationEntities.bodyJson,
      })
      .from(simulationEntities)
      .where(scoped),
  );
  return rows.map((row) => ({
    collection: row.collection,
    entityId: row.entityId,
    body: asBody(row.bodyJson),
  }));
}
