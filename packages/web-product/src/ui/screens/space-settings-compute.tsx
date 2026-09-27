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
  Select,
  Label,
  Field,
  HelperText,
  Icon,
  Checkbox,
  Badge,
} from '@aflow/design-system';
import { useQueryClient } from '@tanstack/react-query';
import type { ComputeAvailability } from '@aflow/schemas';
import { useApi, useSpace } from '../components/providers.js';

/** What the deployment can currently do, beside what the policy says. */
function ComputeRuntimeState({
  availability,
}: {
  availability: ComputeAvailability | null;
}): React.ReactElement | null {
  if (availability === null) return null;
  if (availability.composed === 'absent') {
    return (
      <Text size="xs" variant="muted">
        This instance ships no compute runtime, so sandboxed code cannot run here whatever this
        policy says. Start it with the compute profile to change that.
      </Text>
    );
  }
  if (availability.executor === 'down') {
    return (
      <Row gap="xs" align="center">
        <Badge variant="warning">Executor not running</Badge>
        <Text size="xs" variant="muted">
          This deployment carries a compute runtime, but nothing is answering for it right now.
          Compute steps will fail until it is back.
        </Text>
      </Row>
    );
  }
  if (availability.executor === 'unknown') {
    return (
      <Text size="xs" variant="muted">
        Whether a compute executor is running could not be determined.
      </Text>
    );
  }
  return null;
}

// ============================================================================
// Types — mirrors schemas from @aflow/schemas
// ============================================================================

interface ComputeNetworkPolicy {
  mode: 'blocked' | 'allowlist';
  allowedHosts?: string[];
}

interface ComputeResourceLimits {
  maxCpus: number;
  maxMemoryMb: number;
  maxExecutionSeconds: number;
}

interface ComputeSessionPolicy {
  enabled: boolean;
  maxIdleTtlSeconds: number;
  maxCheckpointTtlSeconds: number;
  maxSessionLifetimeSeconds: number;
  maxCheckpointSizeBytes: number;
  maxConcurrentSessions: number;
}

interface SpaceComputePolicy {
  enabled: boolean;
  networkEgress: ComputeNetworkPolicy;
  resources?: ComputeResourceLimits;
  maxConcurrentContainers: number;
  sessions?: ComputeSessionPolicy;
}

