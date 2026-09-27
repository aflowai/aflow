import type { TimelineItemStatus } from '@aflow/design-system';
import type {
  WorkflowRunSurfaceState,
  WorkflowSurfaceGraph,
  WorkflowSurfaceRunStatus,
  WorkflowSurfaceTaskState,
  WorkflowSurfaceTaskStatus,
  WorkflowSurfaceTaskWhen,
} from '../../lib/types.js';

export const STALLED_THRESHOLD_MS = 5 * 60_000;

export const ACTIVE_OP_STALE_THRESHOLD_MS = STALLED_THRESHOLD_MS;

export const THINKING_GRACE_MS = 7_000;

export type PillTone = 'success' | 'warning' | 'destructive' | 'info' | 'muted';

export const TERMINAL_RUN_STATUSES = new Set<WorkflowSurfaceRunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** Task statuses that count as "done" for the run-level progress meter. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<WorkflowSurfaceTaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

export function selectPendingUsageTaskIds(
  tasks: Record<string, WorkflowSurfaceTaskState>,
): string[] {
  const ids: string[] = [];
  for (const task of Object.values(tasks)) {
    if (
      task.taskType === 'agent' &&
      TERMINAL_TASK_STATUSES.has(task.status) &&
      task.stepCount == null
    ) {
      ids.push(task.taskId);
    }
  }
  return ids.sort();
}

/** Task statuses that should read as a failure in the header summary. */
export const FAILED_TASK_STATUSES: ReadonlySet<WorkflowSurfaceTaskStatus> = new Set([
  'failed',
  'cancelled',
]);

/** Non-terminal statuses that still represent outstanding work (progress + live ticker). */
export const IN_FLIGHT_TASK_STATUSES: ReadonlySet<WorkflowSurfaceTaskStatus> = new Set([
  'running',
  'paused',
  'blocked',
]);

export interface TimelineRow {
  taskId: string;
  label: string;
  forward: boolean;
  task: WorkflowSurfaceTaskState | undefined;
  dependsOn: string[];
  /** Forward-DAG rows — definition-sourced icon hints when graph carries them. */
  taskType?: 'agent' | 'operation' | 'human';
  humanIntent?: 'approve' | 'collect';
  operationId?: string;
  /** Definition-sourced `when` guard — set on forward AND recorded rows. */
  when?: WorkflowSurfaceTaskWhen;
}

/** Run-level status → pill label + tone (mirrors the spine's HELMSMAN tables). */
export function runPill(status: WorkflowSurfaceRunStatus): { label: string; tone: PillTone } {
  switch (status) {
    case 'running':
    case 'in_flight':
      return { label: 'executing', tone: 'success' };
    case 'paused':
      return { label: 'paused', tone: 'warning' };
    case 'completed':
      return { label: 'completed', tone: 'muted' };
    case 'failed':
      return { label: 'failed', tone: 'destructive' };
    case 'cancelled':
      return { label: 'cancelled', tone: 'destructive' };
    case 'skipped':
      return { label: 'skipped', tone: 'muted' };
  }
}

export function deriveEffectiveRunStatus(
  state: WorkflowRunSurfaceState,
  rows: TimelineRow[],
): WorkflowSurfaceRunStatus {
  if (TERMINAL_RUN_STATUSES.has(state.status)) return state.status;
  // Pinned pause-time cards should show their literal status.
  if (state.isFrozen) return state.status;
  // Without a full graph we can't prove the run has no pending tasks —
  // forward nodes (the "more work is coming" signal) are only present
  // when graphFidelity === 'full'. Defer to the run-level status.
  if (state.graphFidelity !== 'full') return state.status;
  // Any not-yet-claimed forward node means more work is coming.
  if (rows.some((r) => r.forward)) return state.status;
  const recorded = rows.filter((r) => !r.forward && r.task).map((r) => r.task!);
  if (recorded.length === 0) return state.status;
  const allSettled = recorded.every((t) => TERMINAL_TASK_STATUSES.has(t.status));
  if (!allSettled) return state.status;
  const anyFailed = recorded.some((t) => FAILED_TASK_STATUSES.has(t.status));
  return anyFailed ? 'failed' : 'completed';
}

