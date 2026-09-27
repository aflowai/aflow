import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Simulation, SimulationCallRecord, SimulationRunContext } from '@aflow/schemas';

// ============================================================================
// Simulations (a fulfillment for an API definition — no network, no credential)
// ============================================================================

/**
 * A simulation answers an `api_definitions` contract without a host. It targets
 * the DEFINITION rather than a binding, so one simulation can back a demo
 * binding and a CI binding; each run's world stays separate regardless.
 */
export const simulations = pgTable(
  'simulations',
  {
    /** Stable simulation identifier (unique per spaceId). */
    simulationId: text('simulation_id').notNull(),

    /** Owning space — part of the composite PK. Mirrors api_definitions.space_id. */
    spaceId: uuid('space_id').notNull(),

    name: text('name').notNull(),

    description: text('description'),

    /** Bumped on every write. A run pins the revision it started on. */
    revision: integer('revision').notNull().default(1),

    /** References api_definitions.api_id in the same space. */
    targetApiId: text('target_api_id').notNull(),

    /** Full simulation as validated JSON (collections, rule profiles, effects, policy). */
    definitionJson: jsonb('definition_json').notNull().$type<Simulation>(),

    enabled: integer('enabled').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.simulationId, table.spaceId] })],
);

export type SimulationRow = typeof simulations.$inferSelect;
export type NewSimulationRow = typeof simulations.$inferInsert;

// ============================================================================
// Simulation baselines (versioned seed worlds)
// ============================================================================

/**
 * One version of a simulation's seed world. A run pins a version for its
 * lifetime, so promoting a frozen world never changes the world under a
 * running agent.
 */
export const simulationBaselines = pgTable(
  'simulation_baselines',
  {
    simulationId: text('simulation_id').notNull(),

    spaceId: uuid('space_id').notNull(),

    version: integer('version').notNull(),

    description: text('description'),

    /** Per-collection entity counts — the cheap summary an operator surface reads. */
    entityCounts: jsonb('entity_counts').notNull().default({}).$type<Record<string, number>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.simulationId, table.spaceId, table.version] })],
);

export type SimulationBaselineRow = typeof simulationBaselines.$inferSelect;
export type NewSimulationBaselineRow = typeof simulationBaselines.$inferInsert;

// ============================================================================
// Simulation entities (the baseline world, as rows)
// ============================================================================

/**
 * The seed world stored as normalized rows rather than a document, because the
 * world-projection rung queries it per call: a JSON blob would force a full
 * read and an in-process scan for every `list`.
 */
export const simulationEntities = pgTable(
  'simulation_entities',
  {
    spaceId: uuid('space_id').notNull(),

    simulationId: text('simulation_id').notNull(),

    /** The baseline version this entity belongs to. */
    version: integer('version').notNull(),

    /** Collection name, declared in the simulation's `collections[]`. */
    collection: text('collection').notNull(),

    /** Value of the collection's `identityField` for this entity. */
    entityId: text('entity_id').notNull(),

    bodyJson: jsonb('body_json').notNull(),
  },
  (table) => [
    // The PK prefix (space, simulation, version, collection) is also the
    // collection-listing index — no separate index earns its write cost.
    primaryKey({
      columns: [table.spaceId, table.simulationId, table.version, table.collection, table.entityId],
    }),
  ],
);

export type SimulationEntityRow = typeof simulationEntities.$inferSelect;
export type NewSimulationEntityRow = typeof simulationEntities.$inferInsert;

// ============================================================================
// Simulation call records (the run journal)
// ============================================================================

/**
 * The durable append-only journal, one row per CALL and not per mutation: a
 * pure read and a rule-driven 429 mutate nothing, and both belong to the corpus
 * that conformance replay and decision-time inspection read.
 *
 * `logical_execution_id` is also the idempotency receipt, which is why it is
 * part of the key: appending the record, claiming the receipt and advancing the
 * world version are one commit, so a replay cannot find a receipt for a
 * mutation the journal never recorded.
 */
