/**
 * Minting a baseline version, for every surface that mints one.
 *
 * Three ways in — a seed of supplied JSON, a freeze of a run's world, and a
 * restore of an earlier version — and one set of invariants beneath all of
 * them, because a baseline version is what a run pins for its lifetime. It is
 * never rewritten, so every path MINTS: the version is allocated under an
 * advisory lock, the collections the payload does not supply are carried
 * forward through the process, and the whole post-copy world is held to the
 * collection declarations as they stand now rather than the ones it was written
 * under. A second implementation of that would be a second place to enforce it,
 * and the first place it would stop being enforced.
 *
 * The operation an agent calls and the route the operator's screen posts to
 * both land here, the way `writeSimulationArtifact` already serves the upsert.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  readBaselineEntities,
  readCallRecords,
  simulationBaselines,
  simulationEntities,
  withTenantSchema,
} from '@aflow/database';
import type { TenantContext } from '@aflow/database';
import {
  foldWorld,
  simulationWorldLockKey,
  validateSeedEntities,
  type EntityViolation,
  type FoldedWorld,
} from '@aflow/integration-simulator';
import type {
  ErrorClassification,
  Simulation,
  SimulationBaseline,
  SimulationFreezeInput,
  SimulationFreezeOutput,
  SimulationSeedInput,
  SimulationSeedOutput,
  TenantId,
} from '@aflow/schemas';
import {
  headVersion,
  hydrateDeltas,
  readPinnedRunContext,
  type SimulationWorldScope,
} from './simulationWorldRead.js';

/** Where a baseline write happens, independent of who asked for it. */
export interface SimulationBaselineScope {
  db: PostgresJsDatabase;
  tenantCtx: TenantContext;
  tenantId: TenantId;
  spaceId: string;
}

/** A refusal the caller can act on, as opposed to one the platform owns. */
export class SimulationBaselineRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: ErrorClassification,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SimulationBaselineRejected';
  }
}

/** Rows are written in batches so one large seed world is not one giant statement. */
const ENTITY_INSERT_BATCH = 500;

function countEntities(world: FoldedWorld): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [collection, entities] of world) counts[collection] = entities.size;
  return counts;
}

async function writeEntities(
  tx: PostgresJsDatabase,
  base: { spaceId: string; simulationId: string; version: number },
  rows: ReadonlyArray<{ collection: string; entityId: string; body: Record<string, unknown> }>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += ENTITY_INSERT_BATCH) {
    const batch = rows.slice(offset, offset + ENTITY_INSERT_BATCH);
    await tx.insert(simulationEntities).values(
      batch.map((row) => ({
        spaceId: base.spaceId,
        simulationId: base.simulationId,
        version: base.version,
        collection: row.collection,
        entityId: row.entityId,
        bodyJson: row.body,
      })),
    );
  }
}

async function readEntityCounts(
  tx: PostgresJsDatabase,
  base: { spaceId: string; simulationId: string; version: number },
): Promise<Record<string, number>> {
  const rows = await tx
    .select({
      collection: simulationEntities.collection,
      total: sql<number>`count(*)::int`,
    })
    .from(simulationEntities)
    .where(
      and(
        eq(simulationEntities.spaceId, base.spaceId),
        eq(simulationEntities.simulationId, base.simulationId),
        eq(simulationEntities.version, base.version),
      ),
    )
    .groupBy(simulationEntities.collection);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.collection] = row.total;
  return counts;
}

