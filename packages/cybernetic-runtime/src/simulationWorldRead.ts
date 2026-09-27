/**
 * Folding a run's simulated world, for every surface that reads one.
 *
 * The operation an agent calls and the REST route the operator UI reads must
 * fold the SAME world from the SAME baseline and journal. Two implementations
 * would drift in exactly the place it matters least visibly — a delta one side
 * hydrates and the other skips shows up as a world the inspector disagrees
 * with the run about, and the inspector is the instrument you would reach for
 * to explain the disagreement.
 *
 * The read is hot-first and durable-second, never durable alone: the hash
 * answers without a query while a run is warm, and the row answers for every
 * run whose hot state is gone — which is most of the runs anyone inspects,
 * since inspection happens after the work is done.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { readBaselineEntities, readCallRecords, readSimulationRunContext } from '@aflow/database';
import { foldWorld, type JournalDelta, type WorldMutation } from '@aflow/integration-simulator';
import { getSimulationRunContext } from '@aflow/redis';
import type { SimulationCallRecord, SimulationRunContext, TenantId } from '@aflow/schemas';

/** Just enough of a payload store to hydrate a journal delta. */
export interface DeltaSource {
  retrieve(ref: string): Promise<unknown>;
}

export interface SimulationWorldScope {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: DeltaSource;
  tenantId: TenantId;
  spaceId: string;
}

export interface FoldedWorldCollection {
  collection: string;
  entities: Array<Record<string, unknown>>;
  total: number;
  truncated: boolean;
}

export interface FoldedRunWorld {
  runContext: SimulationRunContext;
  worldVersion: number;
  atHead: boolean;
  collections: FoldedWorldCollection[];
  calls?: SimulationCallRecord[];
}

/** A refusal the caller can act on, as opposed to one the platform owns. */
export class SimulationWorldReadError extends Error {
  readonly code: string;
  readonly kind: 'not_found' | 'validation';

  constructor(code: string, message: string, kind: 'not_found' | 'validation') {
    super(message);
    this.name = 'SimulationWorldReadError';
    this.code = code;
    this.kind = kind;
  }
}

function asMutations(value: unknown): WorldMutation[] {
  return Array.isArray(value) ? (value as WorldMutation[]) : [];
}

export async function hydrateDeltas(
  payloadStore: DeltaSource,
  records: readonly SimulationCallRecord[],
): Promise<JournalDelta[]> {
  const mutating = records.flatMap((record) =>
    record.deltaRef === undefined
      ? []
      : [{ worldVersionAfter: record.worldVersionAfter, deltaRef: record.deltaRef }],
  );
  return Promise.all(
    mutating.map(async (entry) => ({
      worldVersionAfter: entry.worldVersionAfter,
      mutations: asMutations(await payloadStore.retrieve(entry.deltaRef)),
    })),
  );
}

export async function readPinnedRunContext(
  scope: SimulationWorldScope,
  runId: string,
  simulationId: string,
): Promise<SimulationRunContext | null> {
  const hot = await getSimulationRunContext(scope.redis, scope.tenantId, runId, simulationId);
  if (hot) return hot;
  return readSimulationRunContext({
    db: scope.db,
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    runId,
    simulationId,
  });
}

export function headVersion(records: readonly SimulationCallRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.worldVersionAfter), 0);
}

/**
 * Entities per collection when the caller names no limit.
 *
 * Defaulted rather than unbounded: a simulation may declare 64 collections of
 * 5,000 rows, and this fold is served both as an HTTP response and as an agent
 * tool result. An omitted limit is a caller who has not thought about size, not
 * a caller asking for everything — `truncated` says when there is more, and the
 * inspector pages by asking for a version rather than by asking for more rows.
 */
const DEFAULT_ENTITY_LIMIT = 100;

/** Journal records returned with a world fold when calls are asked for. */
const DEFAULT_CALL_LIMIT = 50;

export async function foldRunWorld(
  scope: SimulationWorldScope,
  params: {
    simulationId: string;
    runId: string;
    worldVersion?: number | undefined;
    collections?: readonly string[] | undefined;
    entityLimit?: number | undefined;
    includeCalls?: boolean | undefined;
  },
): Promise<FoldedRunWorld> {
  const { simulationId, runId } = params;

  const runContext = await readPinnedRunContext(scope, runId, simulationId);
  if (!runContext) {
    throw new SimulationWorldReadError(
      'SIMULATION_RUN_CONTEXT_MISSING',
      `Run ${runId} holds no pinned context for simulation "${simulationId}", so there is no baseline version to fold its journal onto. The run made no simulated call through this simulation.`,
      'not_found',
    );
  }

  const records = await readCallRecords({
    db: scope.db,
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    runId,
    simulationId,
  });
  const head = headVersion(records);
  const worldVersion = params.worldVersion ?? head;
  if (worldVersion > head) {
    throw new SimulationWorldReadError(
      'SIMULATION_WORLD_VERSION_OUT_OF_RANGE',
      `Run ${runId} reached world version ${String(head)}, so version ${String(worldVersion)} names a world it never had. Pass a call record's worldVersionBefore to see what that call read.`,
      'validation',
    );
  }

  const upto = records.filter((record) => record.worldVersionAfter <= worldVersion);
  const [baseline, deltas] = await Promise.all([
    readBaselineEntities({
      db: scope.db,
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      simulationId,
      version: runContext.baselineVersion,
    }),
    hydrateDeltas(scope.payloadStore, upto),
  ]);
  const world = foldWorld(baseline, deltas, worldVersion);

  const requested = params.collections === undefined ? undefined : new Set(params.collections);
  const collections = [...world]
    .filter(([collection]) => requested === undefined || requested.has(collection))
    .map(([collection, entities]) => {
      const bodies = [...entities.values()];
      const capped = bodies.slice(0, params.entityLimit ?? DEFAULT_ENTITY_LIMIT);
      return {
        collection,
        entities: capped,
        total: bodies.length,
        truncated: capped.length < bodies.length,
      };
    })
    .sort((a, b) => a.collection.localeCompare(b.collection));

  return {
    runContext,
    worldVersion,
    atHead: worldVersion === head,
    collections,
    // The journal tail, not the whole journal: a long run holds hundreds of
    // records and this is read into a tool result. Newest last, matching the
    // fold order the caller already sees.
    ...(params.includeCalls === true ? { calls: upto.slice(-DEFAULT_CALL_LIMIT) } : {}),
  };
}
