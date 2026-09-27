import { resolveJsonPointer, splitJsonPointer } from '@aflow/applet-runtime';
import type {
  SimulationCollection,
  WorldEffect,
  WorldOnMissing,
  WorldProjection,
  WorldRead,
  WorldSelector,
  WorldTransition,
  WorldTransitionRead,
  WorldWrite,
} from '@aflow/schemas';
import { entityStorageViolation } from './entities.js';
import { entityMatchesQuery } from './world.js';
import { mintEntityId } from './identity.js';
import type {
  SimulatedRequest,
  WorldEntity,
  WorldMutation,
  WorldReadQuery,
  WorldStore,
} from './types.js';

/**
 * Rung 2 — the world projection, and the single response-rendering path.
 *
 * Generation does NOT produce a response. It produces facts, the engine
 * commits them, and this projection renders the body. Letting the model emit
 * both a body and a separate write-back would give an endpoint two rendering
 * paths that must agree forever, and they would drift — a body describing a
 * refund the world never recorded.
 */

export type EffectOutcome =
  | { kind: 'resolved'; status: number; body: unknown; mutations: WorldMutation[] }
  | {
      kind: 'missing';
      readIndex: number;
      query: WorldReadQuery;
      onMissing: WorldOnMissing;
      /**
       * Set when the read misses because the request supplies no value for a
       * selector, rather than because the world holds no such entity.
       */
      unresolved?: WorldSelector;
    };

/**
 * A mutation the collection it targets forbids. Loud and non-retryable: a
 * response can satisfy its response schema while the delta behind it stores an
 * entity the collection schema disallows, and every later read and projection
 * would then run against state the simulation contract excludes.
 */
export class SimulationWorldViolationError extends Error {
  readonly collection: string;
  readonly issues: readonly string[];

  constructor(collection: string, issues: readonly string[]) {
    super(`SIMULATION_WORLD_VIOLATION: ${issues.join('; ')}`);
    this.name = 'SimulationWorldViolationError';
    this.collection = collection;
    this.issues = issues;
  }
}

/** What a transition changed. It renders no body — the rule declared one. */
export interface TransitionOutcome {
  mutations: WorldMutation[];
}

type AnyRead = WorldRead | WorldTransitionRead;

/** Entities a read or a write produced, under the name it declared. */
type NamedEntities = Map<string, WorldEntity[]>;

function requestDocument(request: SimulatedRequest): Record<string, unknown> {
  return { params: request.params, body: request.body };
}

interface BuiltQuery {
  query: WorldReadQuery;
  /** The first selector the request supplies no value for, if any. */
  unresolved?: WorldSelector;
}

function buildQuery(read: AnyRead, request: SimulatedRequest): BuiltQuery {
  const doc = requestDocument(request);
  const match: Array<{ path: string; value: unknown }> = [];
  let unresolved: WorldSelector | undefined;
  for (const selector of read.select) {
    const resolved = resolveJsonPointer(doc, selector.requestPath);
    if (!resolved.found) {
      // Dropping the predicate would WIDEN the query: a keyed read would answer
      // with the first unrelated entity in the collection, and a write targeting
      // it would mutate that one. A selector the request cannot supply narrows
      // to nothing instead.
      unresolved ??= selector;
      continue;
    }
    // The whole pointer reaches the store: `/customer/id` addresses the nested
    // reference, and a top-level `id` is a different field.
    match.push({ path: selector.entityPath, value: resolved.value });
  }
  const query: WorldReadQuery = { collection: read.collection, match };
  const limit = read.limit ?? (isEffectRead(read) && read.cardinality === 'one' ? 1 : undefined);
  if (limit !== undefined) query.limit = limit;
  return unresolved === undefined ? { query } : { query, unresolved };
}

function isEffectRead(read: AnyRead): read is WorldRead {
  return 'cardinality' in read;
}

function pickFields(entity: WorldEntity, fields: readonly string[]): unknown {
  if (fields.length === 0) return entity.body;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(entity.body, field)) out[field] = entity.body[field];
  }
  return out;
}

function assignAtPointer(
  root: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  const segments = splitJsonPointer(pointer);
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (key === undefined) continue;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) cursor[last] = value;
  return root;
}

