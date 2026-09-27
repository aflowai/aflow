/**
 * The fold that turns a baseline and a run's journal into a world.
 *
 * Pure, and shared: the executor folds to answer a call, the control plane
 * folds to inspect a past decision or to freeze a warm world into a baseline.
 * Two implementations would disagree about what a run actually saw, which is
 * the one thing an inspector exists to settle.
 */
import { resolveJsonPointer, splitJsonPointer } from '@aflow/applet-runtime';
import type { WorldEntity, WorldMutation, WorldReadQuery } from './types.js';

/** One baseline row, already narrowed out of its `simulation_entities` shape. */
export interface BaselineEntity {
  collection: string;
  entityId: string;
  body: Record<string, unknown>;
}

/** One journal record's contribution to the world. */
export interface JournalDelta {
  worldVersionAfter: number;
  mutations: readonly WorldMutation[];
}

/** `collection → entityId → body`. */
export type FoldedWorld = Map<string, Map<string, Record<string, unknown>>>;

function collectionOf(
  world: FoldedWorld,
  collection: string,
): Map<string, Record<string, unknown>> {
  const existing = world.get(collection);
  if (existing) return existing;
  const created = new Map<string, Record<string, unknown>>();
  world.set(collection, created);
  return created;
}

export function applyMutation(world: FoldedWorld, mutation: WorldMutation): void {
  const entities = collectionOf(world, mutation.collection);
  if (mutation.op === 'delete') {
    entities.delete(mutation.entityId);
    return;
  }
  const body = mutation.body ?? {};
  const existing = entities.get(mutation.entityId);
  // An update body is the post-image the effect computed from the entity it
  // read, so folding it over the current body is idempotent. Merging rather
  // than replacing additionally keeps a delta authored against an older read
  // from truncating fields committed since.
  entities.set(
    mutation.entityId,
    mutation.op === 'update' && existing ? { ...existing, ...body } : { ...body },
  );
}

/**
 * The world at `uptoVersion`: the baseline with every record up to that
 * version applied, in `worldVersionAfter` order.
 *
 * Version order is the record's own, never arrival order — two calls dispatched
 * by one agent turn commit concurrently, and replaying them by arrival would
 * give the same call sequence a different world on a different scheduling.
 */
export function foldWorld(
  baseline: readonly BaselineEntity[],
  records: readonly JournalDelta[],
  uptoVersion: number,
): FoldedWorld {
  const world: FoldedWorld = new Map();
  for (const row of baseline) {
    collectionOf(world, row.collection).set(row.entityId, row.body);
  }
  const applicable = records
    .filter((record) => record.worldVersionAfter <= uptoVersion)
    .sort((a, b) => a.worldVersionAfter - b.worldVersionAfter);
  for (const record of applicable) {
    for (const mutation of record.mutations) applyMutation(world, mutation);
  }
  return world;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function valuesMatch(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  // A path parameter arrives as the string the agent typed while the entity
  // holds the number it was seeded with. Refusing that match would make every
  // id lookup miss and send an otherwise deterministic read to generation.
  if (isScalar(left) && isScalar(right)) return String(left) === String(right);
  return false;
}

function heldValue(entity: WorldEntity, path: string, identityField: string | undefined): unknown {
  const resolved = resolveJsonPointer(entity.body, path);
  if (resolved.found) return resolved.value;
  // Identity is the collection's declared field, and an entity whose body
  // omits it is still addressable by the row's own id.
  const segments = splitJsonPointer(path);
  if (segments.length === 1 && segments[0] === identityField) return entity.id;
  return undefined;
}

/**
 * Whether one entity satisfies a query — the single definition of what a match
 * means, so a store that pushes predicates down and one that filters in memory
 * cannot disagree about which entity a call read.
 *
 * Predicates are whole JSON pointers into the entity document: `/customer/id`
 * addresses the nested reference, never a top-level `id` sharing its last
 * segment.
 */
export function entityMatchesQuery(
  entity: WorldEntity,
  query: WorldReadQuery,
  identityField?: string,
): boolean {
  if (query.entityId !== undefined && entity.id !== query.entityId) return false;
  return query.match.every((predicate) =>
    valuesMatch(heldValue(entity, predicate.path, identityField), predicate.value),
  );
}

/**
 * Match predicates and `limit` apply to the FOLDED world, never to the
 * baseline query: an entity a delta created, or one a delta made match, is as
 * real as a seeded one.
 */
export function queryWorld(
  world: FoldedWorld,
  query: WorldReadQuery,
  identityField?: string,
): WorldEntity[] {
  const entities = world.get(query.collection);
  if (!entities) return [];
  const matched: WorldEntity[] = [];
  for (const [entityId, body] of entities) {
    const entity: WorldEntity = { id: entityId, body };
    if (!entityMatchesQuery(entity, query, identityField)) continue;
    matched.push(entity);
    if (query.limit !== undefined && matched.length >= query.limit) break;
  }
  return matched;
}

/**
 * The advisory-lock key serializing a run's writes to one simulation's world.
 *
 * Defined once and shared, because two writers taking DIFFERENT keys is worse
 * than neither taking one: each transaction looks protected and neither
 * excludes the other. The commit path takes it per call; the freeze path takes
 * it to prove the journal has not moved under a fold it already performed.
 */
export function simulationWorldLockKey(params: {
  tenantId: string;
  runId: string;
  simulationId: string;
}): string {
  return `simulation-world:${params.tenantId}:${params.runId}:${params.simulationId}`;
}
