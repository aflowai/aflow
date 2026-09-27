import type { SimulationRunContext, WorldEffect } from '@aflow/schemas';
import type { GenerateSimulatedAnswer, GenerationCallSummary } from './generate.js';

/** One entity in a collection. `id` is the value of the collection's `identityField`. */
export interface WorldEntity {
  id: string;
  body: Record<string, unknown>;
}

export interface WorldReadQuery {
  collection: string;
  /**
   * Equality between a JSON pointer into the entity document and a value, all
   * of which must hold. The pointer is whole: `/customer/id` addresses the
   * nested reference and never a top-level `id`.
   */
  match: Array<{ path: string; value: unknown }>;
  /** Matches the row's own identity, which is what a rule's `worldState` names. */
  entityId?: string;
  limit?: number;
}

export interface WorldMutation {
  collection: string;
  op: 'create' | 'update' | 'delete';
  entityId: string;
  /** Absent for delete. */
  body?: Record<string, unknown>;
}

/**
 * The world as the engine sees it: baseline folded with this run's journal.
 *
 * `commit` is the single transactional authority — appending the call record,
 * claiming the `logicalExecutionId` receipt, and advancing `worldVersion` are
 * one commit. Splitting them would let a replay find a receipt for a mutation
 * the journal never recorded.
 */
export interface WorldStore {
  /**
   * The version this call will commit at, reserved before the call runs and
   * held for its lifetime. Two calls one agent turn dispatched together hold
   * different versions, which is what stops them minting the same entity id.
   */
  version(): number;
  query(query: WorldReadQuery): Promise<WorldEntity[]>;
  /**
   * `applied` is false when the commit found this call's receipt already in the
   * journal — another attempt of the same call answered first. Its record is
   * the one that happened, so the caller must return the RECORDED answer rather
   * than the one it just computed, or the agent reads a response no journal
   * entry describes.
   */
  /**
   * Apply persona ownership to a proposed mutation set, before it is validated.
   *
   * Stamping has to happen BEFORE the collection schema is checked: a scoped
   * collection usually declares its `personaField` required, so an effect that
   * omitted it — which is the point, since a real client never sends its own
   * id — would fail validation on a field the store was about to fill in.
   *
   * Refusals that need the existing row (an update or delete aimed at somebody
   * else's entity) belong to `commit`, which is the only place that can see it.
   */
  stampOwnership(mutations: readonly WorldMutation[]): WorldMutation[];

  commit(mutations: WorldMutation[]): Promise<{ worldVersionAfter: number; applied: boolean }>;
}

/** The resolved call the simulator answers — the same shape the live path would send. */
export interface SimulatedRequest {
  method: string;
  url: string;
  endpointId: string;
  /** Path/query/header params as the agent supplied them. */
  params: Record<string, unknown>;
  body: unknown;
}

export interface SimulationContext {
  runContext: SimulationRunContext;
  /** This call's stable identity. Entity ids are minted from it, so a replay mints the same ones. */
  logicalExecutionId: string;
  /** Zero-based count of this run's prior COMMITTED calls to this endpoint. */
  ordinal: number;
  /** Virtual-clock instant. Never wall-clock — a world that differs per run in a
   *  field agents sort on is not reproducible. */
  clockMs: number;
  store: WorldStore;
  /**
   * Rung 3's model access. Absent where the caller has none — the server's
   * inspector, the eval runner, a test — and the ladder then answers only from
   * what is declared.
   */
  generate?: GenerateSimulatedAnswer;
  /** This run's earlier calls to this simulation, oldest first. */
  priorCalls?: readonly GenerationCallSummary[];
}

export interface SimulatedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  rung: 'rule' | 'code' | 'world' | 'generated';
  ruleId?: string;
  delayMs?: number;
  mutations: WorldMutation[];
  /** Set when the effect needs entities the world lacks and generation is allowed. */
  generationRequest?: GenerationRequest;
}

/** What rung 3 must invent — FACTS, never a response body. */
export interface GenerationRequest {
  effect: WorldEffect;
  /** Collections and match criteria that came back empty. */
  missing: WorldReadQuery[];
}