interface TenantComputeDefaults {
  approvedHosts: string[];
  presets: Array<{ name: string; description?: string; hosts: string[] }>;
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
// Defaults — match Zod schema defaults
// ============================================================================

const DEFAULT_POLICY: SpaceComputePolicy = {
  enabled: false,
  networkEgress: { mode: 'blocked' },
  resources: { maxCpus: 1, maxMemoryMb: 512, maxExecutionSeconds: 60 },
  maxConcurrentContainers: 5,
  sessions: {
    enabled: false,
    maxIdleTtlSeconds: 3600,
    maxCheckpointTtlSeconds: 86400,
    maxSessionLifetimeSeconds: 7200,
    maxCheckpointSizeBytes: 100_000_000,
    maxConcurrentSessions: 3,
  },
};

// ============================================================================
// Helpers
// ============================================================================

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function parseNum(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

function formatSeconds(s: number): string {
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
  if (s >= 60) return `${(s / 60).toFixed(0)}m`;
  return `${s}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============================================================================
// Number field component
// ============================================================================

function NumberField({
  label,
  helper,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  suffix,
}: {
  label: string;
  helper?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
}) {
  return (
    <Field>
      <Label>{label}</Label>
      <Row gap="sm" align="center">
        <Input
          type="number"
          value={String(value)}
          onChange={(e) => {
            onChange(clamp(parseNum(e.target.value, value), min, max));
          }}
          disabled={disabled}
          min={min}
          max={max}
          step={step ?? 1}
          style={{ maxWidth: 160 }}
        />
        {suffix && (
          <Text size="xs" variant="muted">
            {suffix}
          </Text>
        )}
      </Row>
      {helper && <HelperText>{helper}</HelperText>}
    </Field>
  );
}

// ============================================================================
// Divider
// ============================================================================

function SectionDivider() {
  return <div style={{ borderTop: '1px solid var(--color-border-subtle)', margin: '4px 0' }} />;
}

// ============================================================================
// Page
// ============================================================================

export function SpaceComputePage() {
  const { apiUrl, headers } = useApi();
  const { activeSpace, activeSpaceId, isLoading: spacesLoading } = useSpace();
  const queryClient = useQueryClient();

  const [policy, setPolicy] = useState<SpaceComputePolicy>(DEFAULT_POLICY);
  const [savedPolicy, setSavedPolicy] = useState<SpaceComputePolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [availability, setAvailability] = useState<ComputeAvailability | null>(null);
  const [tenantDefaults, setTenantDefaults] = useState<TenantComputeDefaults | null>(null);
  const [pendingRequests, setPendingRequests] = useState<EgressApprovalRequest[]>([]);

  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  // --------------------------------------------------------------------------
  // Fetch
  // --------------------------------------------------------------------------

  const fetchPolicy = useCallback(async () => {
    if (!activeSpaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/compute-policy`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!res.ok) throw new Error('Failed to load compute policy');
      const data = (await res.json()) as {
        computePolicy: SpaceComputePolicy | null;
        computeAvailability?: ComputeAvailability;
      };
      setAvailability(data.computeAvailability ?? null);
      const loaded = data.computePolicy ?? DEFAULT_POLICY;
      const merged: SpaceComputePolicy = {
        ...DEFAULT_POLICY,
        ...loaded,
        networkEgress: { ...DEFAULT_POLICY.networkEgress, ...loaded.networkEgress },
        resources: { ...DEFAULT_POLICY.resources!, ...loaded.resources },
        sessions: { ...DEFAULT_POLICY.sessions!, ...loaded.sessions },
      };
      setPolicy(merged);
      setSavedPolicy(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compute policy');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers, activeSpaceId]);

  const fetchTenantDefaults = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/tenant/compute-defaults`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as { computeDefaults: TenantComputeDefaults | null };
        setTenantDefaults(data.computeDefaults);
      }
    } catch {
      // Non-critical — degrade gracefully without tenant defaults
    }
  }, [apiUrl, headers]);

  const fetchPendingRequests = useCallback(async () => {
    try {
      const url = activeSpaceId
        ? `${apiUrl}/tenant/egress-requests?spaceId=${activeSpaceId}`
        : `${apiUrl}/tenant/egress-requests`;
      const res = await fetch(url, { headers: headers() });
      if (res.ok) {
        const data = (await res.json()) as { requests: EgressApprovalRequest[] };
        setPendingRequests(data.requests);
      }
    } catch {
      // Non-critical
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchPolicy();
    void fetchTenantDefaults();
    void fetchPendingRequests();
  }, [fetchPolicy, fetchTenantDefaults, fetchPendingRequests]);

  // --------------------------------------------------------------------------
  // Change tracking
  // --------------------------------------------------------------------------

  const hasChanges = savedPolicy !== null && JSON.stringify(policy) !== JSON.stringify(savedPolicy);

  // --------------------------------------------------------------------------
  // Save
  // --------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!activeSpaceId || !hasChanges) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/compute-policy`, {
        method: 'PUT',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'X-Space-ID': activeSpaceId,
        },
        body: JSON.stringify({ computePolicy: policy }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? 'Failed to save');
      }
      const data = (await res.json()) as {
        computePolicy: SpaceComputePolicy | null;
        computeAvailability?: ComputeAvailability;
      };
      setAvailability(data.computeAvailability ?? null);
      const updated = data.computePolicy ?? DEFAULT_POLICY;
      const merged: SpaceComputePolicy = {
        ...DEFAULT_POLICY,
        ...updated,
        networkEgress: { ...DEFAULT_POLICY.networkEgress, ...updated.networkEgress },
        resources: { ...DEFAULT_POLICY.resources!, ...updated.resources },
        sessions: { ...DEFAULT_POLICY.sessions!, ...updated.sessions },
      };
      setPolicy(merged);
      setSavedPolicy(merged);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [activeSpaceId, hasChanges, policy, apiUrl, headers]);

  // --------------------------------------------------------------------------
  // Updaters
  // --------------------------------------------------------------------------

  const updatePolicy = (patch: Partial<SpaceComputePolicy>) => {
    setPolicy((prev) => ({ ...prev, ...patch }));
  };