export const simulationCallRecords = pgTable(
  'simulation_call_records',
  {
    spaceId: uuid('space_id').notNull(),

    runId: text('run_id').notNull(),

    /** Stable across attempts of the same unit of work — the receipt. */
    logicalExecutionId: text('logical_execution_id').notNull(),

    simulationId: text('simulation_id').notNull(),

    bindingId: text('binding_id').notNull(),

    apiId: text('api_id').notNull(),

    endpointId: text('endpoint_id').notNull(),

    /** Canonical non-secret request shape — method, url, body. Never headers. */
    requestJson: jsonb('request_json').notNull().$type<SimulationCallRecord['request']>(),

    /** Which rung answered, and the rule it matched. */
    matchedJson: jsonb('matched_json').notNull().$type<SimulationCallRecord['matched']>(),

    responseStatus: integer('response_status').notNull(),

    responseRef: text('response_ref').notNull(),

    /** Null for a pure read — the record still exists. */
    deltaRef: text('delta_ref'),

    /** Derived from scheduled-call identity, never arrival order. */
    ordinal: integer('ordinal').notNull(),

    worldVersionBefore: integer('world_version_before').notNull(),

    worldVersionAfter: integer('world_version_after').notNull(),

    /** Virtual-clock instant this call observed, not wall-clock. */
    clockMs: bigint('clock_ms', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.runId, table.logicalExecutionId] }),
    // The fold reads a run's records in ordinal order; the PK's third column is
    // the receipt, so ordering needs its own index.
    index('idx_simulation_call_records_run').on(table.spaceId, table.runId, table.ordinal),
    // The fold orders on this column, so two records sharing a value order
    // arbitrarily and the world one run replays is not the world it lived.
    // Enforced here rather than trusted from the allocator: a version handed
    // out twice has to fail at the write, where it is still one bad call, and
    // not at the read, where it is a silently reordered world.
    uniqueIndex('uniq_simulation_call_records_world_version').on(
      table.spaceId,
      table.runId,
      table.simulationId,
      table.worldVersionAfter,
    ),
  ],
);

export type SimulationCallRecordRow = typeof simulationCallRecords.$inferSelect;
export type NewSimulationCallRecordRow = typeof simulationCallRecords.$inferInsert;

// ============================================================================
// Simulation run contexts (the durable pin)
// ============================================================================

/**
 * What one run's world is pinned to for one simulation, written at its first
 * simulated call and never rewritten.
 *
 * Durable and not only hot: the hash carrying the pin expires, and a run
 * resuming past that point would re-pin to the current artifact and the
 * current latest baseline — then fold a journal that outlived the hash onto a
 * world it never read.
 *
 * `snapshot_ref` is a column as well as a field of the context, because the
 * session purge collects payload refs from the `*_ref` columns of the rows it
 * deletes and cannot see inside a JSON body.
 */
export const simulationRunContexts = pgTable(
  'simulation_run_contexts',
  {
    spaceId: uuid('space_id').notNull(),

    runId: text('run_id').notNull(),

    simulationId: text('simulation_id').notNull(),

    contextJson: jsonb('context_json').notNull().$type<SimulationRunContext>(),

    /** Mirrors `context_json -> snapshotRef`; written once, with the row. */
    snapshotRef: text('snapshot_ref').notNull(),

    /**
     * Generated answers this `(run, simulation)` has CLAIMED, raised before the
     * model is dialled rather than after the record lands.
     *
     * Durable because the thing it bounds is money. The journal cannot serve:
     * a record exists only after the call commits, which is after the spend, so
     * two concurrent calls both reading the journal both see the same remaining
     * slot and both dial. This is not the reservation apparatus that was
     * removed — that pre-assigned world versions so entity ids could be minted
     * from them, an ordering question with a cheaper answer. A ceiling on spend
     * has no cheaper answer than counting before spending.
     */
    generatedCalls: integer('generated_calls').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.runId, table.simulationId] })],
);

export type SimulationRunContextRow = typeof simulationRunContexts.$inferSelect;
export type NewSimulationRunContextRow = typeof simulationRunContexts.$inferInsert;
