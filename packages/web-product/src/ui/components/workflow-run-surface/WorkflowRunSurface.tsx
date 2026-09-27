'use client';

import { useCallback, useMemo } from 'react';
import {
  AnimatedHeight,
  Row,
  Spinner,
  Text,
  Icon,
  Timeline,
  TimelineItem,
} from '@aflow/design-system';
import type { WorkflowRunSurfaceState } from '../../lib/types.js';
import { resolveTaskIcon } from '../../lib/op-labels.js';
import { useWorkflowRunRehydration } from './useWorkflowRunRehydration.js';
import { useWorkflowRunUsageRefresh } from './useWorkflowRunUsageRefresh.js';
import { fetchWorkflowRunSurfaceState } from './workflowRunDetailToState.js';
import { useNowTicker } from './useNowTicker.js';
import {
  deriveEffectiveRunStatus,
  FAILED_TASK_STATUSES,
  formatDurationFromTimestamps,
  harnessFeedLastActivityMs,
  IN_FLIGHT_TASK_STATUSES,
  isTaskStalled,
  orbForRunStatus,
  orbForTaskStatus,
  runningStepCount,
  runPill,
  taskTimelineStatus,
  taskTimeLabel,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  topoSortRows,
} from './workflowRunSurfaceHelpers.js';
import {
  ActivitySubline,
  AttemptBadge,
  ConditionLine,
  FailureLine,
  HumanDecisionLine,
  OpenRunnerLink,
  Pill,
  RunOutputSection,
  RunSummary,
  SkipReasonLine,
  SummaryLine,
  TaskStatsLine,
} from './WorkflowRunSurfaceParts.js';
import { useHarnessActivityFeeds } from '../harness-activity-card.js';
import { PausedHumanTaskRow } from './PausedHumanTaskRow.js';
import { PauseExplanation } from './PauseExplanation.js';
import { TaskExecutionDetails } from './TaskExecutionDetails.js';
import { WorkflowRunControls } from './WorkflowRunControls.js';
import { StatusOrb } from './StatusOrb.js';
import { useWorkflowRunPauseRefresh } from './useWorkflowRunPauseRefresh.js';
import './workflow-run-surface.css';

interface WorkflowRunSurfaceProps {
  runId: string;
  /** Rich state from `RunViewState.workflowRuns[runId]`. */
  state: WorkflowRunSurfaceState | undefined;
  spaceId?: string | null;
  onHydrate?: ((state: WorkflowRunSurfaceState) => void) | undefined;
  sseConnected?: boolean | undefined;
  showOpenFullRun?: boolean;
  selfHydrate?: boolean;
  onStaleRun?: (runId: string) => void;
}

