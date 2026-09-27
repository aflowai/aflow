'use client';

import { useApiQuery } from './useApiQuery.js';
import { useApiMutation } from './useApiQuery.js';

/**
 * Simulated fulfillment, as the operator surface reads it. Mirrors the
 * `/integrations/simulations` route replies — kept as local DTOs so this
 * client module stays free of deep schema imports.
 */

export type SimulationEndpointReadiness = 'world_ready' | 'contract_ready' | 'not_ready';

export interface SimulationReadinessCounts {
  world_ready: number;
  contract_ready: number;
  not_ready: number;
}

export interface SimulationSummary {
  simulationId: string;
  name: string;
  description: string | null;
  revision: number;
  targetApiId: string;
  enabled: boolean;
  collections: string[];
  /** Connections in this space whose fulfillment names this simulation. */
  boundBindingIds: string[];
  endpointCount: number;
  readiness: SimulationReadinessCounts;
  updatedAt: string;
}

export interface SimulationDiagnostic {
  code: string;
  endpointId?: string;
  detail: string;
}

export interface SimulationEndpointReport {
  endpointId: string;
  readiness: SimulationEndpointReadiness;
  declaredStatusClasses: string[];
  hasEffect: boolean;
  hasRule: boolean;
  diagnostics: SimulationDiagnostic[];
}

export interface SimulationWorldCollection {
  collection: string;
  entities: Array<Record<string, unknown>>;
  total: number;
  truncated: boolean;
}

export interface SimulationWorld {
  runContext: Record<string, unknown>;
  worldVersion: number;
  atHead: boolean;
  collections: SimulationWorldCollection[];
}

/**
 * Which rungs an endpoint DECLARES, which is not the rung any given call takes.
 * A rule matches on args, ordinal and world state, so it can be declared and
 * not fire; an effect whose read misses falls through to generation. Naming a
 * declaration as though it were an outcome would promise determinism and cost
 * that the next call is free to break — the actual rung is journal data, and
 * this is a static read of the artifact.
 */
export function describeAnswerSource(report: SimulationEndpointReport): string {
  if (report.readiness === 'not_ready') return 'Cannot be answered';
  if (report.hasRule && report.hasEffect) return 'Rules + world';
  if (report.hasRule) return 'Rules declared';
  if (report.hasEffect) return 'World effect';
  return 'Generation only';
}

/** True when nothing is declared, so every call to it reaches a model. */
export function alwaysGenerates(report: SimulationEndpointReport): boolean {
  return !report.hasRule && !report.hasEffect && report.readiness !== 'not_ready';
}

export function useSimulations(spaceId: string) {
  const query = useApiQuery<{ simulations?: SimulationSummary[] }>({
    key: ['space', spaceId, 'integrations', 'simulations'],
    path: '/integrations/simulations',
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId,
    staleTime: 30_000,
  });

  return {
    simulations: query.data?.simulations ?? [],
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
  };
}

export interface SimulationBaselineSummary {
  version: number;
  description: string | null;
  entityCounts: Record<string, number>;
  createdAt: string;
}

export function useSimulation(spaceId: string, simulationId: string | null) {
  const query = useApiQuery<{
    summary: SimulationSummary;
    simulation: Record<string, unknown>;
    endpoints: SimulationEndpointReport[];
    baselines: SimulationBaselineSummary[];
  }>({
    key: ['space', spaceId, 'integrations', 'simulations', simulationId ?? ''],
    path: `/integrations/simulations/${encodeURIComponent(simulationId ?? '')}`,
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId && !!simulationId,
    staleTime: 30_000,
  });

  return {
    summary: query.data?.summary ?? null,
    simulation: query.data?.simulation ?? null,
    endpoints: query.data?.endpoints ?? [],
    baselines: query.data?.baselines ?? [],
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
  };
}

export interface SimulationRunSummary {
  runId: string;
  pinnedAt: string;
  baselineVersion: number;
  simulationRevision: number;
  /** Journal records, which is one per CALL rather than per mutation. */
  callCount: number;
  /** Greatest version the run reached, 0 when nothing committed. */
  headVersion: number;
}