/**
 * Detects whether a skipped task was actually a rejected human approval.
 * A rejected approval has a summary containing "Rejected via" (the rejection
 * origin), while downstream skipped tasks contain "upstream approval rejected".
 */
export function isTaskRejectedApproval(task: { status: string; summary?: string }): boolean {
  if (task.status !== 'skipped') return false;
  if (!task.summary) return false;
  // Rejected approval: the task itself was rejected via workflow.run.resume
  const summary = task.summary.toLowerCase();
  return summary.includes('rejected via workflow.run.resume');
}

/** Task-level status → design-system `TimelineItemStatus` (5-state palette). */
export function taskTimelineStatus(status: WorkflowSurfaceTaskStatus): TimelineItemStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'blocked':
      // Dependency-held — render like forward-DAG "Queued" (neutral dot), not
      // the warning pause marker (many blocked rows after a failure is noisy).
      return 'default';
    case 'scheduled':
    case 'skipped':
      return 'default';
  }
}

/**
 * Abstract status-orb vocabulary (see `apps/web/public/orb-*.svg`).
 * Motion/color carry state — no anthropomorphic face.
 */
export type OrbKind =
  'running' | 'paused' | 'completed' | 'failed' | 'inert' | 'idle' | 'searching';

/** Run-level status → orb. Soft-quiesce still reports `running` upstream. */
export function orbForRunStatus(status: WorkflowSurfaceRunStatus): OrbKind {
  switch (status) {
    case 'running':
    case 'in_flight':
      return 'running';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'skipped':
      return 'inert';
  }
}

/**
 * Task-level status → orb. Stalled running tasks surface as `failed` (unexpected
 * silence); dependency-held `blocked` / `scheduled` / `skipped` are inert.
 */
export function orbForTaskStatus(
  status: WorkflowSurfaceTaskStatus,
  opts?: { stalled?: boolean },
): OrbKind {
  if (opts?.stalled && status === 'running') return 'failed';
  switch (status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'blocked':
    case 'scheduled':
    case 'skipped':
      return 'inert';
  }
}

/** Task-level status → human label shown in the `<TimelineItem time>` slot. */
export function taskTimeLabel(
  task: WorkflowSurfaceTaskState,
  nowMs: number,
  stalled: boolean,
): string {
  if (stalled) return 'Stalled';
  switch (task.status) {
    case 'scheduled':
      return 'Scheduled';
    case 'blocked':
      return 'Blocked';
    case 'paused':
      return 'Paused';
    case 'running': {
      const elapsed = formatDuration(task.startedAt, nowMs);
      return elapsed ? `Running · ${elapsed}` : 'Running';
    }
    case 'succeeded': {
      const dur = formatDurationFromTimestamps(task.startedAt, task.completedAt);
      return dur ? `Done · ${dur}` : 'Done';
    }
    case 'failed': {
      const dur = formatDurationFromTimestamps(task.startedAt, task.completedAt);
      return dur ? `Failed · ${dur}` : 'Failed';
    }
    case 'cancelled':
      return 'Cancelled';
    case 'skipped':
      // Distinguish rejected approvals from genuinely skipped tasks
      return isTaskRejectedApproval(task) ? 'Rejected' : 'Skipped';
  }
}

/** Ledger summaries look like `tasks.x.output.y == 'z' evaluated to false`. */
export function compactSkipReason(summary: string): string {
  let s = summary.replace(/^skipped[\s:—–-]*/i, '').trim();
  s = s.replace(/\s+evaluated to (?:false|true)\s*$/i, '');
  // anyOf [a; b] → a or b (match ConditionLine join style)
  const anyOf = /^anyOf\s*\[(.*)\]\s*$/i.exec(s);
  if (anyOf?.[1]) {
    s = anyOf[1]
      .split(';')
      .map((c) => c.trim().replace(/^tasks\./, ''))
      .filter(Boolean)
      .join(' or ');
  } else {
    s = s.replace(/^tasks\./, '');
  }
  return s;
}

