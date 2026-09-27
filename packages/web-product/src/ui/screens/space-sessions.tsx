'use client';

import { useState, useEffect, useMemo, Suspense } from 'react';
import Link from 'next/link';
import { AppPageHeader } from '../components/app-page-header.js';
import { useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Checkbox,
  Text,
  Button,
  RunStatusBadge,
  Row,
  Column,
  Input,
  Select,
  Icon,
  PageContainer,
  EmptyState,
  useBreakpoint,
} from '@aflow/design-system';
import type { RunStatus } from '@aflow/design-system';
import { useApi, useSpace, useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { useFlows } from '../hooks/use-flows.js';

type SessionTarget =
  | { kind: 'platform-role'; systemRole: string }
  | { kind: 'custom-agent'; agentId: string }
  | { kind: 'inline-agent'; definitionRef: string };

interface Run {
  sessionId: string;
  target: SessionTarget;
  agentVersion: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
}

export function RunsPage() {
  return (
    <Suspense>
      <RunsPageInner />
    </Suspense>
  );
}

function isInlineSession(run: Pick<Run, 'target'>): boolean {
  return run.target.kind === 'inline-agent';
}

/** Stable string label from a session target — also the key into `flowNameMap`. */
function runLabel(run: Pick<Run, 'target'>): string {
  switch (run.target.kind) {
    case 'platform-role':
      return run.target.systemRole;
    case 'custom-agent':
      return run.target.agentId;
    case 'inline-agent':
      return 'inline-agent';
  }
}

/** Reusable sessions content — used both standalone and in space settings tab. */
export function SessionsContent() {
  return (
    <Suspense>
      <SessionsContentInner />
    </Suspense>
  );
}

function SessionsContentInner() {
  const { apiUrl, headers } = useApi();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const searchParams = useSearchParams();
  const agentIdFilter = searchParams.get('agentId') ?? '';
  const [runs, setRuns] = useState<Run[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showInternalRuns, setShowInternalRuns] = useState(false);
  const { isMobile } = useBreakpoint();

  const { flows } = useFlows(spaceId);

  const flowNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const flow of flows) {
      map.set(flow.agentId, flow.name);
    }
    return map;
  }, [flows]);

  useEffect(() => {
    async function fetchRuns() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (statusFilter) params.set('status', statusFilter);
        if (agentIdFilter) {
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (UUID_RE.test(agentIdFilter)) {
            params.set('targetKind', 'custom-agent');
            params.set('targetAgentId', agentIdFilter);
          } else {
            params.set('targetKind', 'platform-role');
            params.set('targetSystemRole', agentIdFilter);
          }
        }
        if (showInternalRuns) params.set('excludeTrigger', 'none');
        const response = await fetch(`${apiUrl}/sessions?${params.toString()}`, {
          headers: headers(),
        });
        if (!response.ok) throw new Error('Failed to fetch runs');
        const data = (await response.json()) as { sessions?: Run[] };
        setRuns(data.sessions ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch runs');
      } finally {
        setIsLoading(false);
      }
    }
    void fetchRuns();
  }, [apiUrl, headers, statusFilter, agentIdFilter, showInternalRuns]);

  const effectiveShowInternalRuns = showInternalRuns || agentIdFilter.startsWith('inline-');

  const filteredRuns = runs.filter((run) => {
    if (!effectiveShowInternalRuns && isInlineSession(run)) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const label = runLabel(run);
    const flowName = flowNameMap.get(label)?.toLowerCase() ?? '';
    return (
      run.sessionId.toLowerCase().includes(q) ||
      label.toLowerCase().includes(q) ||
      flowName.includes(q)
    );
  });

  return (
    <PageContainer>
      <Column gap="5">
        <Column gap="2">
          <Input
            type="search"
            placeholder="Search by agent name, agent ID, or session ID…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
          />
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
            }}
            style={{ width: isMobile ? '100%' : 150, flexShrink: 0 }}
          >
            <option value="">All statuses</option>
            <option value="QUEUED">Queued</option>
            <option value="RUNNING">Running</option>
            <option value="PAUSED">Idle</option>
            <option value="SUCCEEDED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="STALLED">Stalled</option>
          </Select>
          <Checkbox
            checked={effectiveShowInternalRuns}
            onChange={(e) => {
              setShowInternalRuns(e.target.checked);
            }}
            disabled={agentIdFilter.startsWith('inline-')}
            label="Show internal runs"
          />
        </Column>

        {isLoading ? null : error ? (
          <EmptyState title="Something went wrong" description={error} />
        ) : filteredRuns.length === 0 ? (
          <EmptyState
            icon={<Icon name="play" size={48} weight="thin" />}
            title="No sessions found"
            description={
              searchQuery || statusFilter || !effectiveShowInternalRuns
                ? 'Try adjusting your filters'
                : 'Start an agent to create your first session'
            }
            action={
              !searchQuery && !statusFilter && effectiveShowInternalRuns ? (
                <Button variant="secondary" leftIcon={<Icon name="plus" size="sm" />}>
                  Start a session
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Column gap="2">
            {filteredRuns.map((run) => (
              <RunCard key={run.sessionId} run={run} flowName={flowNameMap.get(runLabel(run))} />
            ))}
          </Column>
        )}
      </Column>
    </PageContainer>
  );
}