  const updateResources = (patch: Partial<ComputeResourceLimits>) => {
    setPolicy((prev) => ({
      ...prev,
      resources: { ...DEFAULT_POLICY.resources!, ...prev.resources, ...patch },
    }));
  };

  const updateSessions = (patch: Partial<ComputeSessionPolicy>) => {
    setPolicy((prev) => ({
      ...prev,
      sessions: { ...DEFAULT_POLICY.sessions!, ...prev.sessions, ...patch },
    }));
  };

  const updateNetwork = (patch: Partial<ComputeNetworkPolicy>) => {
    setPolicy((prev) => ({
      ...prev,
      networkEgress: { ...prev.networkEgress, ...patch },
    }));
  };

  // --------------------------------------------------------------------------
  // Derived state
  // --------------------------------------------------------------------------

  const tenantHosts = tenantDefaults?.approvedHosts ?? [];
  const spaceLocalHosts = (policy.networkEgress.allowedHosts ?? []).filter(
    (h) => !tenantHosts.includes(h),
  );

  const activePending = pendingRequests.filter((r) => r.status === 'pending_approval');

  // --------------------------------------------------------------------------
  // Loading / empty states
  // --------------------------------------------------------------------------

  if (spacesLoading || isLoading) {
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

  if (!activeSpace) {
    return (
      <PageContainer>
        <Row justify="center" style={{ padding: 'var(--space-8)' }}>
          <Text variant="muted" size="sm">
            {error ?? 'No space selected'}
          </Text>
        </Row>
      </PageContainer>
    );
  }

  const res = policy.resources ?? DEFAULT_POLICY.resources!;
  const sess = policy.sessions ?? DEFAULT_POLICY.sessions!;

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
        {saveError && (
          <Card>
            <CardBody>
              <Row gap="sm" align="center">
                <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
                <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
                  {saveError}
                </Text>
              </Row>
            </CardBody>
          </Card>
        )}

        {/* ---- Enable / Disable ---- */}
        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Sandboxed Code Execution</Heading>
              <Text size="xs" variant="muted">
                Allow agents in this space to execute code in sandboxed Docker containers. Compute
                is disabled by default and requires Docker infrastructure to be available.
              </Text>
              <ComputeRuntimeState availability={availability} />
            </Column>

            <Card>
              <CardBody>
                <Row gap="sm" align="center" justify="between">
                  <Column gap="xs">
                    <Text size="sm" weight="medium">
                      Enable compute
                    </Text>
                    <Text size="xs" variant="muted">
                      When disabled, all compute operations in this space will be rejected.
                    </Text>
                  </Column>
                  <Row gap="sm" align="center">
                    <Badge variant={policy.enabled ? 'success' : 'neutral'}>
                      {policy.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    <Checkbox
                      checked={policy.enabled}
                      onChange={(e) => {
                        updatePolicy({ enabled: e.target.checked });
                      }}
                      disabled={!isSpaceAdmin}
                    />
                  </Row>
                </Row>
              </CardBody>
            </Card>
          </Column>
        </section>

        {/* Only show remaining sections when compute is enabled */}
        {policy.enabled && (
          <>
            {/* ---- Resource Limits ---- */}
            <section>
              <Column gap="md">
                <Column gap="xs">
                  <Heading level={5}>Resource Limits</Heading>
                  <Text size="xs" variant="muted">
                    Maximum resources each container can use. Agents may request less via runtime
                    presets (quick, standard, ml-training).
                  </Text>
                </Column>

                <Card>
                  <CardBody>
                    <Column gap="md">
                      <NumberField
                        label="Max CPUs"
                        value={res.maxCpus}
                        onChange={(v) => {
                          updateResources({ maxCpus: v });
                        }}
                        min={1}
                        max={4}
                        disabled={!isSpaceAdmin}
                        helper="1-4 CPUs per container"
                      />
                      <SectionDivider />
                      <NumberField
                        label="Max Memory"
                        value={res.maxMemoryMb}
                        onChange={(v) => {
                          updateResources({ maxMemoryMb: v });
                        }}
                        min={128}
                        max={8192}
                        step={128}
                        disabled={!isSpaceAdmin}
                        suffix="MB"
                        helper={`128-8192 MB (${formatBytes(res.maxMemoryMb * 1_000_000)})`}
                      />
                      <SectionDivider />
                      <NumberField
                        label="Max Execution Time"
                        value={res.maxExecutionSeconds}
                        onChange={(v) => {
                          updateResources({ maxExecutionSeconds: v });
                        }}
                        min={5}
                        max={3600}
                        step={5}
                        disabled={!isSpaceAdmin}
                        suffix="seconds"
                        helper={`5-3600 seconds (${formatSeconds(res.maxExecutionSeconds)})`}
                      />
                      <SectionDivider />
                      <NumberField
                        label="Max Concurrent Containers"
                        value={policy.maxConcurrentContainers}
                        onChange={(v) => {
                          updatePolicy({ maxConcurrentContainers: v });
                        }}
                        min={1}
                        max={20}
                        disabled={!isSpaceAdmin}
                        helper="Max containers running simultaneously in this space (1-20)"
                      />
                    </Column>
                  </CardBody>
                </Card>
              </Column>
            </section>

            {/* ---- Sessions ---- */}
            <section>
              <Column gap="md">
                <Column gap="xs">
                  <Heading level={5}>Sessions</Heading>
                  <Text size="xs" variant="muted">
                    Warm containers that persist across multiple executions within a run. Useful for
                    iterative workflows where agents install packages or build state incrementally.
                  </Text>
                </Column>

                <Card>
                  <CardBody>
                    <Column gap="md">
                      <Row gap="sm" align="center" justify="between">
                        <Column gap="xs">
                          <Text size="sm" weight="medium">
                            Enable sessions
                          </Text>
                          <Text size="xs" variant="muted">
                            Allow containers to stay warm between executions.
                          </Text>
                        </Column>
                        <Row gap="sm" align="center">
                          <Badge variant={sess.enabled ? 'success' : 'neutral'}>
                            {sess.enabled ? 'On' : 'Off'}
                          </Badge>
                          <Checkbox
                            checked={sess.enabled}
                            onChange={(e) => {
                              updateSessions({ enabled: e.target.checked });
                            }}
                            disabled={!isSpaceAdmin}
                          />
                        </Row>
                      </Row>

                      {sess.enabled && (
                        <>
                          <SectionDivider />
                          <NumberField
                            label="Max Concurrent Sessions"
                            value={sess.maxConcurrentSessions}
                            onChange={(v) => {
                              updateSessions({ maxConcurrentSessions: v });
                            }}
                            min={1}
                            max={10}
                            disabled={!isSpaceAdmin}
                            helper="Max warm containers per space (1-10)"
                          />
                          <SectionDivider />
                          <NumberField
                            label="Idle Timeout"
                            value={sess.maxIdleTtlSeconds}
                            onChange={(v) => {
                              updateSessions({ maxIdleTtlSeconds: v });
                            }}
                            min={60}
                            max={7200}
                            step={60}
                            disabled={!isSpaceAdmin}
                            suffix="seconds"
                            helper={`Time before an idle session is stopped (${formatSeconds(sess.maxIdleTtlSeconds)})`}
                          />
                          <SectionDivider />
                          <NumberField
                            label="Max Session Lifetime"
                            value={sess.maxSessionLifetimeSeconds}
                            onChange={(v) => {
                              updateSessions({ maxSessionLifetimeSeconds: v });
                            }}
                            min={300}
                            max={14400}
                            step={300}
                            disabled={!isSpaceAdmin}
                            suffix="seconds"
                            helper={`Absolute max time a session can live (${formatSeconds(sess.maxSessionLifetimeSeconds)})`}
                          />
                          <SectionDivider />
                          <NumberField
                            label="Checkpoint TTL"
                            value={sess.maxCheckpointTtlSeconds}
                            onChange={(v) => {
                              updateSessions({ maxCheckpointTtlSeconds: v });
                            }}
                            min={3600}
                            max={259200}
                            step={3600}
                            disabled={!isSpaceAdmin}
                            suffix="seconds"
                            helper={`How long saved checkpoints persist (${formatSeconds(sess.maxCheckpointTtlSeconds)})`}
                          />
                          <SectionDivider />
                          <NumberField
                            label="Max Checkpoint Size"
                            value={sess.maxCheckpointSizeBytes}
                            onChange={(v) => {
                              updateSessions({ maxCheckpointSizeBytes: v });
                            }}
                            min={1_000_000}
                            max={500_000_000}
                            step={1_000_000}
                            disabled={!isSpaceAdmin}
                            suffix="bytes"
                            helper={`Max size per checkpoint (${formatBytes(sess.maxCheckpointSizeBytes)})`}
                          />
                        </>
                      )}
                    </Column>
                  </CardBody>
                </Card>
              </Column>
            </section>

            {/* ---- Network Egress ---- */}
            <section>
              <Column gap="md">
                <Column gap="xs">
                  <Heading level={5}>Network Egress</Heading>
                  <Text size="xs" variant="muted">
                    Control whether containers can make outbound network requests. Blocked by
                    default for security. Hosts can be inherited from tenant defaults or added
                    locally for this space.
                  </Text>
                </Column>

                <Card>
                  <CardBody>
                    <Column gap="md">
                      <Field>
                        <Label>Egress Mode</Label>
                        <Select
                          value={policy.networkEgress.mode}
                          onChange={(e) => {
                            updateNetwork({
                              mode: e.target.value as 'blocked' | 'allowlist',
                            });
                          }}
                          disabled={!isSpaceAdmin}
                        >
                          <option value="blocked">Blocked (no outbound network)</option>
                          <option value="allowlist">Allowlist (specific hosts only)</option>
                        </Select>
                        <HelperText>
                          {policy.networkEgress.mode === 'blocked'
                            ? 'Containers cannot make any outbound network requests.'
                            : 'Containers can only reach hosts in the allowlist below.'}
                        </HelperText>
                      </Field>

                      {policy.networkEgress.mode === 'allowlist' && (
                        <>
                          <SectionDivider />

                          {/* Inherited tenant hosts */}
                          {tenantHosts.length > 0 && (
                            <Column gap="sm">
                              <Row gap="xs" align="center">
                                <Label>Inherited from Tenant</Label>
                                <Badge variant="neutral">tenant defaults</Badge>
                              </Row>
                              <Text size="xs" variant="muted">
                                These hosts are approved at the tenant level and available to all
                                spaces. Manage them in Tenant Admin &rarr; Compute.
                              </Text>
                              {tenantHosts.map((host, i) => (
                                <Row key={`tenant-${i}`} gap="sm" align="center">
                                  <Input
                                    value={host}
                                    disabled
                                    style={{
                                      flex: 1,
                                      opacity: 0.7,
                                      fontStyle: 'italic',
                                    }}
                                  />
                                  <Badge variant="neutral">tenant</Badge>
                                </Row>
                              ))}
                              <SectionDivider />
                            </Column>
                          )}

                          {/* Space-local hosts */}
                          <Column gap="sm">
                            <Row gap="xs" align="center">
                              <Label>Space Hosts</Label>
                              {spaceLocalHosts.length > 0 && (
                                <Badge variant="info">{spaceLocalHosts.length} local</Badge>
                              )}
                            </Row>
                            <Text size="xs" variant="muted">
                              Additional hosts approved specifically for this space (max 50 total
                              including inherited).
                            </Text>
                            {(policy.networkEgress.allowedHosts ?? []).map((host, i) => {
                              const isInherited = tenantHosts.includes(host);
                              return (
                                <Row key={i} gap="sm" align="center">
                                  <Input
                                    value={host}
                                    onChange={(e) => {
                                      const hosts = [...(policy.networkEgress.allowedHosts ?? [])];
                                      hosts[i] = e.target.value;
                                      updateNetwork({ allowedHosts: hosts });
                                    }}
                                    disabled={!isSpaceAdmin || isInherited}
                                    placeholder="e.g., api.example.com"
                                    style={{
                                      flex: 1,
                                      ...(isInherited ? { opacity: 0.7, fontStyle: 'italic' } : {}),
                                    }}
                                  />
                                  {isInherited ? (
                                    <Badge variant="neutral">tenant</Badge>
                                  ) : (
                                    isSpaceAdmin && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                          const hosts = (
                                            policy.networkEgress.allowedHosts ?? []
                                          ).filter((_, idx) => idx !== i);
                                          updateNetwork({ allowedHosts: hosts });
                                        }}
                                      >
                                        <Icon name="trash" size="xs" />
                                      </Button>
                                    )
                                  )}
                                </Row>
                              );
                            })}
                            {isSpaceAdmin &&
                              (policy.networkEgress.allowedHosts ?? []).length < 50 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    updateNetwork({
                                      allowedHosts: [
                                        ...(policy.networkEgress.allowedHosts ?? []),
                                        '',
                                      ],
                                    });
                                  }}
                                >
                                  <Icon name="plus" size="xs" />
                                  Add Host
                                </Button>
                              )}
                          </Column>