function asEntityBody(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The collections the incoming payload does not replace, read out of the
 * version before it.
 *
 * A baseline version is what a run pins for its lifetime, so a seed mints a new
 * one instead of editing the one it read. Minting an empty version would then
 * silently drop the collections the payload said nothing about. The rows come
 * back through the process rather than through an `INSERT ... SELECT` because
 * they are held to the declarations as they stand now, and a copy the database
 * makes on its own is a copy nothing checked.
 */
async function readCarriedEntities(
  tx: PostgresJsDatabase,
  base: { spaceId: string; simulationId: string; version: number },
  carried: readonly string[],
): Promise<Record<string, Array<Record<string, unknown>>>> {
  if (carried.length === 0) return {};
  const rows = await tx
    .select({
      collection: simulationEntities.collection,
      bodyJson: simulationEntities.bodyJson,
    })
    .from(simulationEntities)
    .where(
      and(
        eq(simulationEntities.spaceId, base.spaceId),
        eq(simulationEntities.simulationId, base.simulationId),
        eq(simulationEntities.version, base.version),
        inArray(simulationEntities.collection, [...carried]),
      ),
    );
  const byCollection: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of rows) {
    const bodies = byCollection[row.collection] ?? [];
    bodies.push(asEntityBody(row.bodyJson));
    byCollection[row.collection] = bodies;
  }
  return byCollection;
}

/**
 * Refuse a `baselineVersion` that is not the one about to be minted.
 *
 * The two refusals are different facts: a version that exists is one runs may
 * be pinned to and can never be rewritten, while one past the next is a number
 * the caller invented or a version another writer took first.
 */
async function refuseRequestedVersion(
  tx: PostgresJsDatabase,
  base: { spaceId: string; simulationId: string },
  requested: number,
  minting: number,
): Promise<never> {
  const occupied = await tx
    .select({ version: simulationBaselines.version })
    .from(simulationBaselines)
    .where(
      and(
        eq(simulationBaselines.spaceId, base.spaceId),
        eq(simulationBaselines.simulationId, base.simulationId),
        eq(simulationBaselines.version, requested),
      ),
    )
    .limit(1);
  if (occupied.length > 0) {
    throw new SimulationBaselineRejected(
      'SIMULATION_BASELINE_IMMUTABLE',
      `Baseline version ${String(requested)} of simulation "${base.simulationId}" already exists, and a baseline version is immutable — a run pins one for its lifetime, so rewriting it would move the world under every run still reading it. Seeding mints version ${String(minting)}, carrying forward every declared collection this payload does not supply.`,
      'validation',
    );
  }
  throw new SimulationBaselineRejected(
    'SIMULATION_SEED_VERSION_CONFLICT',
    `Simulation "${base.simulationId}" mints baseline version ${String(minting)} next, not ${String(requested)}. \`baselineVersion\` asserts the version this seed is about to create; omit it unless you are guarding against a concurrent write.`,
    'conflict',
  );
}

/**
 * The refusal for a world that may not be stored, whichever half of it failed.
 *
 * A violation in a collection the payload never mentioned is the carried-forward
 * half failing a declaration it was not seeded under, and the caller cannot act
 * on that without being told which half it is.
 */
function seedRejected(
  violations: readonly EntityViolation[],
  supplied: ReadonlySet<string>,
): SimulationBaselineRejected {
  const carried = violations.some((violation) => !supplied.has(violation.collection));
  const detail = violations
    .slice(0, 8)
    .map((violation) => `${violation.collection}[${String(violation.index)}]: ${violation.detail}`)
    .join(' ');
  return new SimulationBaselineRejected(
    'SIMULATION_SEED_REJECTED',
    `The seed world was rejected on ${String(violations.length)} violation${violations.length === 1 ? '' : 's'}, so nothing was stored — a partially loaded world answers reads from a fixture nobody authored: ${detail}${
      carried
        ? ' A violation in a collection this payload does not supply comes from the version being carried forward: its rows are held to the collection declarations as they stand now, so supply that collection with rows the current declaration accepts.'
        : ''
    }`,
    'validation',
    { violations },
  );
}

