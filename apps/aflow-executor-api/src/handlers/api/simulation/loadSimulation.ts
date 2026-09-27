/**
 * The simulation a binding names, and the world a run is pinned to.
 *
 * Both halves are read here because they are pinned together: the artifact
 * says what can answer a call, and the run context says which revision, which
 * baseline version, which seed and which clock anchor answered it. Resolving
 * either from the current row at call time would let an edit mid-run move the
 * world under the agent.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  ensureSimulationBaseline,
  pinDurableSimulationRunContext,
  readDurableSimulationRunInput,
  readSimulationRunContext,
  simulationBaselines,
  simulations,
  withTenantSchema,
} from '@aflow/database';
import { canonicalEndpoints, deriveRunSeed, endpointSetHash } from '@aflow/integration-simulator';
import { contentAddressForJson } from '@aflow/payload-store';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import {
  getSimulationRunContext,
  getSimulationRunInput,
  pinSimulationRunContext,
} from '@aflow/redis';
import {
  SimulationSchema,
  TenantIdSchema,
  actingPersonaId,
  validateSimulatedBinding,
} from '@aflow/schemas';
import { SimulationSnapshotSchema } from '@aflow/schemas';
import type {
  ApiBinding,
  ApiDefinition,
  SimulationRunContext,
  SimulationRunInput,
  SimulationSnapshot,
  TenantId,
} from '@aflow/schemas';
import { apiError } from '../../../lib/api-errors.js';
import { ApiExecutionError, simulationStoreKey, type ApiHandlerStores } from '../types.js';
import type { CachedSimulation, PinnedSimulation } from '../types.js';

export interface SimulationLoadParams {
  tenantId: string;
  spaceId: string;
  simulationId: string;
}

/**
 * The write boundary already refused a binding whose simulation targets another
 * API, so re-checking here is not belt and braces: the two rows are edited
 * independently, and a simulation retargeted after the binding was written
 * would otherwise answer a contract it was never validated against.
 */
function assertSimulationFulfillsBinding(params: {
  binding: Pick<ApiBinding, 'bindingId' | 'apiId' | 'fulfillment'>;
  definition: Pick<ApiDefinition, 'apiId' | 'callMode' | 'endpoints'>;
  loaded: CachedSimulation;
}): void {
  const violations = validateSimulatedBinding({
    binding: params.binding,
    definition: params.definition,
    simulation: params.loaded.simulation,
  });
  if (violations.length === 0) return;
  throw new ApiExecutionError(
    apiError(
      'API_SIMULATION_NOT_FOUND',
      `The connection "${params.binding.bindingId}" and simulation "${params.loaded.simulation.simulationId}" no longer agree: ${violations
        .map((violation) => violation.message)
        .join(' ')}`,
      {
        retryable: false,
        details: {
          bindingId: params.binding.bindingId,
          simulationId: params.loaded.simulation.simulationId,
          violations: violations.map((violation) => violation.code),
        },
      },
    ),
  );
}

async function readSimulation(
  db: PostgresJsDatabase,
  params: SimulationLoadParams,
): Promise<CachedSimulation> {
  const tenantCtx = createTenantContext(TenantIdSchema.parse(params.tenantId));

  const { simulationRow, baselineRow } = await withTenantSchema(db, tenantCtx, async (tx) => {
    const simulationRows = await tx
      .select({
        definitionJson: simulations.definitionJson,
        enabled: simulations.enabled,
      })
      .from(simulations)
      .where(
        and(
          eq(simulations.spaceId, params.spaceId),
          eq(simulations.simulationId, params.simulationId),
        ),
      )
      .limit(1);

    const baselineRows = await tx
      .select({ version: simulationBaselines.version, createdAt: simulationBaselines.createdAt })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, params.spaceId),
          eq(simulationBaselines.simulationId, params.simulationId),
        ),
      )
      .orderBy(desc(simulationBaselines.version))
      .limit(1);

    return { simulationRow: simulationRows[0], baselineRow: baselineRows[0] };
  });

  if (!simulationRow) {
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_NOT_FOUND',
        `The connection is fulfilled by simulation "${params.simulationId}", which does not exist in this space. ` +
          'Create it (or point the binding at an existing simulation) before calling its endpoints.',
        { details: { simulationId: params.simulationId, spaceId: params.spaceId } },
      ),
    );
  }
  if (simulationRow.enabled !== 1) {
    throw new ApiExecutionError(
      apiError(
        'API_FORBIDDEN',
        `Simulation "${params.simulationId}" is disabled, so it answers no calls. Enable it, or bind the API to a live connection.`,
        { retryable: false, details: { simulationId: params.simulationId } },
      ),
    );
  }

  const parsed = SimulationSchema.safeParse(simulationRow.definitionJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_NOT_FOUND',
        `Simulation "${params.simulationId}" exists but fails validation and cannot answer calls: ${issues}`,
        { details: { simulationId: params.simulationId, issues } },
      ),
    );
  }

  // A simulation with no authored world is given a real empty baseline rather
  // than a placeholder version: the version a run pins is immutable, so a
  // number standing in for "none" would be the very version the first seed
  // mints, and the pinned world would acquire that seed's rows mid-run.
  const baseline =
    baselineRow ??
    (await ensureSimulationBaseline({
      db,
      tenantId: tenantCtx.tenantId,
      spaceId: params.spaceId,
      simulationId: params.simulationId,
    }));

  return {
    simulation: parsed.data,
    baselineVersion: baseline.version,
    baselineCreatedAtMs: baseline.createdAt.getTime(),
    loadedAtMs: Date.now(),
  };
}

