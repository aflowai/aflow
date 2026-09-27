'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Button,
  Text,
  Heading,
  Input,
  Label,
  HelperText,
  Icon,
  Badge,
} from '@aflow/design-system';
import Link from 'next/link';
import { useApi, useSpace } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';

// ============================================================================
// Types
// ============================================================================

interface EgressPreset {
  name: string;
  description?: string;
  hosts: string[];
}

interface TenantComputeDefaults {
  approvedHosts: string[];
  presets: EgressPreset[];
}

interface EgressApprovalRequest {
  requestId: string;
  requestedHosts: string[];
  scope: 'tenant' | 'space';
  spaceId?: string;
  requestedBy: string;
  requestedAt: string;
  reason?: string;
  status: 'pending_approval' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SectionDivider() {
  return <div style={{ borderTop: '1px solid var(--color-border-subtle)', margin: '4px 0' }} />;
}

// ============================================================================
// Page
// ============================================================================

export function TenantComputePolicyPage() {
  const { apiUrl, headers } = useApi();
  const { activeSpaceId, activeSpace } = useSpace();

  const [defaults, setDefaults] = useState<TenantComputeDefaults>({
    approvedHosts: [],
    presets: [],
  });
  const [savedDefaults, setSavedDefaults] = useState<TenantComputeDefaults | null>(null);
  const [requests, setRequests] = useState<EgressApprovalRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // New preset form
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetDesc, setNewPresetDesc] = useState('');
  const [newPresetHosts, setNewPresetHosts] = useState('');
  const [showPresetForm, setShowPresetForm] = useState(false);

  // --------------------------------------------------------------------------
  // Fetch
  // --------------------------------------------------------------------------

  const fetchDefaults = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [defaultsRes, requestsRes] = await Promise.all([
        fetch(`${apiUrl}/tenant/compute-defaults`, { headers: headers() }),
        fetch(`${apiUrl}/tenant/egress-requests`, { headers: headers() }),
      ]);

      if (defaultsRes.ok) {
        const data = (await defaultsRes.json()) as {
          computeDefaults: TenantComputeDefaults | null;
        };
        const loaded = data.computeDefaults ?? { approvedHosts: [], presets: [] };
        setDefaults(loaded);
        setSavedDefaults(loaded);
      }

