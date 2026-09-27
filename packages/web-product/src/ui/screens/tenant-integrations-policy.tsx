'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  HelperText,
  Heading,
  Icon,
  Input,
  PageContainer,
  Row,
  Select,
  Spinner,
  Text,
} from '@aflow/design-system';
import type { IntegrationAllowlistKind, IntegrationHostRequest } from '@aflow/schemas';
import {
  useAddAllowlistHost,
  useIntegrationAllowlist,
  useIntegrationHostRequests,
  useIntegrationPolicy,
  useRemoveAllowlistHost,
  useResolveIntegrationHostRequest,
  useSetIntegrationPolicy,
} from '../hooks/use-tenant-governance.js';
import {
  ErrorRow,
  ModeToggle,
  SectionDivider,
} from '../components/tenant-settings/policy-controls.js';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function KindBadge({ kind }: { kind: IntegrationAllowlistKind }) {
  return <Badge variant="neutral">{kind === 'mcp' ? 'MCP' : 'API'}</Badge>;
}

// ============================================================================
// Integration policy + allowlist
// ============================================================================

function IntegrationPolicySection() {
  const policyQuery = useIntegrationPolicy();
  const setPolicy = useSetIntegrationPolicy();
  const allowlistQuery = useIntegrationAllowlist();
  const addHost = useAddAllowlistHost();
  const removeHost = useRemoveAllowlistHost();

  const [newKind, setNewKind] = useState<IntegrationAllowlistKind>('api');
  const [newHost, setNewHost] = useState('');
  const [newNote, setNewNote] = useState('');

  const mode = policyQuery.data?.mode;
  const entries = allowlistQuery.data?.entries ?? [];
  const fullyClosed = mode === 'allowlist' && entries.length === 0;

  return (
    <section>
      <Column gap="md">
        <Column gap="xs">
          <Heading level={5}>Integration Policy</Heading>
          <Text size="xs" variant="muted">
            Controls which hosts members can connect custom API and MCP integrations to. Store items
            are vetted separately and keep working in either mode.
          </Text>
        </Column>

        {policyQuery.error && <ErrorRow message={policyQuery.error.message} />}

        <ModeToggle
          options={[
            {
              value: 'open' as const,
              label: 'Open',
              description: 'Members can connect custom integrations to any host.',
            },
            {
              value: 'allowlist' as const,
              label: 'Allowlist',
              description:
                'Custom integrations can only reach hosts on the list below. Anything else is refused until an admin allows it.',
            },
          ]}
          value={mode}
          disabled={policyQuery.isLoading || setPolicy.isPending}
          onSelect={(value) => {
            setPolicy.mutate({ mode: value });
          }}
        />
        {setPolicy.error && <ErrorRow message={setPolicy.error.message} />}

        {fullyClosed && (
          <Card>
            <CardBody>
              <Row gap="sm" align="center">
                <Icon name="warning" size="sm" color="var(--color-warning-fg)" />
                <Text size="xs">
                  The allowlist is empty, so custom integrations are fully closed — no host can be
                  reached until you add one or approve a request.
                </Text>
              </Row>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardBody>
            <Column gap="sm">
              {entries.map((entry, index) => (
                <Column key={entry.id} gap="xs">
                  <Row gap="sm" align="center" justify="between">
                    <Row gap="sm" align="center" style={{ minWidth: 0, flex: 1 }}>
                      <KindBadge kind={entry.kind} />
                      <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
                        {entry.hostPattern}
                      </Text>
                      {entry.note && (
                        <Text size="xs" variant="muted" truncate>
                          {entry.note}
                        </Text>
                      )}
                    </Row>
                    <Row gap="sm" align="center">
                      <Text size="xs" variant="muted">
                        {formatDate(entry.addedAt)}
                      </Text>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={removeHost.isPending}
                        onClick={() => {
                          removeHost.mutate({ id: entry.id });
                        }}
                      >
                        <Icon name="trash" size="xs" />
                      </Button>
                    </Row>
                  </Row>
                  {index < entries.length - 1 && <SectionDivider />}
                </Column>
              ))}
              {entries.length === 0 && (
                <Text size="xs" variant="muted" style={{ padding: 'var(--space-2)' }}>
                  No allowed hosts.
                </Text>
              )}

              <SectionDivider />
              <Row gap="sm" align="center" wrap>
                <Select
                  value={newKind}
                  onChange={(e) => {
                    setNewKind(e.target.value === 'mcp' ? 'mcp' : 'api');
                  }}
                  style={{ width: 90 }}
                >
                  <option value="api">API</option>
                  <option value="mcp">MCP</option>
                </Select>
                <Input
                  value={newHost}
                  onChange={(e) => {
                    setNewHost(e.target.value);
                  }}
                  placeholder="api.example.com or *.example.com"
                  style={{ flex: 1, minWidth: 220 }}
                />
                <Input
                  value={newNote}
                  onChange={(e) => {
                    setNewNote(e.target.value);
                  }}
                  placeholder="Note (optional)"
                  style={{ flex: 1, minWidth: 160 }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!newHost.trim() || addHost.isPending}
                  onClick={() => {
                    addHost.mutate(
                      {
                        kind: newKind,
                        hostPattern: newHost.trim(),
                        ...(newNote.trim() ? { note: newNote.trim() } : {}),
                      },
                      {
                        onSuccess: () => {
                          setNewHost('');
                          setNewNote('');
                        },
                      },
                    );
                  }}
                >
                  Add Host
                </Button>
              </Row>
              <HelperText>
                Bare hostnames only — no scheme, port, or path. Wildcards like *.example.com cover
                subdomains.
              </HelperText>
              {addHost.error && <ErrorRow message={addHost.error.message} />}
            </Column>
          </CardBody>
        </Card>
      </Column>
    </section>
  );
}

// ============================================================================
// Host requests
// ============================================================================

function RequestRow({
  request,
  onResolve,
  resolving,
}: {
  request: IntegrationHostRequest;
  onResolve: (status: 'approved' | 'rejected') => void;
  resolving: boolean;
}) {
  return (
    <Row gap="sm" align="center" justify="between" wrap>
      <Column gap="xs" style={{ minWidth: 0, flex: 1 }}>
        <Row gap="sm" align="center">
          <KindBadge kind={request.kind} />
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {request.hostPattern}
          </Text>
        </Row>
        <Text size="xs" variant="muted">
          Requested by {request.requestedBy} on {formatDate(request.requestedAt)}
          {request.reason ? ` — ${request.reason}` : ''}
        </Text>
      </Column>
      <Row gap="sm">
        <Button
          variant="primary"
          size="sm"
          disabled={resolving}
          onClick={() => {
            onResolve('approved');
          }}
        >
          Approve
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={resolving}
          onClick={() => {
            onResolve('rejected');
          }}
        >
          Reject
        </Button>
      </Row>
    </Row>
  );
}

function HostRequestsSection() {
  const requestsQuery = useIntegrationHostRequests();
  const resolveRequest = useResolveIntegrationHostRequest();

  const requests = requestsQuery.data?.requests ?? [];
  const pending = requests.filter((request) => request.status === 'pending_approval');
  const reviewed = requests.filter((request) => request.status !== 'pending_approval');

  return (
    <section>
      <Column gap="md">
        <Column gap="xs">
          <Row gap="sm" align="center">
            <Heading level={5}>Host Requests</Heading>
            {pending.length > 0 && <Badge variant="warning">{pending.length} pending</Badge>}
          </Row>
          <Text size="xs" variant="muted">
            Members blocked by the allowlist can request a host. Approving adds it to the allowlist
            immediately.
          </Text>
        </Column>

        {resolveRequest.error && <ErrorRow message={resolveRequest.error.message} />}

        <Card>
          <CardBody>
            <Column gap="sm">
              {pending.map((request, index) => (
                <Column key={request.requestId} gap="xs">
                  <RequestRow
                    request={request}
                    resolving={resolveRequest.isPending}
                    onResolve={(status) => {
                      resolveRequest.mutate({ requestId: request.requestId, status });
                    }}
                  />
                  {index < pending.length - 1 && <SectionDivider />}
                </Column>
              ))}
              {pending.length === 0 && (
                <Text size="xs" variant="muted" style={{ padding: 'var(--space-2)' }}>
                  No pending requests.
                </Text>
              )}
            </Column>
          </CardBody>
        </Card>

        {reviewed.length > 0 && (
          <Column gap="xs">
            <Text size="xs" weight="medium" variant="muted">
              Review History
            </Text>
            <Card>
              <CardBody>
                <Column gap="sm">
                  {reviewed.map((request) => (
                    <Row key={request.requestId} gap="sm" align="center" justify="between">
                      <Row gap="sm" align="center" style={{ minWidth: 0, flex: 1 }}>
                        <KindBadge kind={request.kind} />
                        <Text size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
                          {request.hostPattern}
                        </Text>
                        <Badge variant={request.status === 'approved' ? 'success' : 'danger'}>
                          {request.status}
                        </Badge>
                      </Row>
                      <Text size="xs" variant="muted">
                        {request.reviewedAt ? formatDate(request.reviewedAt) : ''}
                      </Text>
                    </Row>
                  ))}
                </Column>
              </CardBody>
            </Card>
          </Column>
        )}
      </Column>
    </section>
  );
}

// ============================================================================
// Page
// ============================================================================

export function TenantIntegrationsPolicyPage() {
  const policyQuery = useIntegrationPolicy();

  if (policyQuery.isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Spinner size="lg" label="Loading policy" />
        </Row>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Column gap="lg">
        <IntegrationPolicySection />
        <HostRequestsSection />
      </Column>
    </PageContainer>
  );
}