export async function seedSimulationBaseline(
  scope: SimulationBaselineScope,
  simulation: Simulation,
  input: SimulationSeedInput,
): Promise<SimulationSeedOutput> {
  const { simulationId, entities, description } = input;
  const supplied = new Set(Object.keys(entities));
  // Only declared collections are carried: an artifact that no longer declares
  // one is saying it does not exist, and the version that holds its rows is
  // immutable and still readable.
  const carried = simulation.collections
    .map((collection) => collection.collection)
    .filter((collection) => !supplied.has(collection));

  const baseline = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.spaceId}:simulation-baseline:${simulationId}`}, 0))`,
    );
    const latest = await tx
      .select({ version: simulationBaselines.version })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, scope.spaceId),
          eq(simulationBaselines.simulationId, simulationId),
        ),
      )
      .orderBy(desc(simulationBaselines.version))
      .limit(1);
    const priorVersion = latest[0]?.version;
    const version = (priorVersion ?? 0) + 1;
    const requested = input.baselineVersion;
    if (requested !== undefined && requested !== version) {
      await refuseRequestedVersion(
        tx,
        { spaceId: scope.spaceId, simulationId },
        requested,
        version,
      );
    }
    const base = { spaceId: scope.spaceId, simulationId, version };

    const carriedEntities =
      priorVersion === undefined
        ? {}
        : await readCarriedEntities(tx, { ...base, version: priorVersion }, carried);
    // The whole post-copy world is checked, not the supplied half: a collection
    // whose declaration changed since it was seeded would otherwise ride into a
    // new version holding rows the current schema and identity field reject.
    const checked = validateSeedEntities({
      collections: simulation.collections,
      entities: { ...carriedEntities, ...entities },
    });
    if (checked.violations.length > 0) throw seedRejected(checked.violations, supplied);

    await writeEntities(tx, base, checked.entities);
    const entityCounts = await readEntityCounts(tx, base);

    const stored = await tx
      .insert(simulationBaselines)
      .values({
        simulationId,
        spaceId: scope.spaceId,
        version,
        ...(description === undefined ? {} : { description }),
        entityCounts,
      })
      .onConflictDoNothing()
      .returning({
        version: simulationBaselines.version,
        description: simulationBaselines.description,
        entityCounts: simulationBaselines.entityCounts,
        createdAt: simulationBaselines.createdAt,
      });

    const row = stored[0];
    if (!row) {
      throw new SimulationBaselineRejected(
        'SIMULATION_SEED_VERSION_CONFLICT',
        `Baseline version ${String(version)} of simulation "${simulationId}" was written while this seed was building it, so nothing was stored. Re-read the simulation and seed again against the version it is at now.`,
        'conflict',
      );
    }
    return {
      simulationId,
      version: row.version,
      ...(row.description === null ? {} : { description: row.description }),
      entityCounts: row.entityCounts,
      createdAt: row.createdAt.toISOString(),
    } satisfies SimulationBaseline;
  });

  return { baseline };
}

/**
 * Fold a run's journal onto the baseline it was pinned to and promote the
 * result as the next version.
 *
 * The concurrency is on the version being promoted FROM: two freezes off the
 * same baseline both aim at the same next version, and the second one loses on
 * the primary key rather than silently overwriting the first one's world.
 */
/**
 * A folded world the current declarations reject.
 *
 * Distinct from the seed's refusal because the operator's move differs: no
 * payload was supplied to correct, so the choice is to edit the collection
 * back, or leave the run's world where it is and freeze a different one.
 */
function freezeRejected(
  violations: readonly EntityViolation[],
  simulationId: string,
  pinnedRevision: number,
): SimulationBaselineRejected {
  const detail = violations
    .slice(0, 8)
    .map((violation) => `${violation.collection}[${String(violation.index)}]: ${violation.detail}`)
    .join(' ');
  return new SimulationBaselineRejected(
    'SIMULATION_FREEZE_REJECTED',
    `The run's world holds ${String(violations.length)} row${violations.length === 1 ? '' : 's'} the current collection declarations of "${simulationId}" reject, so no baseline was written: ${detail} The run is pinned to revision ${String(pinnedRevision)}, so it has been writing against the declarations as they stood then; an edit since has moved them. Freezing anyway would publish a world every later run pins and none can validly extend.`,
    'validation',
    { violations },
  );
}

