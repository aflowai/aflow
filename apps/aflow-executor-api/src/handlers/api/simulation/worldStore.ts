/**
 * The world one simulated call reads and writes.
 *
 * Every scope here is `(run, simulation)` and never the run alone — the
 * journal fold, the version high-waters and the commit lock. Two simulations
 * answering one run are two worlds, and a fold that took the run's rows would
 * apply one's delta to the other wherever their collection names coincide.
 *
 * The journal is the source of truth and the overlay is a cache: the world at
 * any version is the pinned baseline folded with this simulation's call records
 * up to it, so losing the materialized head costs a re-fold and never data.
 * Nothing here may become a TTL'd durable store — a run that pauses longer than
 * a hot key lives would otherwise resume into an empty world.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  readBaselineEntities,
  readJournalIndex,
  simulationCallRecords,
  withTenantSchema,
} from '@aflow/database';
import type { JournalIndexEntry } from '@aflow/database';
import { escapeJsonPointerSegment } from '@aflow/applet-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import { contentAddressForJson } from '@aflow/payload-store';
import { apiError } from '../../../lib/api-errors.js';
import { ApiExecutionError } from '../types.js';
import type {
  PayloadRef,
  SessionId,
  SimulationCallRecord,
  SimulationCollection,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import {
  applyMutation,
  foldWorld,
  queryWorld,
  simulationWorldLockKey,
  type FoldedWorld,
  type JournalDelta,
  type WorldEntity,
  type WorldMutation,
  type WorldReadQuery,
  type WorldStore,
} from '@aflow/integration-simulator';

// ============================================================================
// The journal — durable
// ============================================================================

/** What the record carries about the call, known before the ladder runs. */
export interface SimulatedCallDescriptor {
  logicalExecutionId: string;
  bindingId: string;
  apiId: string;
  endpointId: string;
  request: SimulationCallRecord['request'];
  ordinal: number;
  clockMs: number;
}

/** What the record carries about the answer, known only after the ladder runs. */
export interface SimulatedCallOutcome {
  matched: SimulationCallRecord['matched'];
  responseStatus: number;
  responseRef: string;
}

export interface WorldStoreDeps {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  tenantId: TenantId;
  spaceId: string;
  runId: SessionId;
  stepExecutionId: StepExecutionId;
  attempt: number;
  simulationId: string;
  /** Pinned for the run's lifetime, so freezing a new baseline cannot move the
   *  world under a running agent. */
  baselineVersion: number;
  collections: readonly SimulationCollection[];
  /**
   * Who this run acts as, pinned for its life. `null` is an identity of nobody,
   * which reads every persona-scoped collection empty — the unauthenticated
   * caller.
   */
  personaId: string | null;
  call: SimulatedCallDescriptor;
  /**
   * Read inside `commit`. The rung, the status and the response ref exist only
   * once the ladder has read the world, so the record's answer half cannot be
   * bound when the store is constructed.
   */
  resolveOutcome: () => SimulatedCallOutcome;
}

function asMutations(value: unknown): WorldMutation[] {
  return Array.isArray(value) ? (value as WorldMutation[]) : [];
}

/**
 * The journal this call folds — this simulation's rows within the run, never
 * the run's.
 */
function journalScope(deps: WorldStoreDeps): {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: string;
  runId: SessionId;
  simulationId: string;
} {
  return {
    db: deps.db,
    tenantId: deps.tenantId,
    spaceId: deps.spaceId,
    runId: deps.runId,
    simulationId: deps.simulationId,
  };
}

// ============================================================================
// Version assignment
// ============================================================================

/** What an earlier attempt of this same call already fixed. */
export interface RecordedVersions {
  worldVersionBefore: number;
  worldVersionAfter: number;
}