function RunsPageInner() {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const searchParams = useSearchParams();
  const agentIdFilter = searchParams.get('agentId') ?? '';
  const { flows } = useFlows(spaceId);
  const { isMobile } = useBreakpoint();
  const flowNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const flow of flows) {
      map.set(flow.agentId, flow.name);
    }
    return map;
  }, [flows]);

  return (
    <>
      <AppPageHeader
        title={
          agentIdFilter
            ? `Sessions — ${flowNameMap.get(agentIdFilter) ?? agentIdFilter}`
            : 'Sessions'
        }
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size="sm" />}
            aria-label="New Session"
          >
            {isMobile ? '' : 'New Session'}
          </Button>
        }
      />
      <SessionsContentInner />
    </>
  );
}

function RunCard({ run, flowName }: { run: Run; flowName: string | undefined }) {
  const { isMobile } = useBreakpoint();
  const { activeSpace } = useSpace();
  const spaceSlug = activeSpace?.slug;
  const displayName = flowName ?? runLabel(run);
  const duration = run.completedAt ? formatDuration(run.createdAt, run.completedAt) : undefined;

  return (
    <Link
      href={spaceRoute(spaceSlug, `/sessions/${run.sessionId}`)}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <Card interactive>
        <CardBody>
          {isMobile ? (
            <Column gap="2">
              <Row justify="between" align="center">
                <Text size="sm" weight="medium" truncate>
                  {displayName}
                </Text>
                <RunStatusBadge status={run.status} />
              </Row>
              <Row justify="between" align="center">
                <Text variant="mono" size="xs" color="muted" truncate style={{ maxWidth: '50%' }}>
                  {run.sessionId.slice(0, 8)}
                </Text>
                <Text variant="muted" size="xs">
                  {formatRelativeTime(run.createdAt)}
                  {duration ? ` · ${duration}` : ''}
                </Text>
              </Row>
            </Column>
          ) : (
            <Row justify="between" align="center">
              <Row gap="3" align="center" style={{ minWidth: 0 }}>
                <Text size="sm" weight="medium" truncate>
                  {displayName}
                </Text>
                <RunStatusBadge status={run.status} />
              </Row>
              <Row gap="4" align="center" style={{ flexShrink: 0 }}>
                <Text variant="mono" size="xs" color="muted">
                  {run.sessionId.slice(0, 8)}
                </Text>
                {duration && (
                  <Text variant="muted" size="xs">
                    {duration}
                  </Text>
                )}
                <Text variant="muted" size="xs">
                  {formatRelativeTime(run.createdAt)}
                </Text>
              </Row>
            </Row>
          )}
        </CardBody>
      </Card>
    </Link>
  );
}

function formatRelativeTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${String(diffMins)}m ago`;
  if (diffHours < 24) return `${String(diffHours)}h ago`;
  return `${String(diffDays)}d ago`;
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return '<1s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${String(mins)}m ${String(remSecs)}s` : `${String(mins)}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${String(hours)}h ${String(remMins)}m` : `${String(hours)}h`;
}
