'use client';

import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Text,
  Icon,
  Button,
  EmptyState,
} from '@aflow/design-system';
import { useSpace } from '../components/providers.js';
import { useSpaceOAuthClients } from '../hooks/use-space-oauth-clients.js';
import { OAuthClientsSection } from '../components/oauth-apps/OAuthClientsSection.js';

// ---------------------------------------------------------------------------
// Space settings → OAuth Apps (Plan 185 §11, O3)
// ---------------------------------------------------------------------------
//
// Space-admin surface. Registers/rotates/deletes the space's own OAuth client
// apps (multi-org tenant / freemium BYO-app). Token identity-ownership policy is
// tenant-level — this surface only manages the OAuth app (client) credentials.

export function SpaceOAuthAppsPage() {
  const { activeSpace, activeSpaceId, isLoading: spacesLoading } = useSpace();
  const isSpaceAdmin = activeSpace?.myRole === 'admin';

  const { clients, isLoading, error, refetch, createClient, rotateSecret, deleteClient } =
    useSpaceOAuthClients(activeSpaceId ?? '');

  if (spacesLoading) {
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
        <EmptyState title="No space selected" description="Select a space from the sidebar." />
      </PageContainer>
    );
  }

  if (!isSpaceAdmin) {
    return (
      <PageContainer>
        <EmptyState
          title="Space admin required"
          description="Only space admins can manage OAuth apps for this space."
        />
      </PageContainer>
    );
  }

  if (isLoading) {
    return (
      <PageContainer>
        <Text variant="muted" size="sm">
          Loading OAuth apps...
        </Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Column gap="lg">
        {error && (
          <Card>
            <CardBody>
              <Row gap="sm" style={{ alignItems: 'center' }}>
                <Icon name="warning-circle" size="sm" style={{ color: 'var(--color-danger)' }} />
                <Text size="sm" style={{ color: 'var(--color-danger)', flex: 1 }}>
                  {error.message}
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    refetch();
                  }}
                >
                  Retry
                </Button>
              </Row>
            </CardBody>
          </Card>
        )}

        <OAuthClientsSection
          title="Space OAuth apps"
          description="Register OAuth applications for this space. New OAuth bindings set to a space app will use these client credentials."
          clients={clients}
          onRegister={(input) => createClient.mutateAsync(input)}
          onRotateSecret={(input) =>
            rotateSecret.mutateAsync({ id: input.id, body: { clientSecret: input.clientSecret } })
          }
          onDelete={(id) => deleteClient.mutateAsync({ id })}
        />
      </Column>
    </PageContainer>
  );
}