/**
 * The version a call commits at is decided AT COMMIT, in commit order.
 *
 * It used to be reserved before the ladder ran, because entity ids were minted
 * from it — and deciding which slot a call reserved is what the scheduled-call
 * identity apparatus existed for: dispatch turns and indices threaded onto job
 * messages, target ordinals, two durable high-waters, and four dispatch paths
 * that could never supply any of it. Minting ids from the call's own logical id
 * removed the reason, and with it the whole question.
 *
 * What is kept is what the journal is for: `worldVersionBefore` describes the
 * world this call actually folded, `worldVersionAfter` is where it landed, and
 * both are assigned inside the same locked transaction the record is written
 * in — so versions are unique, increasing, and in the order commits happened.
 *
 * Determinism is unchanged for the runs that claim it: a serialized call
 * sequence commits in its own order either way. Two calls of one turn dispatched
 * in parallel are ordered by arrival, which is what "parallel" means and what a
 * real API gives.
 */
function worldLockKey(deps: WorldStoreDeps): string {
  return simulationWorldLockKey(deps);
}

async function recordedVersionsFor(deps: WorldStoreDeps): Promise<RecordedVersions | null> {
  const tenantContext = createTenantContext(deps.tenantId);
  return withTenantSchema(deps.db, tenantContext, async (tx) => {
    const rows = await tx
      .select({
        worldVersionBefore: simulationCallRecords.worldVersionBefore,
        worldVersionAfter: simulationCallRecords.worldVersionAfter,
      })
      .from(simulationCallRecords)
      .where(
        and(
          eq(simulationCallRecords.spaceId, deps.spaceId),
          eq(simulationCallRecords.runId, deps.runId),
          eq(simulationCallRecords.logicalExecutionId, deps.call.logicalExecutionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * The read half of persona ownership.
 *
 * Applied in `query`, which every rung reaches the world through — a rule's
 * `worldState`, an effect's reads, and the slice a generated answer is shown
 * are all this one call, so narrowing here is what makes "an endpoint cannot
 * return another persona's rows" true of all of them at once.
 *
 * `null` means the collection is owned and the run is nobody, so the honest
 * answer is no rows rather than every row.
 */
export function scopeToPersona(
  personaFields: ReadonlyMap<string, string>,
  personaId: string | null,
  query: WorldReadQuery,
): WorldReadQuery | null {
  const personaField = personaFields.get(query.collection);
  if (personaField === undefined) return query;
  if (personaId === null) return null;
  return {
    ...query,
    match: [
      ...query.match,
      { path: `/${escapeJsonPointerSegment(personaField)}`, value: personaId },
    ],
  };
}

/**
 * The write half of persona ownership, in the two places only it can be done.
 *
 * `stampOwnership` runs where mutations are BUILT, before the collection schema
 * sees them, and owns the half that needs no existing row: a create is stamped
 * with the acting persona, and a run acting as nobody may not write to an owned
 * collection at all — including deleting from one, since a caller with no rows
 * has nothing there to remove.
 *
 * Stamping rather than rejecting a create is deliberate: the acting persona is
 * the only owner the row could correctly have, and stamping is what lets an
 * effect omit the owner field the way a real client does. It is not a
 * convenience — an effect that had to supply the caller's id would be taking it
 * from the request, which is the exact unfaithfulness persona scoping exists to
 * remove.
 */
export function stampOwnership(
  personaFields: ReadonlyMap<string, string>,
  personaId: string | null,
  mutations: readonly WorldMutation[],
): WorldMutation[] {
  return mutations.map((mutation) => {
    const personaField = personaFields.get(mutation.collection);
    if (personaField === undefined) return mutation;

    if (personaId === null) {
      throw new ApiExecutionError(
        apiError(
          'API_SIMULATION_PERSONA_WRITE_REFUSED',
          `This run acts as nobody, so it cannot write to "${mutation.collection}" — every row there belongs to a persona through "${personaField}", and this caller owns none of them. Start the run with a persona, or drop "${personaField}" from the collection if its rows are shared.`,
          { retryable: false, details: { collection: mutation.collection, personaField } },
        ),
      );
    }

    if (mutation.op !== 'create') return mutation;
    return { ...mutation, body: { ...(mutation.body ?? {}), [personaField]: personaId } };
  });
}

export async function createWorldStore(deps: WorldStoreDeps): Promise<WorldStore> {
  const recorded = await recordedVersionsFor(deps);

  let index = await readJournalIndex(journalScope(deps));
  const identityFields = new Map(deps.collections.map((c) => [c.collection, c.identityField]));
  const personaFields = new Map(
    deps.collections.flatMap((c) =>
      c.personaField === undefined ? [] : [[c.collection, c.personaField] as const],
    ),
  );

  // What this call ACTUALLY read, which is what the record must say — the field
  // inspection offers to answer "what did this call see". Every fold in this
  // store draws on the one `index` snapshot taken above, so one answer holds
  // for the whole call. A replay keeps its own record's value: recomputing
  // would move a number the journal has already published.
  const observedVersion =
    recorded?.worldVersionBefore ??
    index.reduce((greatest, entry) => Math.max(greatest, entry.worldVersionAfter), 0);
  // Where this call will land. A replay reports the version it already took;
  // anything else is decided in the commit transaction, because until it holds
  // the lock it cannot know what committed in the meantime.
  let head = recorded?.worldVersionAfter ?? observedVersion;

  const overlay: FoldedWorld = new Map();
  const materialized = new Set<string>();
  let deltasPromise: Promise<JournalDelta[]> | undefined;

  async function hydrateDeltas(): Promise<JournalDelta[]> {
    const mutating = index.flatMap((entry) =>
      entry.deltaRef === null
        ? []
        : [{ worldVersionAfter: entry.worldVersionAfter, deltaRef: entry.deltaRef }],
    );
    return Promise.all(
      mutating.map(async (entry) => ({
        worldVersionAfter: entry.worldVersionAfter,
        mutations: asMutations(await deps.payloadStore.retrieve(entry.deltaRef)),
      })),
    );
  }

  async function deltas(): Promise<JournalDelta[]> {
    deltasPromise ??= hydrateDeltas();
    return deltasPromise;
  }

  async function ensureCollection(collection: string): Promise<void> {
    if (materialized.has(collection)) return;
    const [baseline, journal] = await Promise.all([
      readBaselineEntities({
        db: deps.db,
        tenantId: deps.tenantId,
        spaceId: deps.spaceId,
        simulationId: deps.simulationId,
        version: deps.baselineVersion,
        collection,
      }),
      deltas(),
    ]);
    const scoped = journal.map((delta) => ({
      worldVersionAfter: delta.worldVersionAfter,
      mutations: delta.mutations.filter((mutation) => mutation.collection === collection),
    }));
    const folded = foldWorld(baseline, scoped, head);
    overlay.set(collection, folded.get(collection) ?? new Map<string, Record<string, unknown>>());
    materialized.add(collection);
  }

  async function storeDelta(mutations: readonly WorldMutation[]): Promise<PayloadRef | undefined> {
    if (mutations.length === 0) return undefined;
    return deps.payloadStore.storeContentAddressed({
      tenantId: deps.tenantId,
      contentHash: contentAddressForJson(mutations),
      kind: 'simulation_delta',
      data: mutations,
      persist: true,
    });
  }

  /**
   * Every read narrowed to the run's persona, in ONE place.
   *
   * A real API takes the caller's identity from the credential, so an endpoint
   * cannot be asked for somebody else's rows. Applying that here rather than in
   * each rung is what makes it true of all of them at once: a rule's
   * `worldState`, an effect's reads, and the slice a generated answer is shown
   * are the same `query` call, and none of them can forget.
   *
   * `null` means the collection is owned and the run is nobody, so the honest
   * answer is no rows rather than every row.
   */

  /**
   * The write half of persona ownership.
   *
   * `query` narrows what a run can SEE; without the same rule here a run can
   * still WRITE a row naming somebody else — a generated answer inventing a
   * customerId, or a declared create built `from: '/body'` with an id the agent
   * supplied. The row then belongs to that persona, and a later run acting as
   * them reads it as their own data. Scoping reads alone makes that leak quiet
   * rather than impossible.
   *
   * A create is STAMPED rather than rejected: the acting persona is the only
   * owner it could correctly have, and stamping means an effect author never
   * has to thread the caller's id through the request the way a real API's
   * client never does. An update or delete is REFUSED when it names another
   * persona, because rewriting the owner of an existing row is not an
   * ownership question the caller gets to answer.
   *
   * Acting as nobody may not write to an owned collection at all — an
   * unauthenticated caller has no rows, so a row it created would belong to
   * no one and be readable by no one.
   */
  /**
   * The half of ownership that needs the existing row.
   *
   * An update or delete names an entity by id, and nothing so far has proved
   * that entity belongs to the acting persona — a generated answer can invent
   * any id, and a declared write can take one from the request. Checking only
   * the proposed body is not enough either: an update that simply omits the
   * owner field would pass while still rewriting somebody else's row.
   *
   * So the target is resolved through the SAME persona-scoped read the agent
   * would get. Invisible means not theirs — or absent, which is indistinguishable
   * from the caller's side and refused identically, because telling the two
   * apart is itself a disclosure about another persona's data.
   */
  async function enforceOwnershipAtCommit(
    mutations: readonly WorldMutation[],
  ): Promise<WorldMutation[]> {
    for (const mutation of mutations) {
      const personaField = personaFields.get(mutation.collection);
      if (personaField === undefined || mutation.op === 'create') continue;

      await ensureCollection(mutation.collection);
      const visible = queryWorld(
        overlay,
        scopeToPersona(personaFields, deps.personaId, {
          collection: mutation.collection,
          match: [],
        }) ?? { collection: mutation.collection, match: [] },
        identityFields.get(mutation.collection),
      );
      if (!visible.some((entity) => entity.id === mutation.entityId)) {
        throw new ApiExecutionError(
          apiError(
            'API_SIMULATION_PERSONA_WRITE_REFUSED',
            `${mutation.collection}/${mutation.entityId} does not belong to the persona this run acts as, so it cannot be ${mutation.op === 'delete' ? 'deleted' : 'updated'}. A real API resolves the row within the caller's own data and returns 404 for anything outside it.`,
            {
              retryable: false,
              details: {
                collection: mutation.collection,
                entityId: mutation.entityId,
                personaField,
                actingPersonaId: deps.personaId,
              },
            },
          ),
        );
      }

      const proposedOwner = mutation.body?.[personaField];
      if (proposedOwner !== undefined && proposedOwner !== deps.personaId) {
        throw new ApiExecutionError(
          apiError(
            'API_SIMULATION_PERSONA_WRITE_REFUSED',
            `This run acts as "${String(deps.personaId)}" and tried to set "${personaField}" to ${JSON.stringify(proposedOwner)} on ${mutation.collection}/${mutation.entityId}. A caller cannot move a row to another owner — a real API takes the owner from the credential and never from the request.`,
            {
              retryable: false,
              details: {
                collection: mutation.collection,
                personaField,
                actingPersonaId: deps.personaId,
                attemptedOwner: proposedOwner,
              },
            },
          ),
        );
      }
    }
    return [...mutations];
  }

  return {
    version: () => head,

    stampOwnership: (mutations) => stampOwnership(personaFields, deps.personaId, mutations),

    async query(query: WorldReadQuery): Promise<WorldEntity[]> {
      const scoped = scopeToPersona(personaFields, deps.personaId, query);
      if (scoped === null) return [];
      await ensureCollection(query.collection);
      return queryWorld(overlay, scoped, identityFields.get(query.collection));
    },

    async commit(
      mutations: WorldMutation[],
    ): Promise<{ worldVersionAfter: number; applied: boolean }> {
      // Written before the transaction opens: a payload round trip inside the
      // run's world lock would serialize every other call in the turn behind
      // it. Content-addressed rather than attempt-keyed, so two deliveries of
      // one attempt converge on the same object when they computed the same
      // mutations and land on different ones when they did not — either way the
      // loser cannot overwrite what the winner's row references.
      // Stamped again here rather than trusted: `commit` is the boundary every
      // rung reaches, and a caller that built mutations without going through
      // `stampOwnership` would otherwise write unstamped rows.
      const owned = await enforceOwnershipAtCommit(
        stampOwnership(personaFields, deps.personaId, mutations),
      );
      const deltaRef = await storeDelta(owned);
      const outcome = deps.resolveOutcome();
      const tenantContext = createTenantContext(deps.tenantId);
      const lockKey = worldLockKey(deps);

      const committed = await withTenantSchema(deps.db, tenantContext, async (tx) => {
        // Serializes this simulation's commits. Receipts deduplicate retries of ONE
        // call and say nothing about two different calls one agent turn
        // dispatched together; each of those wrote a version reserved before
        // its ladder ran, so the fold order is the order they reserved in
        // rather than the order they happened to land in.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

        const existing = await tx
          .select({ worldVersionAfter: simulationCallRecords.worldVersionAfter })
          .from(simulationCallRecords)
          .where(
            and(
              eq(simulationCallRecords.spaceId, deps.spaceId),
              eq(simulationCallRecords.runId, deps.runId),
              eq(simulationCallRecords.logicalExecutionId, deps.call.logicalExecutionId),
            ),
          )
          .limit(1);
        const receipt = existing[0];
        if (receipt !== undefined) {
          return { worldVersionAfter: receipt.worldVersionAfter, applied: false };
        }

        // Decided HERE, holding the lock: the next version above whatever has
        // committed for this (run, simulation) by now. Versions are therefore
        // unique, increasing, and in the order commits actually happened —
        // which is the only order the journal can honestly claim.
        const headRows = await tx
          .select({
            head: sql<number>`coalesce(max(${simulationCallRecords.worldVersionAfter}), 0)`,
          })
          .from(simulationCallRecords)
          .where(
            and(
              eq(simulationCallRecords.spaceId, deps.spaceId),
              eq(simulationCallRecords.runId, deps.runId),
              eq(simulationCallRecords.simulationId, deps.simulationId),
            ),
          );
        const worldVersionAfter = (headRows[0]?.head ?? 0) + 1;

        await tx.insert(simulationCallRecords).values({
          spaceId: deps.spaceId,
          runId: deps.runId,
          logicalExecutionId: deps.call.logicalExecutionId,
          simulationId: deps.simulationId,
          bindingId: deps.call.bindingId,
          apiId: deps.call.apiId,
          endpointId: deps.call.endpointId,
          requestJson: deps.call.request,
          matchedJson: outcome.matched,
          responseStatus: outcome.responseStatus,
          responseRef: outcome.responseRef,
          deltaRef: deltaRef ?? null,
          ordinal: deps.call.ordinal,
          worldVersionBefore: observedVersion,
          worldVersionAfter,
          clockMs: deps.call.clockMs,
        });

        return { worldVersionAfter, applied: true };
      });

      if (committed.applied) {
        head = committed.worldVersionAfter;
        const entry: JournalIndexEntry = {
          logicalExecutionId: deps.call.logicalExecutionId,
          worldVersionAfter: committed.worldVersionAfter,
          deltaRef: deltaRef ?? null,
        };
        index = [...index, entry];
        if (deltasPromise !== undefined) {
          const hydrated = await deltasPromise;
          deltasPromise = Promise.resolve([
            ...hydrated,
            { worldVersionAfter: committed.worldVersionAfter, mutations: owned },
          ]);
        }
        // The stamped mutations, not the requested ones: the delta the journal
        // holds is what a later fold replays, so an overlay built from the
        // originals would answer this run's remaining calls from a world no
        // other reader will ever reconstruct.
        for (const mutation of owned) {
          if (materialized.has(mutation.collection)) applyMutation(overlay, mutation);
        }
      } else {
        // Another attempt of this call committed first. The overlay was folded
        // without that record, and a cache that cannot prove it is current is
        // dropped rather than trusted.
        index = await readJournalIndex(journalScope(deps));
        overlay.clear();
        materialized.clear();
        deltasPromise = undefined;
      }
      head = committed.worldVersionAfter;
      return { worldVersionAfter: committed.worldVersionAfter, applied: committed.applied };
    },
  };
}
