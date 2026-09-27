'use client';

/**
 * Workflow Runs tab — Cybernetic Console UX hardening.
 *
 * Per-skill run history with mode-aware presentation:
 *   - optimization: "Attempt #N" numbering with score trend sparkline
 *   - process/project: standard most-recent-first table
 *
 * Cursor-based pagination via "Load more" button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Heading,
  Icon,
  Row,
  Spinner,
  Text,
  WorkflowRunStatusBadge,
} from '@aflow/design-system';

import { Sparkline } from './graph/Sparkline.js';
import { useApi, useSpace } from './providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { WorkflowRunSurfaceContainer } from './workflow-run-surface/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowRunSummary {
  runId: string;
  status: string;
  workflowRevision: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  totalCostCents: number | null;
  totalTokens: number | null;
  evalScore: number | null;
  evalVerdict: string | null;
  taskCount: number;
  initiatedByUserId: string | null;
  sessionId: string | null;
  rootSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface RunsTabProps {
  spaceId: string;
  workflowSlug: string;
  /** Workflow mode — changes how runs are presented. */
  mode?: 'optimization' | 'process' | 'project';
}

export function RunsTab({ spaceId, workflowSlug, mode }: RunsTabProps) {
  const { apiUrl, headers } = useApi();
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [previewRunId, setPreviewRunId] = useState<string | null>(null);

  const fetchRuns = useCallback(
    async (cursor?: string) => {
      const isMore = !!cursor;
      if (isMore) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const url = new URL(
          `${apiUrl}/spaces/${spaceId}/workflows/${workflowSlug}/runs`,
          window.location.origin,
        );
        url.searchParams.set('limit', '20');
        if (cursor) url.searchParams.set('cursor', cursor);

        const res = await fetch(url.toString(), {
          headers: { ...headers(), 'X-Space-ID': spaceId },
        });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
        const body = (await res.json()) as {
          runs: WorkflowRunSummary[];
          nextCursor: string | null;
        };
        setRuns((prev) => (isMore ? [...prev, ...body.runs] : body.runs));
        setNextCursor(body.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load runs');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [apiUrl, headers, spaceId, workflowSlug],
  );

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  // For optimization mode: derive score trend (oldest→newest)
  const trendScores = useMemo(() => {
    if (mode !== 'optimization') return [];
    const scored = runs.filter((r) => r.evalScore !== null);
    return [...scored].reverse().map((r) => r.evalScore!);
  }, [runs, mode]);

  if (loading && runs.length === 0) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="md" label="Loading runs" />
      </Row>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--space-5)' }}>
        <Card>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Icon name="warning" size="md" />
                <Heading level={5}>Could not load runs</Heading>
              </Row>
              <Text size="sm" variant="muted">
                {error}
              </Text>
              <Row>
                <Button variant="secondary" size="sm" onClick={() => void fetchRuns()}>
                  Retry
                </Button>
              </Row>
            </Column>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <Column gap="md">
        <Row gap="sm" align="center" wrap>
          <Heading level={5}>Runs</Heading>
          <Badge variant="neutral">
            {String(runs.length)}
            {nextCursor ? '+' : ''}
          </Badge>
        </Row>

        {/* Optimization: score trend sparkline */}
        {mode === 'optimization' && trendScores.length > 1 && (
          <Card>
            <CardBody>
              <Column gap="xs">
                <Text size="xs" weight="semibold">
                  Score trend
                </Text>
                <Sparkline
                  values={trendScores}
                  width={280}
                  height={32}
                  color="var(--color-success-default)"
                  ariaLabel={`Score trend across ${String(trendScores.length)} attempts`}
                />
              </Column>
            </CardBody>
          </Card>
        )}

        {runs.length === 0 ? (
          <Card>
            <CardBody>
              <Text size="sm" variant="muted">
                No runs yet. This skill has not been activated.
              </Text>
            </CardBody>
          </Card>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 12,
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--color-border-subtle)',
                    textAlign: 'left',
                  }}
                >
                  {mode === 'optimization' && <Th>Attempt</Th>}
                  <Th>Status</Th>
                  <Th>Started</Th>
                  <Th>Duration</Th>
                  <Th>Cost</Th>
                  <Th>Eval</Th>
                  <Th>Tasks</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r, idx) => {
                  // Optimization: attempts are numbered in chronological order (oldest = #1)
                  const attemptNum = mode === 'optimization' ? runs.length - idx : undefined;
                  return (
                    <RunRow
                      key={r.runId}
                      run={r}
                      attemptNum={attemptNum}
                      showAttempt={mode === 'optimization'}
                      isPreviewing={previewRunId === r.runId}
                      onTogglePreview={() => {
                        setPreviewRunId((cur) => (cur === r.runId ? null : r.runId));
                      }}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {previewRunId && (
          <Card>
            <CardBody>
              <Column gap="sm">
                <Row gap="sm" align="center" justify="between">
                  <Text size="xs" weight="semibold" variant="muted">
                    Run preview
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPreviewRunId(null);
                    }}
                  >
                    Close
                  </Button>
                </Row>
                <WorkflowRunSurfaceContainer runId={previewRunId} spaceId={spaceId} />
              </Column>
            </CardBody>
          </Card>
        )}

        {nextCursor && (
          <Row justify="center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void fetchRuns(nextCursor)}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </Button>
          </Row>
        )}
      </Column>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: 'var(--space-2) var(--space-3)',
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {children}
    </th>
  );
}