/**
 * Whether a running task reads as `Stalled` (Plan 229 §5.6). The distinction is
 * "long-running, actively streaming" vs "silent past the watchdog deadline":
 * `lastMutatedAtMs` is refreshed by every `WorkflowTaskActivity` (the coding lane's
 * proof-of-progress heartbeat fires every ~20s ≪ this threshold), so an op that is
 * advancing — even through a multi-minute Bash command or extended thinking — keeps
 * this false. It flips true only after genuine silence past `STALLED_THRESHOLD_MS`,
 * which is the real "the executor went away" case the step-stall watchdog reaps.
 * Only `running` tasks can stall; a settled task is never stalled.
 *
 * A harness step is the case the progress stream alone gets wrong: its feed is
 * the thing that moves, and a row reading progress events only labelled a step
 * with fifty-seven tool calls on screen `Stalled`. So a feed that wrote
 * something inside the threshold answers for the task, and a task with no feed
 * keeps the progress-only rule.
 */
export function isTaskStalled(
  task: Pick<WorkflowSurfaceTaskState, 'status' | 'lastMutatedAtMs'>,
  nowMs: number,
  feedLastActivityAtMs?: number,
): boolean {
  if (task.status !== 'running') return false;
  if (feedLastActivityAtMs !== undefined && nowMs - feedLastActivityAtMs <= STALLED_THRESHOLD_MS) {
    return false;
  }
  return nowMs - task.lastMutatedAtMs > STALLED_THRESHOLD_MS;
}

/**
 * When the task's harness feed last grew, if this surface holds one.
 *
 * Structurally typed over the fold's entries rather than importing them: the
 * one fact wanted here is a millisecond, and a surface that mounts no reducer
 * passes an empty map and gets `undefined`, which is the progress-only rule.
 */
export function harnessFeedLastActivityMs(
  feeds: Record<string, { lastActivityAtMs: number }>,
  task: Pick<WorkflowSurfaceTaskState, 'taskType' | 'workerSessionId'>,
): number | undefined {
  const stepId = harnessFeedStepId(task);
  if (stepId === undefined) return undefined;
  return feeds[stepId]?.lastActivityAtMs;
}

/**
 * The step a task row reads its live feed under, when it has one.
 *
 * The feed is keyed by the step that wrote it. An operation task has no worker
 * session of its own, so the run records its step execution in that column —
 * which is the key the harness card needs. An agent task's `workerSessionId` is
 * a real session: its steps stream under their own ids and none of them is this
 * row.
 */
export function harnessFeedStepId(
  task: Pick<WorkflowSurfaceTaskState, 'taskType' | 'workerSessionId'>,
): string | undefined {
  return task.taskType === 'agent' ? undefined : task.workerSessionId;
}

export function runningStepCount(task: WorkflowSurfaceTaskState): number | null {
  if (task.taskType !== 'agent') return null;
  if (task.status !== 'running') return null;
  const n = task.activeOpSequence;
  return typeof n === 'number' && n > 0 ? n : null;
}

export function formatDurationFromTimestamps(
  startedAt: string | undefined,
  completedAt: string | undefined,
): string {
  if (!startedAt || !completedAt) return '';
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  return formatMs(Math.max(0, end - start));
}

function formatDuration(startedAt: string | undefined, endMs: number): string {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '';
  return formatMs(Math.max(0, endMs - start));
}

function formatMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  return `${String(mins)}m ${String(remSec).padStart(2, '0')}s`;
}

/**
 * Topological sort that combines recorded tasks with forward-DAG nodes
 * from `workflowGraph`. Mirrors `topoSortTasks` in the spine. Defensive
 * against cycles: anything left after the topo pass is appended in
 * original order so a malformed graph never drops rows.
 */