function renderEntities(
  projection: WorldProjection,
  cardinality: 'one' | 'many',
  entities: readonly WorldEntity[],
): unknown {
  const projected = entities.map((entity) => pickFields(entity, projection.fields));
  if (cardinality === 'many') return projected;
  return projected[0] ?? null;
}

function buildEntityBody(params: {
  write: WorldWrite;
  request: SimulatedRequest;
  existing: Record<string, unknown> | undefined;
  clockMs: number;
  identityValue: string;
}): Record<string, unknown> {
  const { write, request, existing, clockMs, identityValue } = params;
  let base: Record<string, unknown> = existing ? { ...existing } : {};

  if (write.from !== undefined) {
    const resolved = resolveJsonPointer(requestDocument(request), write.from);
    if (resolved.found && typeof resolved.value === 'object' && resolved.value !== null) {
      base = { ...base, ...(resolved.value as Record<string, unknown>) };
    }
  }

  for (const [key, value] of Object.entries(write.assign ?? {})) {
    // `now` resolves against the virtual clock. Wall-clock here would make
    // every run's world differ in a field agents routinely filter and sort on.
    base[key] = value === 'now' ? new Date(clockMs).toISOString() : value;
  }

  base[write.identity] = identityValue;
  return base;
}

type ReadOutcome =
  | { kind: 'ok'; entities: WorldEntity[][]; queries: Array<WorldReadQuery | undefined> }
  | {
      kind: 'missing';
      readIndex: number;
      query: WorldReadQuery;
      onMissing: WorldOnMissing;
      unresolved?: WorldSelector;
    };

async function resolveReads(params: {
  reads: readonly AnyRead[];
  request: SimulatedRequest;
  store: WorldStore;
}): Promise<ReadOutcome> {
  const entities: WorldEntity[][] = [];
  // Retained so a mutation can be tested against the predicate that selected a
  // read's rows. Undefined where the query was unsatisfiable: such a read
  // matched nothing, and a mutation must not enter it either.
  const queries: Array<WorldReadQuery | undefined> = [];
  for (const [index, read] of params.reads.entries()) {
    const built = buildQuery(read, params.request);
    // An unsatisfiable query never reaches the store, so no broadened read can
    // be issued in its place — the containment is structural rather than a
    // filter applied to whatever came back.
    const rows = built.unresolved === undefined ? await params.store.query(built.query) : [];
    if (rows.length === 0 && isEffectRead(read) && read.cardinality === 'one') {
      return {
        kind: 'missing',
        readIndex: index,
        query: built.query,
        onMissing: read.onMissing,
        ...(built.unresolved === undefined ? {} : { unresolved: built.unresolved }),
      };
    }
    entities.push(rows);
    queries.push(built.unresolved === undefined ? built.query : undefined);
  }
  return { kind: 'ok', entities, queries };
}

/**
 * Every entity a call is about to commit, held to the schema of the collection
 * it lands in — before the journal entry exists, so a delta the contract
 * forbids is never storable and never readable.
 */
export function assertMutationsStorable(
  collections: readonly SimulationCollection[],
  mutations: readonly WorldMutation[],
): void {
  const declared = new Map(collections.map((c) => [c.collection, c]));
  for (const mutation of mutations) {
    if (mutation.op === 'delete') continue;
    const declaration = declared.get(mutation.collection);
    if (!declaration) {
      throw new SimulationWorldViolationError(mutation.collection, [
        `Collection "${mutation.collection}" is not declared in the simulation's collections[], so nothing states what an entity in it may look like.`,
      ]);
    }
    const violation = entityStorageViolation({
      declaration,
      entityId: mutation.entityId,
      body: mutation.body ?? {},
    });
    if (violation !== undefined) {
      throw new SimulationWorldViolationError(mutation.collection, [violation]);
    }
  }
}

