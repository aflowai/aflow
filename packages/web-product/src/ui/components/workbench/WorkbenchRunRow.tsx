'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatedHeight, Badge, Icon, Text, WorkflowRunStatusBadge } from '@aflow/design-system';

import { WorkflowRunSurfaceContainer } from '../workflow-run-surface/index.js';
import type { SpaceWorkflowRunSummary } from '../../hooks/use-space-workflow-runs.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { useCurrentUser } from '../user-avatar.js';
import { formatUnread } from '../../hooks/use-room-activity.js';
import { spaceRoute } from '../../lib/space-routes.js';

/**
 * A single run row that expands to the self-hydrating `WorkflowRunSurface` (the
 * same live card + pause/resume/cancel the chat uses). Used under each skill in
 * the Workbench. When `skillName` is omitted the row leads with the run's
 * status (the skill is already the parent).
 */
export function WorkbenchRunRow({
  run,
  spaceId,
  spaceSlug,
  skillName,
  unreadInRoom = 0,
  waitingOn,
  onRevealChat,
}: {
  run: SpaceWorkflowRunSummary;
  spaceId: string;
  spaceSlug?: string;
  skillName?: string;
  /** Messages said in this run's room that the reader has not seen. */
  unreadInRoom?: number;
  /** Who the run's open request is waiting on, when it names anyone. */
  waitingOn?: string | undefined;
  onRevealChat?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();
  const currentUser = useCurrentUser();
  const personFor = useSpacePeople(spaceId);

  // Who set this off, said only when it was not you — in a space where you
  // are the only one starting runs, your own name on every row says nothing.
  const initiator =
    run.initiatedByUserId && run.initiatedByUserId !== currentUser?.userId
      ? (personFor(run.initiatedByUserId)?.displayName ?? 'Someone else')
      : null;

  // The room this run is steered from. A run and its conversation are one
  // piece of work seen from two sides, and the Workbench is where you pick
  // which side to open.
  const roomId = run.sessionId ?? run.rootSessionId;

  return (
    <div
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-2)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => {
          setExpanded((e) => !e);
        }}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          width: '100%',
          padding: 'var(--space-1) var(--space-2)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--color-text-primary)',
        }}
      >
        <Icon
          name="caret-right"
          size="xs"
          style={{
            flexShrink: 0,
            color: 'var(--color-content-muted)',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition:
              'transform var(--transition-duration-fast) var(--transition-timing-default)',
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {skillName ? (
            <Text size="sm" weight="medium" truncate>
              {skillName}
            </Text>
          ) : (
            <Text size="xs" variant="muted" truncate>
              {run.pausedReason && run.status === 'paused'
                ? humanizePauseReason(run.pausedReason)
                : formatAgo(run.startedAt)}
            </Text>
          )}
        </div>
        {initiator && (
          <Text size="xs" variant="muted">
            {initiator}
          </Text>
        )}
        {waitingOn && run.status === 'paused' && (
          <Text size="xs" style={{ color: 'var(--color-warning-default)', flexShrink: 0 }}>
            Waiting on {waitingOn}
          </Text>
        )}
        {run.evalScore !== null && (
          <Text size="xs" variant="muted">
            {(run.evalScore * 100).toFixed(0)}%
          </Text>
        )}
        {skillName && (
          <Text size="xs" variant="muted">
            {formatAgo(run.startedAt)}
          </Text>
        )}
        <WorkflowRunStatusBadge status={run.status} iconOnly />
      </button>
      {roomId && spaceSlug ? (
        <button
          type="button"
          onClick={() => {
            onRevealChat?.();
            router.push(spaceRoute(spaceSlug, `/chat?session=${encodeURIComponent(roomId)}`));
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            width: '100%',
            padding: '0 var(--space-2) var(--space-1) var(--space-5)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            color: 'var(--color-content-muted)',
          }}
        >
          <Icon name="chat-dots" size="xs" />
          {/* News about a run is news in its room — there is no second log to
              read, so the count belongs on the door into the one that exists. */}
          <Text size="xs" variant="muted">
            Open the room steering this run
          </Text>
          {unreadInRoom > 0 ? (
            <Badge variant="accent" aria-label={`${formatUnread(unreadInRoom)} unread`}>
              {formatUnread(unreadInRoom)}
            </Badge>
          ) : null}
        </button>
      ) : null}
      <AnimatedHeight>
        {expanded ? (
          <div style={{ padding: '0 var(--space-1) var(--space-2)' }}>
            <WorkflowRunSurfaceContainer runId={run.runId} spaceId={spaceId} />
          </div>
        ) : null}
      </AnimatedHeight>
    </div>
  );
}

const PAUSE_REASON_LABELS: Record<string, string> = {
  needs_credentials: 'Needs credentials',
  needs_decision: 'Needs a decision',
  needs_capability: 'Needs a capability',
  task_contract_violation: 'Task contract violation',
  retry_budget_exceeded: 'Retry budget exceeded',
  transient_error: 'Transient error',
  subagent_handoff: 'Sub-agent handoff',
  needs_oauth_consent: 'Needs a connection',
  manual: 'Paused by operator',
  task_paused: 'Paused on a task',
};

/** Turn a raw pause-reason enum (e.g. `task_paused`) into readable text. */
export function humanizePauseReason(reason: string): string {
  const s = reason.toLowerCase();
  return (
    PAUSE_REASON_LABELS[s] ?? reason.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function formatAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  const d = Math.floor(h / 24);
  return `${String(d)}d ago`;
}