export async function freezeSimulationBaseline(
  scope: SimulationBaselineScope,
  worldScope: SimulationWorldScope,
  simulation: Simulation,
  input: SimulationFreezeInput,
): Promise<SimulationFreezeOutput> {
  const { simulationId, runId, expectedVersion, description } = input;

  const pinned = await readPinnedRunContext(worldScope, runId, simulationId);
  if (!pinned) {
    throw new SimulationBaselineRejected(
      'SIMULATION_RUN_CONTEXT_MISSING',
      `Run ${runId} holds no pinned context for simulation "${simulationId}", so it has no world to promote. Freezing would clone baseline version ${String(expectedVersion)} through an empty journal and call the result that run's world.`,
      'not_found',
    );
  }
  if (pinned.baselineVersion !== expectedVersion) {
    throw new SimulationBaselineRejected(
      'SIMULATION_FREEZE_VERSION_MISMATCH',
      `Run ${runId} is pinned to baseline version ${String(pinned.baselineVersion)}, not ${String(expectedVersion)}. Folding its journal onto another version would apply deltas to a world the run never read.`,
      'validation',
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
  const [baseline, deltas] = await Promise.all([
    readBaselineEntities({
      db: scope.db,
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      simulationId,
      version: expectedVersion,
    }),
    hydrateDeltas(worldScope.payloadStore, records),
  ]);
  const world = foldWorld(baseline, deltas, head);

  // Held to the collection declarations as they stand NOW, exactly as a seed's
  // carried-forward rows are. A run pins its revision, so it can legitimately
  // have spent its whole life writing against a schema an edit has since
  // changed — and folding that world onto a new baseline would publish rows the
  // current declaration rejects, for every later run to pin.
  const checked = validateSeedEntities({
    collections: simulation.collections,
    entities: Object.fromEntries(
      [...world].map(([collection, entities]) => [collection, [...entities.values()]]),
    ),
  });
  if (checked.violations.length > 0) {
    throw freezeRejected(checked.violations, simulationId, pinned.simulationRevision);
  }
  const rows = checked.entities;

  const version = expectedVersion + 1;
  const promoted = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) => {
    // The journal was read and folded above, outside this transaction. A call
    // that committed in between is in the run's world and NOT in the fold, so
    // promoting now would publish a baseline that silently omits part of the
    // run it claims to be. Re-reading the head under the same lock a commit
    // takes turns that into a refusal.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${simulationWorldLockKey({ tenantId: scope.tenantId, runId, simulationId })}, 0))`,
    );
    const nowRecords = await readCallRecords({
      db: scope.db,
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      runId,
      simulationId,
    });
    const nowHead = headVersion(nowRecords);
    if (nowHead !== head) {
      throw new SimulationBaselineRejected(
        'SIMULATION_FREEZE_JOURNAL_MOVED',
        `Run ${runId} reached world version ${String(nowHead)} while this freeze was folding version ${String(head)}, so the world it built is already out of date and would promote a baseline missing part of the run. Retry now that the later calls have landed.`,
        'conflict',
        { foldedHead: head, currentHead: nowHead },
      );
    }

    // A call still running commits AFTER this transaction releases the lock,
    // and nothing here can see it: with versions assigned at commit there is no
    // reservation to observe. So a freeze captures the world THROUGH the
    // version it folded, and the baseline says which — rather than pretending
    // to capture "the run". Freezing a settled run is the operator's call, and
    // `foldedCallCount` in the result is what tells them what they got.

    const inserted = await tx
      .insert(simulationBaselines)
      .values({
        simulationId,
        spaceId: scope.spaceId,
        version,
        ...(description === undefined ? {} : { description }),
        entityCounts: countEntities(world),
      })
      .onConflictDoNothing()
      .returning({
        version: simulationBaselines.version,
        description: simulationBaselines.description,
        entityCounts: simulationBaselines.entityCounts,
        createdAt: simulationBaselines.createdAt,
      });
    const row = inserted[0];
    if (!row) return null;
    await writeEntities(tx, { spaceId: scope.spaceId, simulationId, version }, rows);
    return row;
  });

  if (!promoted) {
    throw new SimulationBaselineRejected(
      'SIMULATION_FREEZE_CONFLICT',
      `Baseline version ${String(version)} of simulation "${simulationId}" already exists, so another freeze already promoted from version ${String(expectedVersion)}. Re-read the simulation and freeze against the current version.`,
      'conflict',
    );
  }

  return {
    baseline: {
      simulationId,
      version: promoted.version,
      ...(promoted.description === null ? {} : { description: promoted.description }),
      entityCounts: promoted.entityCounts,
      createdAt: promoted.createdAt.toISOString(),
    },
    foldedCallCount: records.length,
    worldVersion: head,
  };
}