function resolveWrites(params: {
  writes: readonly WorldWrite[];
  reads: readonly AnyRead[];
  readEntities: ReadonlyArray<readonly WorldEntity[]>;
  request: SimulatedRequest;
  collections: readonly SimulationCollection[];
  store: WorldStore;
  seed: string;
  logicalExecutionId: string;
  clockMs: number;
}): { mutations: WorldMutation[]; produced: NamedEntities } {
  const readIndexByName = new Map<string, number>();
  for (const [index, read] of params.reads.entries()) {
    if (read.as !== undefined) readIndexByName.set(read.as, index);
  }

  const mutations: WorldMutation[] = [];
  const produced: NamedEntities = new Map();

  for (const [sequence, write] of params.writes.entries()) {
    const results: WorldEntity[] = [];

    if (write.op === 'create') {
      const identityValue = mintEntityId({
        seed: params.seed,
        logicalExecutionId: params.logicalExecutionId,
        collection: write.collection,
        sequence,
      });
      const body = buildEntityBody({
        write,
        request: params.request,
        existing: undefined,
        clockMs: params.clockMs,
        identityValue,
      });
      // Stamped here, not after the loop: the projection renders `results`,
      // so a body stamped only into `mutations` would store the owner and
      // return a response without it — and the endpoint's own response schema
      // usually requires the field.
      const [stamped] = params.store.stampOwnership([
        { collection: write.collection, op: 'create', entityId: identityValue, body },
      ]);
      const created = stamped ?? {
        collection: write.collection,
        op: 'create' as const,
        entityId: identityValue,
        body,
      };
      mutations.push(created);
      results.push({ id: created.entityId, body: created.body ?? body });
    } else {
      const targetIndex =
        write.targetRead === undefined ? undefined : readIndexByName.get(write.targetRead);
      const targets = targetIndex === undefined ? [] : (params.readEntities[targetIndex] ?? []);
      for (const target of targets) {
        if (write.op === 'delete') {
          mutations.push({ collection: write.collection, op: 'delete', entityId: target.id });
          continue;
        }
        const body = buildEntityBody({
          write,
          request: params.request,
          existing: target.body,
          clockMs: params.clockMs,
          identityValue: target.id,
        });
        mutations.push({
          collection: write.collection,
          op: 'update',
          entityId: target.id,
          body,
        });
        results.push({ id: target.id, body });
      }
    }

    if (write.as !== undefined) produced.set(write.as, results);
  }

  // NOT validated here. The store stamps persona ownership onto this set
  // first, and a scoped collection declares its owner field required — so
  // checking the schema before the stamp rejects exactly the creates that were
  // written correctly. `resolveEffect` validates once the set is final.
  return { mutations, produced };
}

/**
 * The projection renders the POST-mutation world: an update that returned the
 * entity as it stood before the call would describe a world that no longer
 * exists by the time the agent reads it.
 */
function foldMutationsIntoReads(params: {
  reads: readonly AnyRead[];
  readEntities: ReadonlyArray<readonly WorldEntity[]>;
  queries: ReadonlyArray<WorldReadQuery | undefined>;
  mutations: readonly WorldMutation[];
  identityFields: ReadonlyMap<string, string>;
}): WorldEntity[][] {
  const folded = params.readEntities.map((rows) => [...rows]);
  for (const mutation of params.mutations) {
    for (const [index, read] of params.reads.entries()) {
      if (read.collection !== mutation.collection) continue;
      const bucket = folded[index];
      if (!bucket) continue;
      const at = bucket.findIndex((entity) => entity.id === mutation.entityId);
      if (mutation.op === 'delete') {
        if (at >= 0) bucket.splice(at, 1);
        continue;
      }
      const entity: WorldEntity = { id: mutation.entityId, body: mutation.body ?? {} };
      // Sharing a collection is not sharing a predicate. A mutation joins a
      // read only if it satisfies the query that selected that read's rows, and
      // an update that no longer satisfies it leaves — otherwise one read's
      // write surfaces in a sibling read that never selected the entity.
      const query = params.queries[index];
      const matches =
        query !== undefined &&
        entityMatchesQuery(entity, query, params.identityFields.get(mutation.collection));
      if (!matches) {
        if (at >= 0) bucket.splice(at, 1);
        continue;
      }
      if (at >= 0) bucket[at] = entity;
      else bucket.push(entity);
      // A bounded read stays bounded: a create must not push a `one` read to two.
      if (query.limit !== undefined && bucket.length > query.limit) {
        bucket.length = query.limit;
      }
    }
  }
  return folded;
}