                          {/* Tenant presets */}
                          {tenantDefaults?.presets && tenantDefaults.presets.length > 0 && (
                            <>
                              <SectionDivider />
                              <Column gap="sm">
                                <Label>Available Presets</Label>
                                <Text size="xs" variant="muted">
                                  Named host sets defined at the tenant level. Add a preset to
                                  quickly include its hosts.
                                </Text>
                                {tenantDefaults.presets.map((preset) => {
                                  const allIncluded = preset.hosts.every((h) =>
                                    (policy.networkEgress.allowedHosts ?? []).includes(h),
                                  );
                                  return (
                                    <Row
                                      key={preset.name}
                                      gap="sm"
                                      align="center"
                                      justify="between"
                                    >
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
                                      {isSpaceAdmin && !allIncluded && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => {
                                            const existing =
                                              policy.networkEgress.allowedHosts ?? [];
                                            const newHosts = preset.hosts.filter(
                                              (h) => !existing.includes(h),
                                            );
                                            updateNetwork({
                                              allowedHosts: [...existing, ...newHosts],
                                            });
                                          }}
                                        >
                                          <Icon name="plus" size="xs" />
                                          Add
                                        </Button>
                                      )}
                                      {allIncluded && <Badge variant="success">included</Badge>}
                                    </Row>
                                  );
                                })}
                              </Column>
                            </>
                          )}
                        </>
                      )}
                    </Column>
                  </CardBody>
                </Card>
              </Column>
            </section>

            {/* ---- Pending Egress Requests ---- */}
            {pendingRequests.length > 0 && (
              <section>
                <Column gap="md">
                  <Column gap="xs">
                    <Row gap="sm" align="center">
                      <Heading level={5}>Egress Requests</Heading>
                      {activePending.length > 0 && (
                        <Badge variant="warning">{activePending.length} pending</Badge>
                      )}
                    </Row>
                    <Text size="xs" variant="muted">
                      Requests for additional compute egress hosts affecting this space. Pending
                      requests are inactive until approved by a tenant admin.
                    </Text>
                  </Column>

                  <Card>
                    <CardBody>
                      <Column gap="md">
                        {pendingRequests.map((req) => (
                          <Column key={req.requestId} gap="xs">
                            <Row gap="sm" align="center" justify="between">
                              <Text size="sm" weight="medium">
                                {req.requestedHosts.join(', ')}
                              </Text>
                              <Badge
                                variant={
                                  req.status === 'approved'
                                    ? 'success'
                                    : req.status === 'rejected'
                                      ? 'danger'
                                      : 'warning'
                                }
                              >
                                {req.status === 'pending_approval' ? 'pending' : req.status}
                              </Badge>
                            </Row>
                            {req.reason && (
                              <Text size="xs" variant="muted">
                                {req.reason}
                              </Text>
                            )}
                            <Row gap="md">
                              <Text size="xs" variant="muted">
                                Requested by {req.requestedBy} on {formatDate(req.requestedAt)}
                              </Text>
                              {req.reviewedBy && req.reviewedAt && (
                                <Text size="xs" variant="muted">
                                  Reviewed by {req.reviewedBy} on {formatDate(req.reviewedAt)}
                                </Text>
                              )}
                            </Row>
                            <SectionDivider />
                          </Column>
                        ))}
                      </Column>
                    </CardBody>
                  </Card>
                </Column>
              </section>
            )}
          </>
        )}

        {/* Info card when disabled */}
        {!policy.enabled && (
          <Card>
            <CardBody>
              <Column gap="sm" align="center" style={{ padding: 'var(--space-4)' }}>
                <Text variant="muted" size="sm">
                  Compute is disabled for this space.
                </Text>
                <Text variant="muted" size="xs">
                  Enable it above to configure resource limits, sessions, and network policies.
                </Text>
              </Column>
            </CardBody>
          </Card>
        )}
      </Column>
    </PageContainer>
  );
}