/**
 * Refuse a pin to a baseline version this simulation never minted.
 *
 * Cheap and once per run: the pin is minted on the first simulated call and
 * read from the context on every one after it.
 */
async function assertBaselineExists(params: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  simulationId: string;
  version: number;
}): Promise<void> {
  const tenantCtx = createTenantContext(params.tenantId);
  const rows = await withTenantSchema(params.db, tenantCtx, async (tx) =>
    tx
      .select({ version: simulationBaselines.version })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, params.spaceId),
          eq(simulationBaselines.simulationId, params.simulationId),
          eq(simulationBaselines.version, params.version),
        ),
      )
      .limit(1),
  );
  if (rows.length > 0) return;

  const available = await withTenantSchema(params.db, tenantCtx, async (tx) =>
    tx
      .select({ version: simulationBaselines.version })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, params.spaceId),
          eq(simulationBaselines.simulationId, params.simulationId),
        ),
      )
      .orderBy(desc(simulationBaselines.version))
      .limit(10),
  );

  throw new ApiExecutionError(
    apiError(
      'API_SIMULATION_BASELINE_NOT_FOUND',
      `Run start asked simulation "${params.simulationId}" to pin baseline version ${String(
        params.version,
      )}, which it has never minted. ${
        available.length === 0
          ? 'It holds no baselines at all — seed one first.'
          : `It holds ${available.map((row) => String(row.version)).join(', ')}.`
      } Pinning a version that does not exist folds onto no rows, and an empty world is not distinguishable from one that was meant to be empty.`,
      {
        retryable: false,
        details: {
          simulationId: params.simulationId,
          requestedVersion: params.version,
          availableVersions: available.map((row) => row.version),
        },
      },
    ),
  );
}

/**
 * The simulation for one `(tenant, space, simulationId)`, cached on the same
 * staleness window and dropped by the same invalidation signal as the space's
 * definitions and bindings.
 */
export async function loadSimulation(
  stores: ApiHandlerStores,
  opts: { db: PostgresJsDatabase; cacheTtlMs?: number },
  params: SimulationLoadParams & {
    binding: Pick<ApiBinding, 'bindingId' | 'apiId' | 'fulfillment'>;
    definition: Pick<ApiDefinition, 'apiId' | 'callMode' | 'endpoints'>;
  },
): Promise<CachedSimulation> {
  const key = simulationStoreKey(params);
  const ttlMs = opts.cacheTtlMs ?? 2_000;
  const loaded = await readThroughCache(stores, opts, params, key, ttlMs);
  // Outside the cache read, so a cached artifact is checked on every call
  // rather than only on the load that populated it.
  assertSimulationFulfillsBinding({
    binding: params.binding,
    definition: params.definition,
    loaded,
  });
  return loaded;
}

async function readThroughCache(
  stores: ApiHandlerStores,
  opts: { db: PostgresJsDatabase; cacheTtlMs?: number },
  params: SimulationLoadParams,
  key: string,
  ttlMs: number,
): Promise<CachedSimulation> {
  const cached = stores.simulationStore.get(key);
  if (cached !== undefined && Date.now() - cached.loadedAtMs < ttlMs) return cached;

  const inFlight = stores.simulationLoadPromises.get(key);
  if (inFlight) return inFlight;

  const promise = readSimulation(opts.db, params)
    .then((loaded) => {
      stores.simulationStore.set(key, loaded);
      return loaded;
    })
    .finally(() => {
      stores.simulationLoadPromises.delete(key);
    });

  stores.simulationLoadPromises.set(key, promise);
  return promise;
}

function pinBroken(simulationId: string, detail: string, details: Record<string, unknown>): never {
  throw new ApiExecutionError(
    apiError('API_SIMULATION_PIN_BROKEN', detail, {
      retryable: false,
      details: { simulationId, ...details },
    }),
  );
}

export interface SimulationPinParams {
  stores: ApiHandlerStores;
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
  tenantId: TenantId;
  spaceId: string;
  runId: string;
  loaded: CachedSimulation;
  definition: ApiDefinition;
}