      if (requestsRes.ok) {
        const data = (await requestsRes.json()) as { requests: EgressApprovalRequest[] };
        setRequests(data.requests);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers]);

  useEffect(() => {
    void fetchDefaults();
  }, [fetchDefaults]);

  // --------------------------------------------------------------------------
  // Change tracking
  // --------------------------------------------------------------------------

  const hasChanges =
    savedDefaults !== null && JSON.stringify(defaults) !== JSON.stringify(savedDefaults);

  // --------------------------------------------------------------------------
  // Save defaults
  // --------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch(`${apiUrl}/tenant/compute-defaults`, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ computeDefaults: defaults }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? 'Failed to save');
      }
      const data = (await res.json()) as { computeDefaults: TenantComputeDefaults | null };
      const updated = data.computeDefaults ?? { approvedHosts: [], presets: [] };
      setDefaults(updated);
      setSavedDefaults(updated);
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [hasChanges, defaults, apiUrl, headers]);

  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Loading
  // --------------------------------------------------------------------------

  if (isLoading) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Text variant="muted" size="sm">
            Loading...
          </Text>
        </Row>
      </PageContainer>
    );
  }

  const pendingRequests = requests.filter((r) => r.status === 'pending_approval');
  const reviewedRequests = requests.filter((r) => r.status !== 'pending_approval');

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <PageContainer>
      <Column gap="lg">
        {/* Save bar */}
        <Row justify="end" align="center" gap="sm">
          {saved && (
            <Row gap="xs" align="center">
              <Icon name="check" size="sm" color="var(--color-status-success-fg)" />
              <Text size="xs" style={{ color: 'var(--color-status-success-fg)' }}>
                Saved
              </Text>
            </Row>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!hasChanges || saving}
            onClick={() => {
              void handleSave();
            }}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </Row>
        {(error ?? saveError) && (
          <Card>
            <CardBody>
              <Row gap="sm" align="center">
                <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
                <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
                  {error ?? saveError}
                </Text>
              </Row>
            </CardBody>
          </Card>
        )}

        {/* ---- Approved Default Hosts ---- */}
        <section>
          <Column gap="lg">
            <Column gap="xs">
              <Heading level={5}>Approved Default Hosts</Heading>
              <Text size="xs" variant="muted">
                Hosts approved tenant-wide for compute egress. All spaces in this tenant inherit
                these hosts as their default allowlist. Compute is still deny-by-default — spaces
                must enable allowlist mode to use these hosts.
              </Text>
            </Column>

            <Card>
              <CardBody>
                <Column gap="sm">
                  {defaults.approvedHosts.map((host, i) => (
                    <Row key={i} gap="sm" align="center">
                      <Input
                        value={host}
                        onChange={(e) => {
                          const hosts = [...defaults.approvedHosts];
                          hosts[i] = e.target.value;
                          setDefaults({ ...defaults, approvedHosts: hosts });
                        }}
                        placeholder="e.g., storage.googleapis.com"
                        style={{ flex: 1 }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDefaults({
                            ...defaults,
                            approvedHosts: defaults.approvedHosts.filter((_, idx) => idx !== i),
                          });
                        }}
                      >
                        <Icon name="trash" size="xs" />
                      </Button>
                    </Row>
                  ))}
                  {defaults.approvedHosts.length < 100 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDefaults({
                          ...defaults,
                          approvedHosts: [...defaults.approvedHosts, ''],
                        });
                      }}
                    >
                      <Icon name="plus" size="xs" />
                      Add Host
                    </Button>
                  )}
                  {defaults.approvedHosts.length === 0 && (
                    <Text size="xs" variant="muted" style={{ padding: 'var(--space-2)' }}>
                      No tenant-wide approved hosts. Spaces must add hosts individually.
                    </Text>
                  )}
                </Column>
              </CardBody>
            </Card>
          </Column>
        </section>

        {/* ---- Egress Presets ---- */}
        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Egress Presets</Heading>
              <Text size="xs" variant="muted">
                Named host sets for common integration patterns. Space admins can add a preset to
                quickly include its hosts in their allowlist.
              </Text>
            </Column>

            <Card>
              <CardBody>
                <Column gap="md">
                  {defaults.presets.map((preset, i) => (
                    <Column key={i} gap="xs">
                      <Row gap="sm" align="center" justify="between">
                        <Column gap="xs" style={{ flex: 1 }}>
                          <Text size="sm" weight="medium">
                            {preset.name}
                          </Text>
                          {preset.description && (
                            <Text size="xs" variant="muted">
                              {preset.description}
                            </Text>
                          )}
                          <Text size="xs" variant="muted">
                            {preset.hosts.join(', ')}
                          </Text>
                        </Column>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDefaults({
                              ...defaults,
                              presets: defaults.presets.filter((_, idx) => idx !== i),
                            });
                          }}
                        >
                          <Icon name="trash" size="xs" />
                        </Button>
                      </Row>
                      {i < defaults.presets.length - 1 && <SectionDivider />}
                    </Column>
                  ))}

                  {defaults.presets.length === 0 && !showPresetForm && (
                    <Text size="xs" variant="muted" style={{ padding: 'var(--space-2)' }}>
                      No presets defined.
                    </Text>
                  )}

                  {showPresetForm && (
                    <>
                      <SectionDivider />
                      <Column gap="sm">
                        <Label>New Preset</Label>
                        <Input
                          value={newPresetName}
                          onChange={(e) => {
                            setNewPresetName(e.target.value);
                          }}
                          placeholder="Preset name (e.g., gcs-upload)"
                        />
                        <Input
                          value={newPresetDesc}
                          onChange={(e) => {
                            setNewPresetDesc(e.target.value);
                          }}
                          placeholder="Description (optional)"
                        />
                        <Input
                          value={newPresetHosts}
                          onChange={(e) => {
                            setNewPresetHosts(e.target.value);
                          }}
                          placeholder="Hosts, comma-separated (e.g., storage.googleapis.com, *.gcs.com)"
                        />
                        <HelperText>
                          Enter hostnames separated by commas. Wildcards like *.example.com are
                          supported.
                        </HelperText>
                        <Row gap="sm">
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={!newPresetName.trim() || !newPresetHosts.trim()}
                            onClick={() => {
                              const hosts = newPresetHosts
                                .split(',')
                                .map((h) => h.trim())
                                .filter(Boolean);
                              if (hosts.length > 0 && newPresetName.trim()) {
                                setDefaults({
                                  ...defaults,
                                  presets: [
                                    ...defaults.presets,
                                    {
                                      name: newPresetName.trim(),
                                      ...(newPresetDesc.trim()
                                        ? { description: newPresetDesc.trim() }
                                        : {}),
                                      hosts,
                                    },
                                  ],
                                });
                                setNewPresetName('');
                                setNewPresetDesc('');
                                setNewPresetHosts('');
                                setShowPresetForm(false);
                              }
                            }}
                          >
                            Add Preset
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setShowPresetForm(false);
                              setNewPresetName('');
                              setNewPresetDesc('');
                              setNewPresetHosts('');
                            }}
                          >
                            Cancel
                          </Button>
                        </Row>
                      </Column>
                    </>
                  )}

                  {!showPresetForm && defaults.presets.length < 20 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setShowPresetForm(true);
                      }}
                    >
                      <Icon name="plus" size="xs" />
                      Add Preset
                    </Button>
                  )}
                </Column>
              </CardBody>
            </Card>
          </Column>
        </section>

        <section>
          <Column gap="md">
            <Column gap="xs">
              <Row gap="sm" align="center">
                <Heading level={5}>Egress Requests</Heading>
                {pendingRequests.length > 0 && (
                  <Badge variant="warning">{pendingRequests.length} pending</Badge>
                )}
              </Row>
              <Text size="xs" variant="muted">
                Requests for additional compute egress hosts. Pending requests are reviewed in the
                Action Center for your active space.
              </Text>
            </Column>

            <Card>
              <CardBody>
                <Row gap="sm" align="center" justify="between" wrap>
                  <Column gap="xs">
                    <Text size="sm">
                      {pendingRequests.length === 0
                        ? 'No pending egress requests.'
                        : `${String(pendingRequests.length)} pending request${
                            pendingRequests.length === 1 ? '' : 's'
                          } awaiting admin review.`}
                    </Text>
                    {pendingRequests.length > 0 && (
                      <Text size="xs" variant="muted">
                        Approve or reject from the Workbench; this page is read-only for requests.
                      </Text>
                    )}
                  </Column>
                  {pendingRequests.length > 0 && activeSpaceId && (
                    <Link
                      href={spaceRoute(activeSpace?.slug, '/chat?workbench=1')}
                      style={{ textDecoration: 'none' }}
                    >
                      <Button variant="primary" size="sm">
                        Review in Workbench
                      </Button>
                    </Link>
                  )}
                </Row>
              </CardBody>
            </Card>

            {pendingRequests.length === 0 && reviewedRequests.length === 0 && (
              <Card>
                <CardBody>
                  <Text size="xs" variant="muted" style={{ padding: 'var(--space-2)' }}>
                    No egress requests.
                  </Text>
                </CardBody>
              </Card>
            )}

            {/* Reviewed history */}
            {reviewedRequests.length > 0 && (
              <Column gap="xs">
                <Text size="xs" weight="medium" variant="muted">
                  Review History
                </Text>
                <Card>
                  <CardBody>
                    <Column gap="sm">
                      {reviewedRequests.map((req) => (
                        <Row key={req.requestId} gap="sm" align="center" justify="between">
                          <Column gap="xs" style={{ flex: 1 }}>
                            <Row gap="sm" align="center">
                              <Text size="xs">{req.requestedHosts.join(', ')}</Text>
                              <Badge variant={req.status === 'approved' ? 'success' : 'danger'}>
                                {req.status}
                              </Badge>
                            </Row>
                            <Text size="xs" variant="muted">
                              {req.reviewedBy && req.reviewedAt
                                ? `${req.status === 'approved' ? 'Approved' : 'Rejected'} by ${req.reviewedBy} on ${formatDate(req.reviewedAt)}`
                                : `Requested by ${req.requestedBy} on ${formatDate(req.requestedAt)}`}
                            </Text>
                          </Column>
                        </Row>
                      ))}
                    </Column>
                  </CardBody>
                </Card>
              </Column>
            )}
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
