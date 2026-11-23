'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Button,
  Text,
  Heading,
  Select,
  Field,
  Label,
  Icon,
  Badge,
} from '@aflow/design-system';
import { useQueryClient } from '@tanstack/react-query';
import {
  effectiveSpaceWritePolicy,
  requiresWriteApproval,
  resolveSpaceAutonomyPolicy,
  type ResolvedSpaceAutonomyPolicy,
  type SpaceAutonomy,
  type SpaceStoreUpdates,
} from '@aflow/schemas';
import { useApi, useSpace } from '../components/providers.js';
import { useApiQuery } from '../hooks/useApiQuery.js';

// Mirrors SpaceWriteApprovalPolicySchema in @aflow/schemas.
type WriteTier = 'low' | 'medium' | 'high';
interface SpaceWritePolicy {
  requireApprovalByTier?: Partial<Record<WriteTier, boolean>>;
}

// The default for a tier left unspecified, which the space's autonomy composes
// (Plan 345 D): under `full` a medium write runs unattended, under `ratify` it waits.
function tierDefaultGated(tier: WriteTier, autonomy: SpaceAutonomy): boolean {
  return requiresWriteApproval(tier, effectiveSpaceWritePolicy(null, autonomy));
}

const TIER_INFO: Record<WriteTier, { label: string; blurb: string }> = {
  low: {
    label: 'Low',
    blurb: 'Internal, reversible writes — post a message, create an issue, add a record.',
  },
  medium: {
    label: 'Medium',
    blurb: 'External sends or hard-to-undo changes — email/SMS, merge a PR, delete one thing.',
  },
  high: {
    label: 'High',
    blurb: 'Financial or destructive at scale — charges, refunds, bulk or irreversible deletes.',
  },
};

const AUTONOMY_INFO: Record<SpaceAutonomy, { label: string; blurb: string }> = {
  full: {
    label: 'Full autonomy',
    blurb:
      'The Helmsman and the skills decide and act, and you are informed. Store installs, Store updates and merges on a comment review verdict run without a click. Only a credential waits on you.',
  },
  ratify: {
    label: 'Ask first',
    blurb:
      'The space asks you before it acts. A Store install is a proposal you ratify, a Store update is yours to apply, and a merge on a comment review verdict waits for you.',
  },
};

const STORE_UPDATES_INFO: Record<SpaceStoreUpdates, { label: string; blurb: string }> = {
  'follow-catalog': {
    label: 'Follow the catalog',
    blurb:
      'Under full autonomy, the space applies a Store update when the catalog moves past an installed version and tells the Helmsman what changed.',
  },
  manual: {
    label: 'Manual',
    blurb: 'An update is applied only from the Store page, or by the Helmsman when you ask.',
  },
};

type Setting = 'default' | 'gate' | 'allow';

function settingFor(override: boolean | undefined): Setting {
  if (override === undefined) return 'default';
  return override ? 'gate' : 'allow';
}

