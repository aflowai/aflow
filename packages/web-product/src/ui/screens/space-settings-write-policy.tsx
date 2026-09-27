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
  Select,
  Field,
  Label,
  Icon,
  Badge,
} from '@aflow/design-system';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useSpace } from '../components/providers.js';

// Mirrors SpaceWriteApprovalPolicySchema in @aflow/schemas.
type WriteTier = 'low' | 'medium' | 'high';
interface SpaceWritePolicy {
  requireApprovalByTier?: Partial<Record<WriteTier, boolean>>;
}

// The built-in default: does a tier require approval when unspecified?
const TIER_DEFAULT_GATED: Record<WriteTier, boolean> = { low: false, medium: true, high: true };

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

  const hasChanges = savedPolicy !== null && JSON.stringify(policy) !== JSON.stringify(savedPolicy);

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
      const body: SpaceWritePolicy | null =
        Object.keys(policy.requireApprovalByTier ?? {}).length > 0 ? policy : null;
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/write-policy`, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json', 'X-Space-ID': activeSpaceId },
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
  }, [activeSpaceId, hasChanges, policy, apiUrl, headers, queryClient]);

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
              <Heading level={5}>Write Approval</Heading>
              <Text size="xs" variant="muted">
                When an agent makes a write call (post a message, send an email, merge a PR, charge
                a card), its endpoint&rsquo;s risk tier decides whether a human must approve it
                first in the Action Center. These defaults are safe out of the box — override a tier
                here only when this space needs it. Read-only calls are never gated.
              </Text>
            </Column>

            <Card>
              <CardBody>
                <Column gap="md">
                  {(['low', 'medium', 'high'] as WriteTier[]).map((tier, i) => {
                    const override = policy.requireApprovalByTier?.[tier];
                    const effectiveGated = override ?? TIER_DEFAULT_GATED[tier];
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
                                  {TIER_DEFAULT_GATED[tier] ? 'require approval' : 'unattended'})
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