export function useSimulationRuns(spaceId: string, simulationId: string | null) {
  const query = useApiQuery<{ runs?: SimulationRunSummary[] }>({
    key: ['space', spaceId, 'integrations', 'simulations', simulationId ?? '', 'runs'],
    path: `/integrations/simulations/${encodeURIComponent(simulationId ?? '')}/runs`,
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId && !!simulationId,
    staleTime: 10_000,
  });

  return {
    runs: query.data?.runs ?? [],
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
  };
}

/**
 * A run's world. `runId` is required by the route because a world only exists
 * relative to a run — the space-scoped baseline is what runs start from, not
 * something calls mutate.
 */
export function useSimulationWorld(
  spaceId: string,
  simulationId: string | null,
  runId: string | null,
  worldVersion?: number,
) {
  const versionQuery = worldVersion === undefined ? '' : `&worldVersion=${String(worldVersion)}`;
  const query = useApiQuery<SimulationWorld>({
    key: [
      'space',
      spaceId,
      'integrations',
      'simulations',
      simulationId ?? '',
      'world',
      runId ?? '',
      worldVersion ?? 'head',
    ],
    path: `/integrations/simulations/${encodeURIComponent(
      simulationId ?? '',
    )}/world?runId=${encodeURIComponent(runId ?? '')}${versionQuery}`,
    ...(spaceId ? { spaceId } : {}),
    enabled: !!spaceId && !!simulationId && !!runId,
    staleTime: 10_000,
  });

  return {
    world: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error?.message ?? null,
  };
}

/**
 * Save the whole artifact.
 *
 * The whole thing, because a partial write cannot be validated: an effect names
 * collections and a rule names a status class the definition must declare, so
 * half an artifact is not a smaller artifact. `revision` is not sent — the
 * store assigns it, and a caller that could choose one could move the artifact
 * a run is pinned to.
 */
export function useSaveSimulation(spaceId: string, simulationId: string) {
  return useApiMutation<
    { simulation: Record<string, unknown>; expectedRevision: number },
    { simulationId: string; revision: number; created: boolean }
  >({
    path: `/integrations/simulations/${encodeURIComponent(simulationId)}`,
    method: 'PUT',
    ...(spaceId ? { spaceId } : {}),
    invalidate: [['space', spaceId, 'integrations', 'simulations']],
  });
}

/**
 * A minted baseline, whichever way it was minted.
 *
 * Every write here MINTS a version rather than editing one, because a run pins
 * a version for its lifetime — so the answer is always a new number, and runs
 * already reading the old one are undisturbed. That is why the world query is
 * not invalidated: no run's world moved.
 */
export interface MintedBaseline {
  baseline: SimulationBaselineSummary & { simulationId: string };
  foldedCallCount?: number;
  worldVersion?: number;
}

/**
 * What every baseline write shares: where it posts, and what it invalidates.
 *
 * Only the simulation's own query — the world query is untouched, because no
 * run's world moved. Minting a version changes what the NEXT run starts from,
 * and a run already reading an earlier one is undisturbed by construction.
 */
function baselineMutation(spaceId: string, simulationId: string, path: string) {
  return {
    path: `/integrations/simulations/${encodeURIComponent(simulationId)}${path}`,
    method: 'POST' as const,
    ...(spaceId ? { spaceId } : {}),
    invalidate: [['space', spaceId, 'integrations', 'simulations', simulationId]],
  };
}

/** Load a world from JSON, replacing the collections it supplies. */
export function useSeedBaseline(spaceId: string, simulationId: string) {
  return useApiMutation<
    { entities: Record<string, Array<Record<string, unknown>>>; description?: string },
    MintedBaseline
  >(baselineMutation(spaceId, simulationId, '/baselines'));
}

/**
 * Promote a run's world into the next baseline.
 *
 * `expectedVersion` is the version the operator was LOOKING at, not one the
 * server reads for itself: a freeze that resolved the latest version on its own
 * would promote from whatever landed while they were deciding.
 */
export function useFreezeBaseline(spaceId: string, simulationId: string) {
  return useApiMutation<
    { runId: string; expectedVersion: number; description?: string },
    MintedBaseline
  >(baselineMutation(spaceId, simulationId, '/baselines/freeze'));
}

/** Mint a new version holding an earlier one's world — undo, in an append-only store. */
export function useRestoreBaseline(spaceId: string, simulationId: string) {
  return useApiMutation<{ fromVersion: number; description?: string }, MintedBaseline>(
    baselineMutation(spaceId, simulationId, '/baselines/restore'),
  );
}