function RunRow({
  run,
  attemptNum,
  showAttempt,
  isPreviewing,
  onTogglePreview,
}: {
  run: WorkflowRunSummary;
  attemptNum?: number | undefined;
  showAttempt: boolean;
  isPreviewing: boolean;
  onTogglePreview: () => void;
}) {
  const { activeSpace } = useSpace();
  const spaceSlug = activeSpace?.slug;
  const tdStyle: React.CSSProperties = {
    padding: 'var(--space-2) var(--space-3)',
    borderBottom: '1px solid var(--color-border-subtle)',
    verticalAlign: 'middle',
  };

  return (
    <tr>
      {showAttempt && (
        <td style={tdStyle}>
          <Text size="xs" weight="semibold">
            #{String(attemptNum)}
          </Text>
        </td>
      )}
      <td style={tdStyle}>
        <WorkflowRunStatusBadge status={run.status} />
      </td>
      <td style={tdStyle}>
        <Text size="xs">{formatDateTime(run.startedAt)}</Text>
      </td>
      <td style={tdStyle}>
        <Text size="xs" variant="muted">
          {run.durationMs !== null ? formatDuration(run.durationMs) : '—'}
        </Text>
      </td>
      <td style={tdStyle}>
        <Text size="xs" variant="muted">
          {run.totalCostCents !== null ? `$${(run.totalCostCents / 100).toFixed(2)}` : '—'}
        </Text>
      </td>
      <td style={tdStyle}>
        {run.evalScore !== null ? (
          <Row gap="xs" align="center">
            <Text size="xs" weight="semibold">
              {(run.evalScore * 100).toFixed(0)}%
            </Text>
            {run.evalVerdict && (
              <Badge
                variant={
                  run.evalVerdict === 'pass'
                    ? 'success'
                    : run.evalVerdict === 'fail'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {run.evalVerdict}
              </Badge>
            )}
          </Row>
        ) : (
          <Text size="xs" variant="muted">
            —
          </Text>
        )}
      </td>
      <td style={tdStyle}>
        <Text size="xs">{String(run.taskCount)}</Text>
      </td>
      <td style={tdStyle}>
        <Row gap="sm" align="center">
          <button
            type="button"
            onClick={onTogglePreview}
            style={{
              color: isPreviewing ? 'var(--color-text-primary)' : 'var(--color-accent-default)',
              fontSize: 11,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
            title={isPreviewing ? 'Hide run preview' : 'Preview this run inline'}
          >
            {isPreviewing ? 'Hide' : 'Preview'}
          </button>
          <a
            href={spaceRoute(spaceSlug, `/runs/${run.runId}`)}
            style={{ color: 'var(--color-accent-default)', fontSize: 11, textDecoration: 'none' }}
            title="Open the full run-management page"
          >
            Open
          </a>
          {(run.rootSessionId ?? run.sessionId) && (
            <a
              href={spaceRoute(spaceSlug, `/sessions/${run.rootSessionId ?? run.sessionId}`)}
              style={{ color: 'var(--color-text-secondary)', fontSize: 11, textDecoration: 'none' }}
              title="View session details"
            >
              Session
            </a>
          )}
        </Row>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${String(m)}m ${String(rem)}s`;
}
