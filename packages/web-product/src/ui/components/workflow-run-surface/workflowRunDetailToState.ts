import {
  workflowRunDetailToSurfaceState,
  type WorkflowRunDetailResponse,
  type WorkflowRunSurfaceState,
} from '@aflow/run-view';

export async function fetchWorkflowRunSurfaceState(
  spaceId: string,
  runId: string,
  nowMs: number,
): Promise<WorkflowRunSurfaceState | null> {
  try {
    const res = await fetch(`/api/spaces/${spaceId}/workflow-runs/${runId}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as WorkflowRunDetailResponse;
    return workflowRunDetailToSurfaceState(detail, nowMs);
  } catch {
    return null;
  }
}
