import {
  projectRunForMount,
  runSurfaceNeedsDetailRead,
  runViewReducer,
  workflowRunDetailToSurfaceState,
  type RunViewState,
  type WorkflowRunDetailResponse,
  type WorkflowRunSurfaceState,
  type WorkflowSurfaceItemEntry,
} from '@aflow/run-view';

/**
 * The most run cards one snapshot hydrates. A card past it reads its own run
 * detail on mount, as every card did before the snapshot carried them.
 */
export const MAX_SNAPSHOT_HYDRATED_RUNS = 10;

export type LoadRunDetail = (runId: string) => Promise<WorkflowRunDetailResponse | null>;

/**
 * Runs the page mounts as a self-hydrating card, in mount order.
 *
 * A card the reducer mounted for an operation's display (`displaySource:
 * 'op'`) reads its run through its own container, which tails the run's
 * originating session from the detail's cursor, so hydrating it here would
 * only add bytes.
 */
export function runsNeedingDetail(snapshot: RunViewState): string[] {
  const runIds: string[] = [];
  for (const item of snapshot.workflowSurfaceItems) {
    if (item.displaySource === 'op' || runIds.includes(item.runId)) continue;
    const shown = item.frozenSnapshot ?? snapshot.workflowRuns[item.runId];
    if (runSurfaceNeedsDetailRead(shown)) runIds.push(item.runId);
  }
  return runIds.slice(0, MAX_SNAPSHOT_HYDRATED_RUNS);
}

// A frozen card is a copy of the run as an earlier mount left it, so it takes
// only the run-static graph from the detail and keeps its own task rows.
function withGraph(
  frozen: WorkflowRunSurfaceState,
  hydrated: WorkflowRunSurfaceState,
): WorkflowRunSurfaceState {
  return {
    ...frozen,
    ...(hydrated.graphFidelity ? { graphFidelity: hydrated.graphFidelity } : {}),
    ...(hydrated.workflowGraph ? { workflowGraph: hydrated.workflowGraph } : {}),
    needsHydration: false,
  };
}

/**
 * Give the snapshot the run state each card would otherwise read on mount.
 *
 * Without it every card reads `GET /workflow-runs/:runId` as soon as it mounts,
 * because the event stream never carries a run's graph. Each run is then put
 * in its mount shape (`projectRunForMount`): the output bag once, and only the
 * task refs the card reads on mount.
 *
 * Best-effort per run. A run whose detail cannot be read keeps the folded
 * state, and its card reads the detail itself.
 */
export async function hydrateSnapshotRuns(
  snapshot: RunViewState,
  loadDetail: LoadRunDetail,
  nowMs: number,
): Promise<RunViewState> {
  const runIds = runsNeedingDetail(snapshot);
  const details = await Promise.all(
    runIds.map(async (runId) => {
      try {
        return await loadDetail(runId);
      } catch (err) {
        console.warn(`[buildSessionSnapshot] run ${runId} detail failed; its card reads it`, err);
        return null;
      }
    }),
  );

  let state = snapshot;
  const hydratedByRun = new Map<string, WorkflowRunSurfaceState>();
  for (const detail of details) {
    if (!detail) continue;
    const hydrated = workflowRunDetailToSurfaceState(detail, nowMs);
    hydratedByRun.set(hydrated.runId, hydrated);
    state = runViewReducer(state, { type: 'HYDRATE_WORKFLOW_RUN', state: hydrated });
  }

  const workflowRuns: Record<string, WorkflowRunSurfaceState> = {};
  for (const [runId, run] of Object.entries(state.workflowRuns)) {
    workflowRuns[runId] = projectRunForMount(run);
  }
  const workflowSurfaceItems = state.workflowSurfaceItems.map((item): WorkflowSurfaceItemEntry => {
    if (!item.frozenSnapshot) return item;
    const hydrated = hydratedByRun.get(item.runId);
    const frozen = hydrated ? withGraph(item.frozenSnapshot, hydrated) : item.frozenSnapshot;
    return { ...item, frozenSnapshot: projectRunForMount(frozen) };
  });
  return { ...state, workflowRuns, workflowSurfaceItems };
}
