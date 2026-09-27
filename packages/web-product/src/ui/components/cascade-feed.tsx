'use client';

/**
 * Activity tab — cascade tree + per-session RunTimeline (102i, 102m).
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Column, Row, Text } from '@aflow/design-system';
import { useApi } from './providers.js';
import type {
  ActiveSurfaceLifecycleReasonCode,
  ActiveSurfaceRunLifecycle,
  CascadeDetail,
  CascadeListItem,
  CascadeNode,
} from '@aflow/schemas';
import { CascadeSessionTimeline } from './cascade-session-timeline.js';

// ============================================================================

type BadgeVariant = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const LIFECYCLE_BADGE_VARIANT = {
  executing: 'success',
  awaiting_user: 'warning',
  awaiting_child: 'neutral',
  paused: 'neutral',
  stalled: 'warning',
  interrupting: 'danger',
  cancelled: 'danger',
  failed: 'danger',
  completed: 'neutral',
  unknown: 'danger',
} as const satisfies Record<ActiveSurfaceRunLifecycle, BadgeVariant>;

const LIFECYCLE_LABEL = {
  executing: 'executing',
  awaiting_user: 'awaiting user',
  awaiting_child: 'awaiting child',
  paused: 'paused',
  stalled: 'stalled',
  interrupting: 'interrupting',
  cancelled: 'cancelled',
  failed: 'failed',
  completed: 'completed',
  unknown: 'unknown',
} as const satisfies Record<ActiveSurfaceRunLifecycle, string>;

function lifecycleFromRawStatus(status: string): ActiveSurfaceRunLifecycle | undefined {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return undefined;
  }
}

const REASON_CODE_TOOLTIP = {
  interrupt_requested: 'interrupt requested by operator',
  awaiting_user_input: 'paused waiting for human input',
  awaiting_child_session: 'paused waiting for delegated child session',
  paused: 'session paused',
  scheduler_stale: 'scheduler cursor has not advanced',
  scheduled_task_not_dispatched: 'scheduled task has not been claimed yet',
  partial_signal_read: 'session hot state read failed; lifecycle is best-effort',
} as const satisfies Record<ActiveSurfaceLifecycleReasonCode, string>;

function CascadeNodeTree({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: CascadeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const isOpen = expanded.has(node.sessionId);
  const pad = Math.min(depth * 12, 48);

  return (
    <Column gap="xs">
      <Row
        gap="sm"
        align="center"
        wrap
        style={{
          paddingLeft: pad,
          paddingTop: 'var(--space-1)',
        }}
      >
        <Badge variant="neutral">{node.systemRole}</Badge>
        <Text size="xs" variant="muted">
          {node.agentId.length > 28 ? `${node.agentId.slice(0, 28)}…` : node.agentId}
        </Text>
        <Badge
          variant={LIFECYCLE_BADGE_VARIANT[node.lifecycle]}
          title={
            node.lifecycleReasonCode
              ? REASON_CODE_TOOLTIP[node.lifecycleReasonCode]
              : node.lifecycleReasonDetail
          }
        >
          {LIFECYCLE_LABEL[node.lifecycle]}
        </Badge>
        <Text size="xs" variant="muted">
          {node.totalTokens} tok
        </Text>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onToggle(node.sessionId);
          }}
        >
          {isOpen ? 'Hide timeline' : 'Timeline'}
        </Button>
      </Row>
      {isOpen && <CascadeSessionTimeline sessionId={node.sessionId} lifecycle={node.lifecycle} />}
      {node.children.map((ch) => (
        <CascadeNodeTree
          key={ch.sessionId}
          node={ch}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
        />
      ))}
    </Column>
  );
}

export function CascadeFeed(props: {
  spaceId: string;
  rootSessionId: string | null;
  entityWide: boolean;
  cascadeDetail: CascadeDetail | null;
}) {
  const { apiUrl, headers } = useApi();
  const { rootSessionId, entityWide, spaceId, cascadeDetail } = props;

  const [list, setList] = useState<CascadeListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const fetchList = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${spaceId}/cascades?limit=25`, {
        headers: { ...headers(), 'X-Space-ID': spaceId },
      });
      if (!res.ok) throw new Error(`List failed (${res.status})`);
      const body = (await res.json()) as { cascades: CascadeListItem[] };
      setList(body.cascades);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load cascades');
    }
  }, [apiUrl, headers, spaceId]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const filteredList = entityWide
    ? list
    : list.filter((c) => !rootSessionId || c.rootSessionId === rootSessionId);

  if (!rootSessionId && !entityWide) {
    return (
      <Text size="sm" variant="muted">
        Start a run to see the cascade for this chat.
      </Text>
    );
  }

  return (
    <Column gap="md" style={{ minHeight: 0 }}>
      {error && (
        <Text size="sm" style={{ color: 'var(--color-cybernetic-regression)' }}>
          {error}
        </Text>
      )}
      {cascadeDetail && cascadeDetail.tree.children.length > 0 && (
        <Column gap="sm">
          {cascadeDetail.tree.children.map((child) => (
            <CascadeNodeTree
              key={child.sessionId}
              node={child}
              depth={0}
              expanded={expanded}
              onToggle={toggleExpand}
            />
          ))}
        </Column>
      )}
      {entityWide && filteredList.length > 0 && (
        <Column gap="xs">
          {filteredList.map((c) => (
            <Row key={c.cascadeId} gap="sm" wrap align="center">
              <Badge variant={c.status === 'RUNNING' ? 'info' : 'neutral'}>{c.status}</Badge>
              <Text size="xs" variant="muted">
                {new Date(c.startedAt).toLocaleTimeString()}
              </Text>
              <Text size="xs">
                {c.agentId.length > 32 ? `${c.agentId.slice(0, 32)}…` : c.agentId}
              </Text>
              <Text size="xs" variant="muted">
                {c.totalTokens} tok
              </Text>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  toggleExpand(c.rootSessionId);
                }}
              >
                {expanded.has(c.rootSessionId) ? 'Hide' : 'Open'}
              </Button>
              {expanded.has(c.rootSessionId) && (
                <div style={{ width: '100%' }}>
                  <CascadeSessionTimeline
                    sessionId={c.rootSessionId}
                    lifecycle={lifecycleFromRawStatus(c.status)}
                  />
                </div>
              )}
            </Row>
          ))}
        </Column>
      )}
      {entityWide && filteredList.length === 0 && !error && (
        <Text size="sm" variant="muted">
          No recent sessions in this space.
        </Text>
      )}
    </Column>
  );
}