/**
 * The run's pinned world for one simulation, minted on its first simulated
 * call for that simulation.
 *
 * The pin is the SNAPSHOT, not a revision number: the simulation artifact and
 * the endpoint set are frozen into a content-addressed payload here, and every
 * later call answers from that payload. Recording a revision and then reading
 * whatever the rows hold now would be a pin in name only.
 *
 * Read hot, then durable, and mint only when neither holds one. A context that
 * exists durably is never re-minted: the journal outlives the hot state, and a
 * second pin would fold those records onto a baseline and an artifact the run
 * never read.
 *
 * The clock anchors to the baseline's own creation instant rather than to the
 * moment of the call: a wall-clock anchor would give two runs of the same
 * script different `createdAt` values in every entity they mint, in the fields
 * agents routinely filter and sort on.
 */
async function pinRunContext(params: SimulationPinParams): Promise<SimulationRunContext> {
  const { loaded } = params;
  const simulationId = loaded.simulation.simulationId;
  const hot = await getSimulationRunContext(
    params.redis,
    params.tenantId,
    params.runId,
    simulationId,
  );
  if (hot) return hot;

  const durable = await readSimulationRunContext({
    db: params.db,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    runId: params.runId,
    simulationId,
  });
  if (durable) {
    return pinSimulationRunContext(params.redis, params.tenantId, params.runId, durable);
  }

  // Read only on the mint, never on the calls that follow it: a pinned run
  // pays no round trip for a declaration it can no longer act on.
  const runInput = await resolveRunInput(params);

  const endpoints = canonicalEndpoints(params.definition.endpoints);
  const snapshot: SimulationSnapshot = { simulation: loaded.simulation, endpoints };
  // Persisted and content-addressed: the journal outlives the run's hot state,
  // so a run resuming past it must still find the artifact it started on, and
  // two runs pinning the same pair share one object.
  const snapshotRef = await params.payloadStore.storeContentAddressed({
    tenantId: params.tenantId,
    contentHash: contentAddressForJson(snapshot),
    kind: 'simulation_snapshot',
    data: snapshot,
    persist: true,
  });

  // Verified before it is pinned, not trusted. The pin is immutable for the
  // life of the run, and a version this simulation never minted folds onto no
  // rows at all — an empty world that `unmatched: 'generate'` then answers by
  // inventing one, which is indistinguishable from a simulation that was
  // supposed to be empty.
  const requestedBaseline = runInput?.baselineVersions?.[simulationId];
  if (requestedBaseline !== undefined) {
    await assertBaselineExists({
      db: params.db,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      simulationId,
      version: requestedBaseline,
    });
  }

  // Resolved once and pinned: who the run acts as cannot move mid-run, for the
  // same reason its revision and baseline cannot. Shared with the disclosure
  // that tells the agent who it is, so the two can never name different people.
  const personaId = actingPersonaId(loaded.simulation, runInput);
  if (personaId !== null && !loaded.simulation.personas.some((p) => p.personaId === personaId)) {
    throw new ApiExecutionError(
      apiError(
        'API_SIMULATION_PERSONA_NOT_FOUND',
        `Run start asked simulation "${simulationId}" to act as persona "${personaId}", which it does not declare. ${
          loaded.simulation.personas.length === 0
            ? 'It declares no personas at all.'
            : `It declares ${loaded.simulation.personas.map((p) => p.personaId).join(', ')}.`
        } An undeclared persona owns no rows, so every persona-scoped collection would read empty.`,
        {
          retryable: false,
          details: {
            simulationId,
            requestedPersonaId: personaId,
            availablePersonaIds: loaded.simulation.personas.map((p) => p.personaId),
          },
        },
      ),
    );
  }

  // Run beats artifact beats "whatever the space would use". The executor
  // falls through this to the caller's model and the platform default when the
  // space cannot resolve a credential for it, so naming one is a preference
  // and never a way to make a simulation unanswerable.
  const generationModel =
    runInput?.generationModels?.[simulationId] ?? loaded.simulation.generationModel;

  const minted: SimulationRunContext = {
    simulationId,
    simulationRevision: loaded.simulation.revision,
    personaId,
    baselineVersion: requestedBaseline ?? loaded.baselineVersion,
    snapshotRef,
    definitionHash: endpointSetHash(endpoints),
    seed: runInput?.seed ?? deriveRunSeed(params.runId),
    clockAnchorMs: runInput?.clockAnchorMs ?? loaded.baselineCreatedAtMs,
    // Pinned like everything else the run's answers depend on. A model swapped
    // mid-run would make the second half of a transcript incomparable to the
    // first, and the recorded value is what makes two runs a benchmark rather
    // than two anecdotes.
    ...(generationModel !== undefined ? { modelRef: generationModel } : {}),
  };

  // Durable before hot: the copy that survives a Redis loss cannot be the
  // second one written. The durable write also settles which of several
  // concurrent first calls owns the pin, so the hot copy is seeded from its
  // answer rather than from `minted`.
  const pinned = await pinDurableSimulationRunContext({
    db: params.db,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    runId: params.runId,
    context: minted,
  });

  return pinSimulationRunContext(params.redis, params.tenantId, params.runId, pinned);
}

