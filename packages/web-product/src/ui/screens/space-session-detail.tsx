'use client';

import { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import {
  Card,
  CardBody,
  Text,
  Button,
  RunStatusBadge,
  KeyValueTable,
  Row,
  Column,
  Icon,
  Badge,
  Box,
  EmptyState,
  Divider,
  useBreakpoint,
} from '@aflow/design-system';
import type { RunStatus, PauseType } from '@aflow/design-system';
import { AppPageHeader } from '../components/app-page-header.js';
import { useApi, useSpace } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { useRunEvents } from '../hooks/use-run-events.js';
import { RunTimeline } from '../components/run-timeline.js';
import type { SessionEvent } from '../lib/types.js';

type SessionTarget =
  | { kind: 'platform-role'; systemRole: string }
  | { kind: 'custom-agent'; agentId: string }
  | { kind: 'inline-agent'; definitionRef: string };

interface RunDetails {
  sessionId: string;
  target: SessionTarget;
  agentVersion: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  currentStepId?: string;
  stepCount: number;
  pauseType?: string;
}

/** Stable display string from a tagged session target. */
function runDetailLabel(run: Pick<RunDetails, 'target'>): string {
  switch (run.target.kind) {
    case 'platform-role':
      return run.target.systemRole;
    case 'custom-agent':
      return run.target.agentId;
    case 'inline-agent':
      return 'inline-agent';
  }
}

interface CapabilityEntry {
  capabilityGroupId: string;
  accessMode: string;
}

interface RunAccessGrant {
  spaceId: string;
  accessLevel: string;
  grantedToUserId: string;
  tenantRole: string;
  spaceRole: string;
  grantedAt: string;
  expiresAt: string;
  capabilities: {
    allowedCapabilities: CapabilityEntry[];
    deniedCapabilities: CapabilityEntry[];
    allowedRiskModifiers: string[];
    deniedRiskModifiers: string[];
    allowPrivileged: boolean;
  };
  grantReason?: string;
  compiledProfileId?: string;
  compiledProfileVersion?: number;
  compilerVersion?: string;
  resourceScopes: Array<{
    resourceType: string;
    resourceId: string;
    actions: string[];
  }>;
}

interface DelegationTreeEntry {
  childSessionId: string;
  agentId?: string;
  status?: RunStatus;
  depth: number;
  startedAt?: number;
  completedAt?: number;
}

interface RunDelegationView {
  parentSessionId?: string;
  delegationTree?: DelegationTreeEntry[];
}

const TERMINAL_CHILD_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export function RunDetailsPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const resolvedParams = use(params);
  const { sessionId } = resolvedParams;
  const { apiUrl, headers } = useApi();
  const { activeSpace } = useSpace();
  const spaceSlug = activeSpace?.slug;
  const sessionsHref = spaceRoute(spaceSlug, '/sessions');
  const sessionHref = (id: string) => spaceRoute(spaceSlug, `/sessions/${id}`);
  const [run, setRun] = useState<RunDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<RunAccessGrant | null>(null);
  const [grantExpanded, setGrantExpanded] = useState(false);
  const [delegation, setDelegation] = useState<RunDelegationView | null>(null);

  const { events: liveEvents, isConnected } = useRunEvents(sessionId);
  const { isMobile } = useBreakpoint();

  const fetchGrant = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/sessions/${sessionId}/grant`, {
        headers: headers(),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { grant: RunAccessGrant | null };
      setGrant(data.grant);
    } catch {
      // Grant is optional — silently ignore errors
    }
  }, [apiUrl, sessionId, headers]);

  const fetchDelegation = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/sessions/${sessionId}/debug?eventsLimit=1`, {
        headers: headers(),
      });
      if (!response.ok) return;
      const data = (await response.json()) as RunDelegationView;
      setDelegation({
        ...(data.parentSessionId ? { parentSessionId: data.parentSessionId } : {}),
        ...(data.delegationTree ? { delegationTree: data.delegationTree } : {}),
      });
    } catch {
      // Debug view is optional — silently ignore errors
    }
  }, [apiUrl, sessionId, headers]);

  useEffect(() => {
    async function fetchRun() {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiUrl}/sessions/${sessionId}`, {
          headers: headers(),
        });
        if (!response.ok) throw new Error('Failed to fetch run');
        setRun((await response.json()) as RunDetails);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch run');
      } finally {
        setIsLoading(false);
      }
    }
    void fetchRun();
    void fetchGrant();
    void fetchDelegation();
  }, [apiUrl, sessionId, headers, fetchGrant, fetchDelegation]);

  // Update status from live events
  useEffect(() => {
    const statusEvents = liveEvents.filter((e: SessionEvent) =>
      [
        'SessionCompleted',
        'SessionSucceeded',
        'SessionFailed',
        'SessionCancelled',
        'SessionPaused',
      ].includes(e.eventType),
    );
    const lastEvent = statusEvents.at(-1);
    if (lastEvent && run) {
      let newStatus: RunStatus = run.status;
      let pauseType: string | undefined;
      if (lastEvent.eventType === 'SessionCompleted' || lastEvent.eventType === 'SessionSucceeded')
        newStatus = 'SUCCEEDED';
      if (lastEvent.eventType === 'SessionFailed') newStatus = 'FAILED';
      if (lastEvent.eventType === 'SessionCancelled') newStatus = 'CANCELLED';
      if (lastEvent.eventType === 'SessionPaused') {
        pauseType =
          (lastEvent.metadata?.['pauseType'] as string | undefined) ??
          (lastEvent.data?.['pauseType'] as string | undefined);
        // subflow_waiting events mean the session entered WAITING_ON_CHILD, not PAUSED
        newStatus = pauseType === 'subflow_waiting' ? 'WAITING_ON_CHILD' : 'PAUSED';
      }
      if (newStatus !== run.status || pauseType !== run.pauseType)
        setRun({ ...run, status: newStatus, ...(pauseType !== undefined ? { pauseType } : {}) });
    }
  }, [liveEvents, run]);

  if (isLoading) {
    return null;
  }

  if (error || !run) {
    return (
      <Box p="6">
        <EmptyState title={error ?? 'Run not found'} />
      </Box>
    );
  }

  const capCount = grant
    ? grant.capabilities.allowedCapabilities.length + grant.capabilities.deniedCapabilities.length
    : 0;

  return (
    <>
      <AppPageHeader
        title={
          <Row gap="2" align="center" wrap>
            <Link
              href={sessionsHref}
              style={{ color: 'var(--color-content-muted)', display: 'flex' }}
            >
              <Icon name="arrow-left" size="md" />
            </Link>
            <Text variant="heading" size="lg">
              Run Details
            </Text>
            <RunStatusBadge status={run.status} pauseType={run.pauseType as PauseType} />
            {isConnected && <Badge variant="info">Live</Badge>}
          </Row>
        }
        actions={
          <Row gap="2">
            {run.status === 'PAUSED' && (
              <Button variant="primary" size="sm">
                Resume
              </Button>
            )}
            {['RUNNING', 'PAUSED'].includes(run.status) && (
              <Button variant="danger" size="sm">
                Cancel
              </Button>
            )}
          </Row>
        }
      />

      <Box p={isMobile ? '3' : '5'} style={{ overflow: 'auto', flex: 1 }}>
        <Column gap="5" style={{ maxWidth: isMobile ? '100%' : 800, width: '100%' }}>
          {/* Run summary */}
          <Card>
            <CardBody>
              <KeyValueTable
                items={[
                  {
                    key: 'Run ID',
                    value: (
                      <Text variant="mono" size="xs" style={{ overflowWrap: 'anywhere' }}>
                        {run.sessionId}
                      </Text>
                    ),
                  },
                  { key: 'Flow', value: `${runDetailLabel(run)} @ ${run.agentVersion}` },
                  { key: 'Started', value: new Date(run.createdAt).toLocaleString() },
                  ...(run.completedAt
                    ? [{ key: 'Completed', value: new Date(run.completedAt).toLocaleString() }]
                    : []),
                  { key: 'Steps', value: String(run.stepCount) },
                  ...(delegation?.parentSessionId
                    ? [
                        {
                          key: 'Parent session',
                          value: (
                            <Link
                              href={sessionHref(delegation.parentSessionId)}
                              style={{ color: 'var(--color-link)' }}
                            >
                              <Text variant="mono" size="xs" style={{ overflowWrap: 'anywhere' }}>
                                {delegation.parentSessionId}
                              </Text>
                            </Link>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>

          {delegation?.delegationTree && delegation.delegationTree.length > 0 && (
            <Card>
              <CardBody>
                <Column gap="3">
                  <Row gap="2" align="center">
                    <Icon name="arrow-right" size="sm" />
                    <Text variant="label" size="sm">
                      Delegated sessions
                    </Text>
                    <Badge variant="neutral">{delegation.delegationTree.length}</Badge>
                    {run.status === 'WAITING_ON_CHILD' &&
                      delegation.delegationTree.some((c) =>
                        c.status ? TERMINAL_CHILD_STATUSES.has(c.status) : false,
                      ) && (
                        <Badge variant="warning">Stuck — parent waiting on a terminal child</Badge>
                      )}
                  </Row>
                  <Column gap="2">
                    {delegation.delegationTree.map((child) => {
                      const isTerminal = child.status
                        ? TERMINAL_CHILD_STATUSES.has(child.status)
                        : false;
                      const parentWaiting = run.status === 'WAITING_ON_CHILD';
                      const stuck = parentWaiting && isTerminal;
                      return (
                        <Link
                          key={child.childSessionId}
                          href={sessionHref(child.childSessionId)}
                          style={{ textDecoration: 'none' }}
                        >
                          <Row
                            gap="3"
                            align="center"
                            justify="between"
                            style={{
                              padding: 'var(--space-2) var(--space-3)',
                              border: stuck
                                ? '1px solid var(--color-border-warning, var(--color-border))'
                                : '1px solid var(--color-border)',
                              borderRadius: 'var(--radius-md)',
                              background: stuck
                                ? 'var(--color-background-warning-subtle, transparent)'
                                : 'transparent',
                            }}
                          >
                            <Column gap="1" style={{ minWidth: 0 }}>
                              <Row gap="2" align="center">
                                {child.status && (
                                  <RunStatusBadge status={child.status} showIcon={false} />
                                )}
                                <Text variant="mono" size="xs" style={{ overflowWrap: 'anywhere' }}>
                                  {child.childSessionId}
                                </Text>
                              </Row>
                              <Text size="xs" style={{ color: 'var(--color-content-muted)' }}>
                                {child.agentId ?? 'unknown agent'}
                                {child.startedAt
                                  ? ` · started ${new Date(child.startedAt).toLocaleTimeString()}`
                                  : ''}
                                {child.completedAt
                                  ? ` · ended ${new Date(child.completedAt).toLocaleTimeString()}`
                                  : ''}
                              </Text>
                            </Column>
                            <Icon name="arrow-right" size="sm" />
                          </Row>
                        </Link>
                      );
                    })}
                  </Column>
                </Column>
              </CardBody>
            </Card>
          )}

          {/* Authorization Grant */}
          {grant && (
            <Card>
              <CardBody>
                <Column gap="3">
                  <Row gap="2" align="center">
                    <Icon name="shield-check" size="sm" />
                    <Text variant="label" size="sm">
                      Authorization Grant
                    </Text>
                  </Row>
                  <KeyValueTable
                    items={[
                      { key: 'Access Level', value: grant.accessLevel },
                      { key: 'Space Role', value: grant.spaceRole },
                      { key: 'Tenant Role', value: grant.tenantRole },
                      ...(grant.compiledProfileId
                        ? [{ key: 'Profile', value: grant.compiledProfileId }]
                        : []),
                      ...(grant.compilerVersion
                        ? [{ key: 'Compiler', value: grant.compilerVersion }]
                        : []),
                      {
                        key: 'Granted',
                        value: new Date(grant.grantedAt).toLocaleString(),
                      },
                      {
                        key: 'Expires',
                        value: new Date(grant.expiresAt).toLocaleString(),
                      },
                      {
                        key: 'Privileged',
                        value: grant.capabilities.allowPrivileged ? 'Yes' : 'No',
                      },
                      { key: 'Capabilities', value: String(capCount) },
                    ]}
                  />

                  {capCount > 0 && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setGrantExpanded(!grantExpanded);
                        }}
                        leftIcon={
                          <Icon name={grantExpanded ? 'caret-up' : 'caret-down'} size="sm" />
                        }
                      >
                        {grantExpanded ? 'Hide' : 'Show'} Capabilities
                      </Button>

                      {grantExpanded && (
                        <Column gap="2">
                          {grant.capabilities.allowedCapabilities.length > 0 && (
                            <>
                              <Divider />
                              <Text variant="label" size="xs">
                                Allowed
                              </Text>
                              <Row gap="1" wrap>
                                {grant.capabilities.allowedCapabilities.map((c) => (
                                  <Badge
                                    key={`${c.capabilityGroupId}:${c.accessMode}`}
                                    variant="success"
                                  >
                                    {c.capabilityGroupId}:{c.accessMode}
                                  </Badge>
                                ))}
                              </Row>
                            </>
                          )}
                          {grant.capabilities.deniedCapabilities.length > 0 && (
                            <>
                              <Divider />
                              <Text variant="label" size="xs">
                                Denied
                              </Text>
                              <Row gap="1" wrap>
                                {grant.capabilities.deniedCapabilities.map((c) => (
                                  <Badge
                                    key={`${c.capabilityGroupId}:${c.accessMode}`}
                                    variant="danger"
                                  >
                                    {c.capabilityGroupId}:{c.accessMode}
                                  </Badge>
                                ))}
                              </Row>
                            </>
                          )}
                          {grant.capabilities.allowedRiskModifiers.length > 0 && (
                            <>
                              <Divider />
                              <Text variant="label" size="xs">
                                Risk Modifiers
                              </Text>
                              <Row gap="1" wrap>
                                {grant.capabilities.allowedRiskModifiers.map((m) => (
                                  <Badge key={m} variant="warning">
                                    {m}
                                  </Badge>
                                ))}
                              </Row>
                            </>
                          )}
                        </Column>
                      )}
                    </>
                  )}
                </Column>
              </CardBody>
            </Card>
          )}

          {/* Execution timeline */}
          <Card>
            <CardBody>
              <Column gap="3">
                <Row gap="2" align="center">
                  <Text variant="label" size="sm">
                    Execution Timeline
                  </Text>
                  <Badge variant="neutral">{liveEvents.length} events</Badge>
                </Row>
                <RunTimeline events={liveEvents} />
              </Column>
            </CardBody>
          </Card>
        </Column>
      </Box>
    </>
  );
}
