'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Icon, Row, Text } from '@aflow/design-system';
import type { WorkflowRunResumeInput } from '@aflow/schemas';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { useSpace } from '../providers.js';
import { spaceRoute } from '../../lib/space-routes.js';
import type { WorkflowRunSurfaceState, WorkflowSurfaceRunStatus } from '../../lib/types.js';
import { deriveRunControlVisibility } from './workflowRunSurfaceHelpers.js';

type ResumeBody = Omit<WorkflowRunResumeInput, 'runId'>;

interface WorkflowRunControlsProps {
  runId: string;
  spaceId: string;
  state: WorkflowRunSurfaceState;
  /** Reconciled run status from `deriveEffectiveRunStatus`. */
  effectiveStatus: WorkflowSurfaceRunStatus;
  showOpenFullRun?: boolean;
  onStaleRun?: (runId: string) => void;
}

export function WorkflowRunControls({
  runId,
  spaceId,
  state,
  effectiveStatus,
  showOpenFullRun,
  onStaleRun,
}: WorkflowRunControlsProps) {
  const { activeSpace, spaces } = useSpace();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [guidance, setGuidance] = useState('');

  const isInterruptPause = state.allowedResumeModes?.includes('re_execute') ?? false;

  // Resolve the run's space role from the space list (falls back to the
  // active space — in chat the surface always renders the active space's run).
  const role = (spaces.find((s) => s.id === spaceId) ?? activeSpace)?.myRole ?? null;

  // Any control outcome (success OR a terminal-state rejection) may mean our
  // snapshot of the run is stale — refetch the standalone container's detail
  // query so the card self-corrects (e.g. a run cancelled out-of-band by
  // Helmsman that the live tail missed). Harmless for the chat mount, which
  // has no such query (it folds SSE instead).
  const refreshRunDetail = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'workflow-run', runId] });
  }, [queryClient, spaceId, runId]);

  const pauseMutation = useApiMutation<{ reason?: string }, { runId: string }>({
    path: `/spaces/${spaceId}/workflow-runs/${runId}/pause`,
    spaceId,
    method: 'POST',
    onSuccess: refreshRunDetail,
  });
  const cancelMutation = useApiMutation<{ reason?: string }, { runId: string }>({
    path: `/spaces/${spaceId}/workflow-runs/${runId}/cancel`,
    spaceId,
    method: 'POST',
    onSuccess: refreshRunDetail,
  });
  const resumeMutation = useApiMutation<ResumeBody, { runId: string }>({
    path: `/spaces/${spaceId}/workflow-runs/${runId}/resume`,
    spaceId,
    method: 'POST',
    onSuccess: refreshRunDetail,
  });

  const busy = pauseMutation.isPending || cancelMutation.isPending || resumeMutation.isPending;

  // Surface the most recent control failure. A 404/409 means the run already
  // moved on (finished / cancelled / no longer running) — tell the operator
  // and refetch so the card corrects instead of silently doing nothing.
  const lastError = pauseMutation.error ?? cancelMutation.error ?? resumeMutation.error;
  const isModeStale =
    resumeMutation.error?.status === 400 &&
    (resumeMutation.error.body as { error?: string } | null | undefined)?.error ===
      'RESOLUTION_MODE_NOT_ALLOWED';
  const isStaleError = lastError?.status === 404 || lastError?.status === 409 || isModeStale;

  // Refetch the detail when a stale-state error lands (once per error, in an
  // effect — never during render). The query invalidation is the standalone
  // container's path; the chat mount has no such query, so it instead forces
  useEffect(() => {
    if (isStaleError) {
      refreshRunDetail();
      onStaleRun?.(runId);
    }
  }, [isStaleError, lastError, refreshRunDetail, onStaleRun, runId]);

  const onPause = useCallback(() => {
    pauseMutation.mutate({});
  }, [pauseMutation]);
  const onResume = useCallback(() => {
    const trimmed = guidance.trim();
    resumeMutation.mutate({
      pauseVersion: state.pauseVersion,
      resolution: isInterruptPause
        ? { mode: 're_execute', ...(trimmed ? { instructions: trimmed } : {}) }
        : { mode: 'acknowledge' },
      takeOver: false,
    });
  }, [resumeMutation, state.pauseVersion, isInterruptPause, guidance]);
  const onCancel = useCallback(() => {
    cancelMutation.mutate({});
    setConfirmCancel(false);
  }, [cancelMutation]);

  const { canManage, showPause, showRunLevelResume, showCancel, pausing } =
    deriveRunControlVisibility({
      status: state.status,
      effectiveStatus,
      pausedReason: state.pausedReason,
      isFrozen: state.isFrozen,
      tasks: state.tasks,
      role,
    });

  const fullRunHref =
    showOpenFullRun && activeSpace?.slug ? spaceRoute(activeSpace.slug, `/runs/${runId}`) : null;

  // Write controls are hidden on frozen / historical snapshots (§2.3) and on
  // terminal runs (nothing running/paused to act on). "Open full run" is pure
  // navigation and stays available regardless.
  if (!canManage && !fullRunHref && !lastError) return null;

  return (
    <div className="workflow-run-surface__controls">
      <Row gap="2" align="center" wrap>
        {showPause && (
          <Button
            variant="secondary"
            size="sm"
            loading={pauseMutation.isPending}
            disabled={busy}
            onClick={onPause}
          >
            <Icon name="pause" size="sm" /> Pause
          </Button>
        )}

        {showRunLevelResume && (
          <>
            {isInterruptPause && (
              <input
                type="text"
                value={guidance}
                onChange={(e) => {
                  setGuidance(e.target.value);
                }}
                placeholder="Optional guidance for the restart…"
                maxLength={2000}
                disabled={busy}
                style={{
                  flex: '1 1 220px',
                  minWidth: 160,
                  padding: '4px 8px',
                  fontSize: 'var(--font-size-xs)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                  background: 'var(--color-surface-1)',
                }}
              />
            )}
            <Button
              variant="primary"
              size="sm"
              loading={resumeMutation.isPending}
              disabled={busy}
              onClick={onResume}
            >
              <Icon name="play" size="sm" />{' '}
              {pausing ? 'Cancel pause' : isInterruptPause ? 'Restart task' : 'Resume'}
            </Button>
          </>
        )}

        {showCancel &&
          (confirmCancel ? (
            <Row gap="1" align="center">
              <Button
                variant="danger"
                size="sm"
                loading={cancelMutation.isPending}
                disabled={busy}
                onClick={onCancel}
              >
                Confirm cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirmCancel(false);
                }}
              >
                Keep running
              </Button>
            </Row>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              <Icon name="x" size="sm" /> Cancel
            </Button>
          ))}

        {canManage && pausing && (
          <Text size="xs" variant="muted" style={{ fontStyle: 'italic' }}>
            This task can&apos;t be safely interrupted — finishing it first. Cancel to stop now.
          </Text>
        )}

        {fullRunHref && (
          <a
            href={fullRunHref}
            target="_blank"
            rel="noopener noreferrer"
            className="workflow-run-surface__open-full"
            title="Open the full run-management page in a new tab"
          >
            Open full run
            <Icon name="arrow-square-out" size="xs" />
          </a>
        )}
      </Row>

      {lastError && (
        <Text
          size="xs"
          style={{ marginTop: 'var(--space-1)', color: 'var(--color-status-failed)' }}
        >
          {isModeStale
            ? 'Refreshing resume options — please try again.'
            : isStaleError
              ? 'This run already moved on (finished, cancelled, or no longer running). Refreshing…'
              : `Couldn't complete that action: ${lastError.message}`}
        </Text>
      )}
    </div>
  );
}