async function readSnapshot(
  stores: ApiHandlerStores,
  payloadStore: PayloadStore,
  cacheKey: string,
  runContext: SimulationRunContext,
): Promise<PinnedSimulation> {
  const cached = stores.simulationSnapshotStore.get(cacheKey);
  if (cached?.ref === runContext.snapshotRef) return cached.pinned;

  const raw = await payloadStore.retrieve(runContext.snapshotRef).catch((error: unknown) => {
    pinBroken(
      runContext.simulationId,
      `The snapshot this run pinned simulation "${runContext.simulationId}" to no longer resolves, so the run cannot be answered from the artifact it started on. Start a new run.`,
      { snapshotRef: runContext.snapshotRef, cause: String(error) },
    );
  });

  const parsed = SimulationSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    pinBroken(
      runContext.simulationId,
      `The snapshot this run pinned simulation "${runContext.simulationId}" to is not a readable simulation artifact.`,
      { snapshotRef: runContext.snapshotRef },
    );
  }
  const snapshot = parsed.data;
  // The ref is a content address, so this can only fail on a hand-edited pin —
  // and a pin that names an artifact it does not describe is worse than none.
  if (endpointSetHash(snapshot.endpoints) !== runContext.definitionHash) {
    pinBroken(
      runContext.simulationId,
      `The snapshot this run pinned simulation "${runContext.simulationId}" to holds an endpoint set other than the one the pin names.`,
      { snapshotRef: runContext.snapshotRef },
    );
  }

  const pinned: PinnedSimulation = {
    snapshot,
    endpointsById: new Map(snapshot.endpoints.map((endpoint) => [endpoint.endpointId, endpoint])),
  };
  stores.simulationSnapshotStore.set(cacheKey, { ref: runContext.snapshotRef, pinned });
  return pinned;
}

/**
 * The pinned artifact this call is answered from, and the context that pins it.
 *
 * The currently loaded definition is checked against the pin on every call and
 * a drift is refused, not absorbed: the request was shaped — path, query, body,
 * risk tier — against the definition as it stands now, and answering it from
 * the pinned contract would judge one call's bytes against another call's
 * schema. Editing an API mid-run stops the run instead of silently changing
 * what its answers mean.
 */
export async function resolvePinnedSimulation(
  params: SimulationPinParams,
): Promise<{ runContext: SimulationRunContext; pinned: PinnedSimulation }> {
  const runContext = await pinRunContext(params);
  const cacheKey = simulationStoreKey({
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    simulationId: runContext.simulationId,
  });
  const pinned = await readSnapshot(params.stores, params.payloadStore, cacheKey, runContext);

  const current = endpointSetHash(params.definition.endpoints);
  if (current !== runContext.definitionHash) {
    pinBroken(
      runContext.simulationId,
      `API definition "${params.definition.apiId}" was edited after this run pinned simulation "${runContext.simulationId}" to its endpoint set. A run answers from the contract it started on, so this call is refused rather than answered against a definition it was not shaped for. Start a new run to pick up the edit.`,
      { apiId: params.definition.apiId, pinnedDefinitionHash: runContext.definitionHash },
    );
  }

  return { runContext, pinned };
}

/**
 * What the run was started with, from whichever store still holds it.
 *
 * Hot state first, then the run row. Both are needed and neither covers the
 * other: an agent session carries the input in its create literal, while an
 * OPERATION task is dispatched straight to an executor job stream and never
 * passes through `start_run` — the durable row is its only record. A simulated
 * call from a task step read no pins at all before this and answered as the
 * simulation's default persona against a derived seed, which is invisible in
 * the response and fatal to anything comparing two runs. The durable read also
 * outlives the hot state's TTL.
 *
 * Exported for direct coverage: the order is the whole of it, and getting it
 * backwards would restore the bug in a form no type-check can see.
 */
export async function resolveRunInput(params: {
  redis: SimulationPinParams['redis'];
  db: SimulationPinParams['db'];
  tenantId: SimulationPinParams['tenantId'];
  spaceId: string;
  runId: string;
}): Promise<SimulationRunInput | null> {
  const hot = await getSimulationRunInput(params.redis, params.tenantId, params.runId);
  if (hot) return hot;
  return readDurableSimulationRunInput({
    db: params.db,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    runId: params.runId,
  });
}