function renderBody(params: {
  effect: WorldEffect;
  readEntities: ReadonlyArray<readonly WorldEntity[]>;
  produced: NamedEntities;
}): unknown {
  const readByName = new Map<string, { read: WorldRead; index: number }>();
  for (const [index, read] of params.effect.reads.entries()) {
    if (read.as !== undefined) readByName.set(read.as, { read, index });
  }
  const writeByName = new Map<string, WorldWrite>();
  for (const write of params.effect.writes) {
    if (write.as !== undefined) writeByName.set(write.as, write);
  }

  let body: Record<string, unknown> = {};
  for (const projection of params.effect.project) {
    let entities: readonly WorldEntity[] = [];
    let cardinality: 'one' | 'many' = 'many';

    if ('read' in projection.from) {
      const source = readByName.get(projection.from.read);
      if (!source) continue;
      entities = params.readEntities[source.index] ?? [];
      cardinality = source.read.cardinality;
    } else {
      const write = writeByName.get(projection.from.write);
      if (!write) continue;
      entities = params.produced.get(projection.from.write) ?? [];
      // A create makes exactly one entity; an update makes as many as the read
      // it targeted selected, so its shape is that read's shape.
      const target = write.targetRead === undefined ? undefined : readByName.get(write.targetRead);
      cardinality = write.op === 'create' ? 'one' : (target?.read.cardinality ?? 'many');
    }

    const value = renderEntities(projection, cardinality, entities);
    if (projection.bodyPath === '/') return value;
    body = assignAtPointer(body, projection.bodyPath, value);
  }
  return body;
}

/**
 * Resolve an effect against the world. Returns `missing` when a read the
 * effect declares comes back empty, so the caller can apply the read's
 * `onMissing` policy — generate, respond with a declared status, or error.
 */
export async function resolveEffect(params: {
  effect: WorldEffect;
  request: SimulatedRequest;
  store: WorldStore;
  collections: readonly SimulationCollection[];
  seed: string;
  logicalExecutionId: string;
  clockMs: number;
}): Promise<EffectOutcome> {
  const { effect, request, store, collections, seed, logicalExecutionId, clockMs } = params;

  const reads = await resolveReads({ reads: effect.reads, request, store });
  if (reads.kind === 'missing') {
    return {
      kind: 'missing',
      readIndex: reads.readIndex,
      query: reads.query,
      onMissing: reads.onMissing,
      ...(reads.unresolved === undefined ? {} : { unresolved: reads.unresolved }),
    };
  }

  const { mutations: proposed, produced } = resolveWrites({
    writes: effect.writes,
    reads: effect.reads,
    readEntities: reads.entities,
    request,
    collections,
    store,
    seed,
    logicalExecutionId,
    clockMs,
  });
  // Creates were stamped as they were built, so `produced` and `mutations`
  // agree. This pass covers anything the loop did not touch and is what makes
  // the refusal for a run acting as nobody reach every write.
  const mutations = store.stampOwnership(proposed);
  assertMutationsStorable(collections, mutations);

  const body = renderBody({
    effect,
    readEntities: foldMutationsIntoReads({
      reads: effect.reads,
      readEntities: reads.entities,
      queries: reads.queries,
      mutations,
      identityFields: new Map(collections.map((c) => [c.collection, c.identityField])),
    }),
    produced,
  });

  return { kind: 'resolved', status: effect.status, body, mutations };
}

/**
 * Resolve a rule's transition. Its reads exist only to locate the targets its
 * writes apply to, so a miss changes nothing rather than answering: the rule
 * already declared the response.
 */
export async function resolveTransition(params: {
  transition: WorldTransition;
  request: SimulatedRequest;
  store: WorldStore;
  collections: readonly SimulationCollection[];
  seed: string;
  logicalExecutionId: string;
  clockMs: number;
}): Promise<TransitionOutcome> {
  const { transition, request, store, collections, seed, logicalExecutionId, clockMs } = params;
  const reads = await resolveReads({ reads: transition.reads, request, store });
  if (reads.kind === 'missing') return { mutations: [] };

  const { mutations: proposedTransition } = resolveWrites({
    writes: transition.writes,
    reads: transition.reads,
    readEntities: reads.entities,
    request,
    collections,
    store,
    seed,
    logicalExecutionId,
    clockMs,
  });
  const mutations = store.stampOwnership(proposedTransition);
  assertMutationsStorable(collections, mutations);
  return { mutations };
}