export function SpaceWritePolicyPage() {
  const { apiUrl, headers } = useApi();
  const { activeSpace, activeSpaceId, isLoading: spacesLoading } = useSpace();
  const queryClient = useQueryClient();

  const [policy, setPolicy] = useState<SpaceWritePolicy>({});
  const [savedPolicy, setSavedPolicy] = useState<SpaceWritePolicy | null>(null);
  // The defaults shown depend on the autonomy, so a failed read of it is an
  // error rather than a guess at which default holds.
  const autonomyQuery = useApiQuery<{ autonomyPolicy: unknown }>({
    key: ['space', activeSpaceId ?? '', 'autonomy'] as const,
    path: `/spaces/${activeSpaceId ?? ''}/autonomy`,
    enabled: Boolean(activeSpaceId),
  });
  const savedAutonomy = useMemo<ResolvedSpaceAutonomyPolicy | undefined>(
    () =>
      autonomyQuery.data === undefined
        ? undefined
        : resolveSpaceAutonomyPolicy(autonomyQuery.data.autonomyPolicy),
    [autonomyQuery.data],
  );
  const [autonomySetting, setAutonomySetting] = useState<ResolvedSpaceAutonomyPolicy | null>(null);
  useEffect(() => {
    if (savedAutonomy !== undefined) setAutonomySetting(savedAutonomy);
  }, [savedAutonomy]);
  // The tier defaults below follow the posture being chosen, so the page shows
  // what a save would leave gated before it is saved.
  const autonomy: SpaceAutonomy | undefined = autonomySetting?.autonomy ?? savedAutonomy?.autonomy;
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  const fetchPolicy = useCallback(async () => {
    if (!activeSpaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/write-policy`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!res.ok) throw new Error('Failed to load write policy');
      const data = (await res.json()) as { writePolicy: SpaceWritePolicy | null };
      const loaded = data.writePolicy ?? {};
      setPolicy(loaded);
      setSavedPolicy(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load write policy');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const policyChanged =
    savedPolicy !== null && JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  const autonomyChanged =
    savedAutonomy !== undefined &&
    autonomySetting !== null &&
    (autonomySetting.autonomy !== savedAutonomy.autonomy ||
      autonomySetting.storeUpdates !== savedAutonomy.storeUpdates);
  const hasChanges = policyChanged || autonomyChanged;

  const setTier = (tier: WriteTier, setting: Setting) => {
    setPolicy((prev) => {
      const next: Partial<Record<WriteTier, boolean>> = { ...prev.requireApprovalByTier };
      if (setting === 'default') delete next[tier];
      else next[tier] = setting === 'gate';
      return Object.keys(next).length > 0 ? { requireApprovalByTier: next } : {};
    });
  };

  const handleSave = useCallback(async () => {
    if (!activeSpaceId || !hasChanges) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      if (autonomyChanged) {
        const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/autonomy`, {
          method: 'PUT',
          headers: {
            ...headers(),
            'Content-Type': 'application/json',
            'X-Space-ID': activeSpaceId,
          },
          body: JSON.stringify({ autonomyPolicy: autonomySetting }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(err.message ?? 'Failed to save the autonomy');
        }
      }
      if (policyChanged) {
        const body: SpaceWritePolicy | null =
          Object.keys(policy.requireApprovalByTier ?? {}).length > 0 ? policy : null;
        const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/write-policy`, {
          method: 'PUT',
          headers: {
            ...headers(),
            'Content-Type': 'application/json',
            'X-Space-ID': activeSpaceId,
          },
          body: JSON.stringify({ writePolicy: body }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(err.message ?? 'Failed to save');
        }
        const data = (await res.json()) as { writePolicy: SpaceWritePolicy | null };
        const updated = data.writePolicy ?? {};
        setPolicy(updated);
        setSavedPolicy(updated);
      }
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
  }, [
    activeSpaceId,
    hasChanges,
    autonomyChanged,
    autonomySetting,
    policyChanged,
    policy,
    apiUrl,
    headers,
    queryClient,
  ]);

  if (activeSpace && (error !== null || autonomyQuery.isError)) {
    return (
      <PageContainer>
        <Row justify="center" gap="sm" align="center" style={{ padding: 'var(--space-8)' }}>
          <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
          <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
            {error ?? 'Failed to load the space autonomy'}
          </Text>
        </Row>
      </PageContainer>
    );
  }

  if (spacesLoading || isLoading || (activeSpace && autonomy === undefined)) {
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

  if (!activeSpace || autonomy === undefined) {
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

  const highUnGated = policy.requireApprovalByTier?.high === false;

  return (
    <PageContainer>
      <Column gap="lg">
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

        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Autonomy</Heading>
              <Text size="xs" variant="muted">
                Who decides what this space does next. The Helmsman can also set this when you tell
                it to in chat.
              </Text>
            </Column>
            <Card>
              <CardBody>
                <Column gap="md">
                  <Row gap="sm" align="center" justify="between" wrap>
                    <Column gap="xs" style={{ flex: '1 1 220px', minWidth: 0 }}>
                      <Row gap="sm" align="center" wrap>
                        <Text size="sm" weight="medium">
                          Posture
                        </Text>
                        <Badge variant={autonomy === 'full' ? 'info' : 'warning'}>
                          {AUTONOMY_INFO[autonomy].label}
                        </Badge>
                      </Row>
                      <Text size="xs" variant="muted">
                        {AUTONOMY_INFO[autonomy].blurb}
                      </Text>
                    </Column>
                    <div style={{ flex: '1 1 200px', maxWidth: 280 }}>
                      <Field>
                        <Label>Posture</Label>
                        <Select
                          value={autonomy}
                          onChange={(e) => {
                            const next = e.target.value as SpaceAutonomy;
                            setAutonomySetting((prev) => ({
                              autonomy: next,
                              storeUpdates:
                                prev?.storeUpdates ??
                                savedAutonomy?.storeUpdates ??
                                'follow-catalog',
                            }));
                          }}
                          disabled={!isSpaceAdmin}
                        >
                          <option value="ratify">{AUTONOMY_INFO.ratify.label}</option>
                          <option value="full">{AUTONOMY_INFO.full.label}</option>
                        </Select>
                      </Field>
                    </div>
                  </Row>
                  <div
                    style={{ borderTop: '1px solid var(--color-border-subtle)', margin: '4px 0' }}
                  />
                  <Row gap="sm" align="center" justify="between" wrap>
                    <Column gap="xs" style={{ flex: '1 1 220px', minWidth: 0 }}>
                      <Text size="sm" weight="medium">
                        Store updates
                      </Text>
                      <Text size="xs" variant="muted">
                        {
                          STORE_UPDATES_INFO[
                            autonomySetting?.storeUpdates ??
                              savedAutonomy?.storeUpdates ??
                              'follow-catalog'
                          ].blurb
                        }
                      </Text>
                    </Column>
                    <div style={{ flex: '1 1 200px', maxWidth: 280 }}>
                      <Field>
                        <Label>Store updates</Label>
                        <Select
                          value={
                            autonomySetting?.storeUpdates ??
                            savedAutonomy?.storeUpdates ??
                            'follow-catalog'
                          }
                          onChange={(e) => {
                            const next = e.target.value as SpaceStoreUpdates;
                            setAutonomySetting((prev) => ({
                              autonomy: prev?.autonomy ?? autonomy,
                              storeUpdates: next,
                            }));
                          }}
                          disabled={!isSpaceAdmin}
                        >
                          <option value="follow-catalog">
                            {STORE_UPDATES_INFO['follow-catalog'].label}
                          </option>
                          <option value="manual">{STORE_UPDATES_INFO.manual.label}</option>
                        </Select>
                      </Field>
                    </div>
                  </Row>
                </Column>
              </CardBody>
            </Card>
          </Column>
        </section>

        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Write Approval</Heading>
              <Text size="xs" variant="muted">
                When an agent makes a write call (post a message, send an email, merge a PR, charge
                a card), its endpoint&rsquo;s risk tier decides whether a human must approve it
                first in the Action Center. The defaults follow the space&rsquo;s autonomy, which is{' '}
                <strong>{autonomy}</strong> here. Under full, low and medium writes run unattended
                and high writes wait for approval. Under ratify, the default, medium writes wait for
                approval too. Override a tier here only when this space needs it. Read-only calls
                are never gated.
              </Text>
            </Column>

            <Card>
              <CardBody>
                <Column gap="md">
                  {(['low', 'medium', 'high'] as WriteTier[]).map((tier, i) => {
                    const override = policy.requireApprovalByTier?.[tier];
                    const effectiveGated = override ?? tierDefaultGated(tier, autonomy);
                    return (
                      <Column key={tier} gap="xs">
                        {i > 0 && (
                          <div
                            style={{
                              borderTop: '1px solid var(--color-border-subtle)',
                              margin: '4px 0',
                            }}
                          />
                        )}
                        <Row gap="sm" align="center" justify="between" wrap>
                          <Column gap="xs" style={{ flex: '1 1 220px', minWidth: 0 }}>
                            <Row gap="sm" align="center" wrap>
                              <Text size="sm" weight="medium">
                                {TIER_INFO[tier].label}
                              </Text>
                              <Badge variant={effectiveGated ? 'warning' : 'neutral'}>
                                {effectiveGated ? 'requires approval' : 'runs unattended'}
                              </Badge>
                              {override !== undefined && <Badge variant="info">overridden</Badge>}
                            </Row>
                            <Text size="xs" variant="muted">
                              {TIER_INFO[tier].blurb}
                            </Text>
                          </Column>
                          <div style={{ flex: '1 1 200px', maxWidth: 280 }}>
                            <Field>
                              <Label>Policy</Label>
                              <Select
                                value={settingFor(override)}
                                onChange={(e) => {
                                  setTier(tier, e.target.value as Setting);
                                }}
                                disabled={!isSpaceAdmin}
                              >
                                <option value="default">
                                  Default (
                                  {tierDefaultGated(tier, autonomy)
                                    ? 'require approval'
                                    : 'unattended'}
                                  )
                                </option>
                                <option value="gate">Require approval</option>
                                <option value="allow">Run unattended</option>
                              </Select>
                            </Field>
                          </div>
                        </Row>
                      </Column>
                    );
                  })}
                </Column>
              </CardBody>
            </Card>

            {highUnGated && (
              <Card>
                <CardBody>
                  <Row gap="sm" align="center">
                    <Icon name="warning" size="sm" color="var(--color-status-failed-fg)" />
                    <Text size="sm" style={{ color: 'var(--color-status-failed-fg)' }}>
                      High-risk writes (financial / destructive) will run WITHOUT approval in this
                      space. Only do this for a trusted, deliberately-automated space.
                    </Text>
                  </Row>
                </CardBody>
              </Card>
            )}
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