export function topoSortRows(
  recorded: WorkflowSurfaceTaskState[],
  graph: WorkflowSurfaceGraph | undefined,
): TimelineRow[] {
  const hintByTaskId = new Map(
    (graph?.taskHints ?? []).map((hint) => [hint.taskId, hint] as const),
  );
  const rows = new Map<string, TimelineRow>();
  for (const t of recorded) {
    rows.set(t.taskId, {
      taskId: t.taskId,
      label: t.label,
      forward: false,
      task: t,
      dependsOn: [],
    });
  }

  if (graph) {
    const depsByTask = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const list = depsByTask.get(edge.to) ?? [];
      list.push(edge.from);
      depsByTask.set(edge.to, list);
    }
    // Backfill dependsOn + when for recorded rows from the graph (we don't
    // serialize edges or guards into reducer state otherwise).
    for (const row of rows.values()) {
      const deps = depsByTask.get(row.taskId);
      if (deps) row.dependsOn = deps;
      const when = hintByTaskId.get(row.taskId)?.when;
      if (when) row.when = when;
    }
    for (const taskId of graph.taskIds) {
      if (rows.has(taskId)) continue;
      const hint = hintByTaskId.get(taskId);
      rows.set(taskId, {
        taskId,
        label: hint?.label ?? taskId,
        forward: true,
        task: undefined,
        dependsOn: depsByTask.get(taskId) ?? [],
        ...(hint?.taskType ? { taskType: hint.taskType } : {}),
        ...(hint?.humanIntent ? { humanIntent: hint.humanIntent } : {}),
        ...(hint?.operationId ? { operationId: hint.operationId } : {}),
        ...(hint?.when ? { when: hint.when } : {}),
      });
    }
  }

  const all = [...rows.values()];
  const present = new Set(rows.keys());
  const inDegree = new Map<string, number>();
  for (const r of all) {
    inDegree.set(r.taskId, r.dependsOn.filter((d) => present.has(d)).length);
  }

  const queue: TimelineRow[] = [];
  for (const r of all) {
    if ((inDegree.get(r.taskId) ?? 0) === 0) queue.push(r);
  }

  const sorted: TimelineRow[] = [];
  const sortedIds = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (sortedIds.has(cur.taskId)) continue;
    sorted.push(cur);
    sortedIds.add(cur.taskId);
    for (const r of all) {
      if (sortedIds.has(r.taskId)) continue;
      if (r.dependsOn.includes(cur.taskId)) {
        const next = (inDegree.get(r.taskId) ?? 1) - 1;
        inDegree.set(r.taskId, next);
        if (next === 0) queue.push(r);
      }
    }
  }

  // Cycle defense — append anything left in original (insertion) order.
  if (sorted.length < all.length) {
    for (const r of all) {
      if (!sortedIds.has(r.taskId)) sorted.push(r);
    }
  }

  return sorted;
}

// =============================================================================

export type SpaceRole = 'admin' | 'editor' | 'viewer' | null;

export interface RunControlVisibility {
  /** Write actions are permitted at all (role + live + non-terminal). */
  canManage: boolean;
  showPause: boolean;
  showRunLevelResume: boolean;
  showCancel: boolean;
  /** Soft-quiesce window: paused at the run level but a task is still finishing. */
  pausing: boolean;
}

export function deriveRunControlVisibility(args: {
  /** Authoritative ledger status (`state.status`). */
  status: WorkflowSurfaceRunStatus;
  /** Reconciled display status (`deriveEffectiveRunStatus`). */
  effectiveStatus: WorkflowSurfaceRunStatus;
  /** Pause cause (`state.pausedReason`) — gates the run-level acknowledge Resume. */
  pausedReason: string | undefined;
  isFrozen: boolean;
  tasks: Record<string, Pick<WorkflowSurfaceTaskState, 'status' | 'humanIntent'>>;
  role: SpaceRole;
}): RunControlVisibility {
  const canWrite = args.role === 'admin' || args.role === 'editor';
  const isRunning = args.effectiveStatus === 'running' || args.effectiveStatus === 'in_flight';
  const isPaused = args.effectiveStatus === 'paused';
  const canManage = canWrite && !args.isFrozen && (isRunning || isPaused);

  const taskList = Object.values(args.tasks);
  const hasPendingHumanTask = taskList.some((t) => t.status === 'paused' && t.humanIntent);
  const pausing = args.status === 'paused' && taskList.some((t) => t.status === 'running');

  return {
    canManage,
    showPause: canManage && isRunning,
    showRunLevelResume:
      canManage && isPaused && args.pausedReason === 'manual' && !hasPendingHumanTask,
    showCancel: canManage,
    pausing,
  };
}