/**
 * The restored world, as a seed payload.
 *
 * EVERY declared collection is supplied, including the ones the old version
 * held nothing in. A seed carries absent collections forward from the LATEST
 * version, so omitting an empty one would restore the chosen world plus
 * whatever the current head happens to hold there — a mixture of two worlds,
 * which is not what "restore version N" means to anyone.
 */
export function restoredEntities(
  simulation: Pick<Simulation, 'collections'>,
  rows: ReadonlyArray<{ collection: string; body: Record<string, unknown> }>,
): Record<string, Array<Record<string, unknown>>> {
  const entities: Record<string, Array<Record<string, unknown>>> = {};
  for (const collection of simulation.collections) entities[collection.collection] = [];
  // A row in a collection the artifact no longer declares is dropped, exactly
  // as a seed's carry-forward drops it: an undeclared collection is the
  // artifact saying it does not exist.
  for (const row of rows) entities[row.collection]?.push(asEntityBody(row.body));
  return entities;
}

/**
 * Mint a new version holding an earlier one's world.
 *
 * Undo, in a store where nothing is rewritten: a freeze promoted a world the
 * operator did not want, and going back means going FORWARD to a version that
 * holds what the old one held. Runs pinned to the bad version keep reading it,
 * which is the point — their journals were written against it.
 *
 * Expressed as a seed rather than a copy, so the restored world passes the same
 * validation every other minted version does. A version whose rows the current
 * declarations reject is refused rather than restored, and that refusal is
 * information: the collection changed since, and restoring would publish rows
 * no later run could validly extend.
 */
export async function restoreSimulationBaseline(
  scope: SimulationBaselineScope,
  simulation: Simulation,
  input: { simulationId: string; fromVersion: number; description?: string },
): Promise<SimulationSeedOutput> {
  // An absent version and a legitimately empty one both read as no rows, so
  // the row is checked first. Without it `fromVersion: 999` mints an empty
  // world labelled "restored from 999" — a baseline every later run pins,
  // describing a version that never existed.
  const exists = await withTenantSchema(scope.db, scope.tenantCtx, async (tx) =>
    tx
      .select({ version: simulationBaselines.version })
      .from(simulationBaselines)
      .where(
        and(
          eq(simulationBaselines.spaceId, scope.spaceId),
          eq(simulationBaselines.simulationId, input.simulationId),
          eq(simulationBaselines.version, input.fromVersion),
        ),
      )
      .limit(1),
  );
  if (exists.length === 0) {
    throw new SimulationBaselineRejected(
      'SIMULATION_BASELINE_NOT_FOUND',
      `Simulation "${input.simulationId}" has no baseline version ${String(input.fromVersion)}, so there is no world to restore. Read the simulation to see which versions exist.`,
      'not_found',
    );
  }

  const restored = await readBaselineEntities({
    db: scope.db,
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    simulationId: input.simulationId,
    version: input.fromVersion,
  });

  return seedSimulationBaseline(scope, simulation, {
    simulationId: input.simulationId,
    entities: restoredEntities(simulation, restored),
    ...(input.description === undefined
      ? { description: `Restored from version ${String(input.fromVersion)}.` }
      : { description: input.description }),
  });
}