export function WorkflowRunSurface({
  runId,
  state,
  spaceId,
  onHydrate,
  sseConnected,
  showOpenFullRun,
  selfHydrate = true,
  onStaleRun,
}: WorkflowRunSurfaceProps) {
  useWorkflowRunRehydration({
    runId,
    enabled: selfHydrate,
    state,
    spaceId: spaceId ?? null,
    onHydrate: onHydrate ?? (() => {}),
  });

  const refreshUsage = useCallback(() => {
    if (!spaceId) return;
    void (async () => {
      const next = await fetchWorkflowRunSurfaceState(spaceId, runId, Date.now());
      if (next) onHydrate?.(next);
    })();
  }, [spaceId, runId, onHydrate]);
  useWorkflowRunUsageRefresh({ enabled: selfHydrate, state, onRefresh: refreshUsage });
  useWorkflowRunPauseRefresh({ enabled: selfHydrate, state, onRefresh: refreshUsage });

  const orderedRows = useMemo(() => {
    if (!state) return [];
    const recordedTasks = Object.values(state.tasks).sort((a, b) => {
      const aStart = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
      const bStart = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
      if (aStart !== bStart) return aStart - bStart;
      return a.taskId.localeCompare(b.taskId);
    });
    const useGraph = state.graphFidelity === 'full' && state.workflowGraph;
    return topoSortRows(recordedTasks, useGraph ? state.workflowGraph : undefined);
  }, [state]);

  // Read once for the whole timeline: a row cannot call a hook of its own, and
  // a harness step's feed is what says whether the task is silent (gap 29).
  const harnessFeeds = useHarnessActivityFeeds();

  const hasInFlight =
    state !== undefined &&
    !state.isFrozen &&
    orderedRows.some((r) => r.task && IN_FLIGHT_TASK_STATUSES.has(r.task.status));
  const nowMs = useNowTicker(hasInFlight);

  const totalRows = orderedRows.length;
  const doneRows = orderedRows.filter(
    (r) => r.task && TERMINAL_TASK_STATUSES.has(r.task.status),
  ).length;
  const inFlightRows = orderedRows.filter(
    (r) => r.task && IN_FLIGHT_TASK_STATUSES.has(r.task.status),
  ).length;
  const failedRows = orderedRows.filter(
    (r) => r.task && FAILED_TASK_STATUSES.has(r.task.status),
  ).length;
  // Exclude skipped tasks from progress so the green timeline line stops
  // before any skipped branch (no progress was made through that branch).
  const doneRowsForProgress = orderedRows.filter(
    (r) =>
      r.task &&
      (r.task.status === 'succeeded' ||
        r.task.status === 'failed' ||
        r.task.status === 'cancelled'),
  ).length;
  const progress = totalRows > 0 ? (doneRowsForProgress + inFlightRows * 0.5) / totalRows : 0;

  // Loading skeleton: a mount happened but no live event or BFF
  // hydration has arrived yet.
  if (!state) {
    return (
      <div className="workflow-run-surface workflow-run-surface--loading">
        <Row gap="2" align="center">
          <Spinner size="sm" />
          <Text variant="muted" size="sm">
            Loading workflow run {runId.slice(0, 8)}…
          </Text>
        </Row>
      </div>
    );
  }

  // Reconcile the lagging run-level status with the task graph so a
  // fully-settled run doesn't read "executing" while the terminal
  // WorkflowRunUpdate is still in flight.
  const effectiveStatus = deriveEffectiveRunStatus(state, orderedRows);
  const completed = TERMINAL_RUN_STATUSES.has(effectiveStatus);
  const pill = runPill(effectiveStatus);
  const title = state.workflowTitle ?? state.slug;

  return (
    <div
      data-run-id={runId}
      data-frozen={state.isFrozen ? 'true' : 'false'}
      className={`workflow-run-surface ds-enter-rise${completed ? ' workflow-run-surface--completed' : ''}`}
    >
      {/* Header — same shape as the spine's SkillClusterCard header. */}
      <div className="workflow-run-surface__header">
        <div className="workflow-run-surface__title-row">
          <StatusOrb
            kind={orbForRunStatus(effectiveStatus)}
            size={76}
            className="workflow-run-surface__orb--header"
            decorative={false}
            label={`Run ${pill.label}`}
          />
          <span className="workflow-run-surface__label">Skill</span>
          <span className="workflow-run-surface__sep">|</span>
          <span className="workflow-run-surface__title" title={title}>
            {title}
          </span>
        </div>
        <div className="workflow-run-surface__meta-row">
          {totalRows > 0 && (
            <RunSummary
              done={doneRows}
              total={totalRows}
              failed={failedRows}
              durationLabel={
                completed
                  ? formatDurationFromTimestamps(state.startedAt, state.completedAt)
                  : undefined
              }
            />
          )}
          {sseConnected === false && !state.isFrozen && (
            <Pill label="reconnecting…" tone="warning" />
          )}
          {state.graphFidelity === 'degraded' && (
            <Pill
              label="drift"
              tone="warning"
              title="Workflow definition changed since this run — showing recorded tasks only."
            />
          )}
          <Pill label={pill.label} tone={pill.tone} />
        </div>
      </div>

      {/* Body — design-system Timeline of task markers. Forward-DAG
          rows from the workflow definition show as outlined-neutral
          markers (`status: 'default'`) so the user sees what's coming.
          <AnimatedHeight> makes the whole card grow/shrink gradually as
          rows materialise, sublines come and go, and the hydration
          spinner swaps for the real timeline. */}
      <AnimatedHeight>
        {orderedRows.length === 0 ? (
          state.needsHydration || !state.isFrozen ? (
            <Row gap="2" align="center" style={{ padding: '12px' }}>
              <Spinner size="sm" />
              <Text variant="muted" size="xs">
                Loading tasks…
              </Text>
            </Row>
          ) : (
            <div
              style={{
                padding: '12px',
                fontSize: 11,
                fontStyle: 'italic',
                color: 'var(--color-text-muted)',
              }}
            >
              no tasks recorded
            </div>
          )
        ) : (
          <div style={{ padding: '8px 12px 12px 12px' }}>
            <Timeline progress={progress} active={hasInFlight}>
              {orderedRows.map((row) => {
                if (row.forward) {
                  // Forward-DAG node — no recorded state yet. Render as
                  // outlined neutral marker with definition-sourced label
                  // and icon when the BFF graph carries task hints.
                  return (
                    <TimelineItem
                      key={row.taskId}
                      title={row.label}
                      // Forward-DAG node not yet started. The timeline order
                      // already conveys what comes after what, so a bare
                      // "Queued" reads cleaner than the prior "waiting on N"
                      // (which looked like a step count, not a dependency count).
                      time="Queued"
                      status="default"
                      timeAlign="end"
                      markerIcon={<StatusOrb kind="inert" size={48} />}
                      titleIcon={
                        <Icon
                          name={resolveTaskIcon({
                            ...(row.taskType ? { taskType: row.taskType } : {}),
                            ...(row.humanIntent ? { humanIntent: row.humanIntent } : {}),
                            ...(row.operationId ? { operationId: row.operationId } : {}),
                          })}
                          size="md"
                        />
                      }
                    >
                      {row.when && <ConditionLine when={row.when} variant="potential" />}
                    </TimelineItem>
                  );
                }
                const task = row.task!;
                const stalled = isTaskStalled(
                  task,
                  nowMs,
                  harnessFeedLastActivityMs(harnessFeeds, task),
                );
                const isFailed = task.status === 'failed' || task.status === 'cancelled';
                const isTerminal = TERMINAL_TASK_STATUSES.has(task.status);
                // Live step counter — folded into the time slot (no extra line)
                // for running agent rows only. See `runningStepCount`.
                const steps = runningStepCount(task);
                const timeLabel =
                  steps !== null
                    ? `${taskTimeLabel(task, nowMs, stalled)} · ${steps} ${steps === 1 ? 'step' : 'steps'}`
                    : taskTimeLabel(task, nowMs, stalled);
                return (
                  <TimelineItem
                    key={task.taskId}
                    title={task.label}
                    time={timeLabel}
                    status={taskTimelineStatus(task.status)}
                    timeAlign="end"
                    markerIcon={
                      <StatusOrb kind={orbForTaskStatus(task.status, { stalled })} size={48} />
                    }
                    // Branch not taken — fade the whole row so the executed
                    // path carries the visual weight.
                    {...(task.status === 'skipped'
                      ? { className: 'workflow-run-surface__row--skipped' }
                      : {})}
                    titleIcon={
                      <Icon
                        name={resolveTaskIcon({
                          ...(task.taskType ? { taskType: task.taskType } : {}),
                          ...(task.humanIntent ? { humanIntent: task.humanIntent } : {}),
                          ...(task.operationId ? { operationId: task.operationId } : {}),
                        })}
                        size="md"
                      />
                    }
                  >
                    {/* Guard trace — `potential` until the scheduler evaluates
                        it, `met` once the row was dispatched (the taken branch).
                        Skipped rows get the recorded reason instead; cancelled
                        rows stay silent (the guard may never have evaluated). */}
                    {row.when && task.status !== 'skipped' && task.status !== 'cancelled' && (
                      <ConditionLine
                        when={row.when}
                        variant={
                          task.status === 'scheduled' || task.status === 'blocked'
                            ? 'potential'
                            : 'met'
                        }
                      />
                    )}
                    {task.status === 'skipped' && !task.humanDecision && (
                      <SkipReasonLine task={task} {...(row.when ? { when: row.when } : {})} />
                    )}
                    {task.attempt > 1 && <AttemptBadge attempt={task.attempt} />}
                    {isFailed && <FailureLine task={task} />}
                    {task.humanDecision && <HumanDecisionLine task={task} />}
                    {/* Agent task's output summary — on succeeded AND failed
                      (work may have happened before a failure). Other families
                      stay minimal. */}
                    {isTerminal && task.taskType === 'agent' && task.summary && (
                      <SummaryLine summary={task.summary} />
                    )}
                    {isTerminal && task.taskType === 'agent' && <TaskStatsLine task={task} />}
                    {task.status === 'running' && <ActivitySubline task={task} nowMs={nowMs} />}
                    {task.status === 'paused' && task.humanIntent && spaceId && (
                      <PausedHumanTaskRow
                        runId={runId}
                        spaceId={spaceId}
                        task={task}
                        runPauseVersion={state.pauseVersion}
                      />
                    )}
                    {/* Non-human pause (contract violation, transient error,
                        needs-credentials, retry-budget, manual…). The human
                        approve/collect rows are handled above; this surfaces
                        the cause + resume prompt the agent/operation pauses
                        previously showed as a blank row. */}
                    {task.status === 'paused' && !task.humanIntent && (
                      <PauseExplanation
                        contract={
                          state.resumeContract &&
                          (state.resumeContract.failedTaskId === undefined ||
                            state.resumeContract.failedTaskId === task.taskId)
                            ? state.resumeContract
                            : undefined
                        }
                        pausedReason={state.pausedReason}
                      />
                    )}
                    {task.taskType === 'operation' &&
                      (task.inputRef ?? task.outputRef ?? task.errorRef) && (
                        <TaskExecutionDetails task={task} />
                      )}
                    {/* Agent tasks only: operation/human tasks carry a
                        synthetic workerSessionId (the step-execution id) —
                        no Runner session exists to open. */}
                    {task.taskType === 'agent' && task.workerSessionId && (
                      <OpenRunnerLink workerSessionId={task.workerSessionId} />
                    )}
                  </TimelineItem>
                );
              })}
            </Timeline>
          </div>
        )}
      </AnimatedHeight>

      {/* First-class run output — live promoted values mid-run; score /
          outcome checks / closing summary once terminal. Self-gates on
          having anything to show. */}
      <RunOutputSection outputs={state.outputs} result={state.result} completed={completed} />

      {spaceId && (
        <WorkflowRunControls
          runId={runId}
          spaceId={spaceId}
          state={state}
          effectiveStatus={effectiveStatus}
          {...(showOpenFullRun ? { showOpenFullRun: true } : {})}
          {...(onStaleRun ? { onStaleRun } : {})}
        />
      )}
    </div>
  );
}
