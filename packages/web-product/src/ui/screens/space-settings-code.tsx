'use client';

import { useEffect, useState } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Button,
  Text,
  Heading,
  Icon,
  Checkbox,
  Badge,
} from '@aflow/design-system';
import type { SpaceCodePolicy } from '@aflow/schemas';
import { useSpace, useSpaceFromRoute } from '../components/providers.js';
import { useApiQuery, useApiMutation } from '../hooks/useApiQuery.js';

interface CodePolicyResponse {
  codePolicy: SpaceCodePolicy | null;
}

export function SpaceCodePolicyPage() {
  const { activeSpace, activeSpaceId, isLoading: spacesLoading } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? activeSpaceId ?? '';
  const policyKey = ['space', spaceId, 'codePolicy'] as const;

  const { data, isLoading, error } = useApiQuery<CodePolicyResponse>({
    key: policyKey,
    path: `/spaces/${spaceId}/code-policy`,
    enabled: spaceId.length > 0,
  });

  const savedEnabled = data?.codePolicy?.enabled ?? false;
  const [enabled, setEnabled] = useState(savedEnabled);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setEnabled(savedEnabled);
  }, [savedEnabled]);

  const save = useApiMutation<CodePolicyResponse, CodePolicyResponse>({
    path: `/spaces/${spaceId}/code-policy`,
    method: 'PUT',
    invalidate: [policyKey],
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
      }, 2000);
    },
  });

  const isSpaceAdmin = activeSpace?.myRole === 'admin';
  const hasChanges = enabled !== savedEnabled;

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
            {error?.message ?? 'No space selected'}
          </Text>
        </Row>
      </PageContainer>
    );
  }

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
            disabled={!hasChanges || !isSpaceAdmin || save.isPending}
            onClick={() => {
              save.mutate({ codePolicy: { enabled } });
            }}
          >
            {save.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </Row>

        <section>
          <Column gap="md">
            <Column gap="xs">
              <Heading level={5}>Coding Lane</Heading>
              <Text size="xs" variant="muted">
                The coding lane runs a coding agent against a real git repository — it has network
                egress and repository credentials, unlike the sandboxed compute lane. It is off
                until an admin turns it on, and every push still goes through a repository you
                designate under Integrations.
              </Text>
            </Column>

            <Card>
              <CardBody>
                <Row gap="sm" align="center" justify="between">
                  <Column gap="xs">
                    <Text size="sm" weight="medium">
                      Enable the coding lane
                    </Text>
                    <Text size="xs" variant="muted">
                      When disabled, all coding operations in this space are rejected.
                    </Text>
                  </Column>
                  <Row gap="sm" align="center">
                    <Badge variant={enabled ? 'success' : 'neutral'}>
                      {enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    <Checkbox
                      checked={enabled}
                      onChange={(e) => {
                        setEnabled(e.target.checked);
                      }}
                      disabled={!isSpaceAdmin}
                    />
                  </Row>
                </Row>
              </CardBody>
            </Card>
          </Column>
        </section>
      </Column>
    </PageContainer>
  );
}
