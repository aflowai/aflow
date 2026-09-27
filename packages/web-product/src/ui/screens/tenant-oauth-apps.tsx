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
} from '@aflow/design-system';
import { useTenantOAuthClients } from '../hooks/use-tenant-oauth-clients.js';
import { OAuthClientsSection } from '../components/oauth-apps/OAuthClientsSection.js';
import { TenantOAuthPolicyEditor } from '../components/oauth-apps/TenantOAuthPolicyEditor.js';

// ---------------------------------------------------------------------------
// Tenant settings → OAuth Apps (Plan 185 §11)
// ---------------------------------------------------------------------------
//
// Tenant-admin surface (gated by the settings layout). Registers/rotates/deletes
// the tenant's own OAuth client apps and edits the per-tenant default policy.

export function TenantOAuthAppsPage() {
  const {
    clients,
    policy,
    isLoading,
    error,
    refetch,
    createClient,
    rotateSecret,
    deleteClient,
    updatePolicy,
  } = useTenantOAuthClients();

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
      <Column gap="2xl">
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
          title="Tenant OAuth apps"
          description="Register your organization's own OAuth applications. New OAuth bindings set to a tenant app will use these client credentials."
          clients={clients}
          onRegister={(input) => createClient.mutateAsync(input)}
          onRotateSecret={(input) =>
            rotateSecret.mutateAsync({ id: input.id, body: { clientSecret: input.clientSecret } })
          }
          onDelete={(id) => deleteClient.mutateAsync({ id })}
        />

        {policy && (
          <TenantOAuthPolicyEditor
            policy={policy}
            onSave={(input) => updatePolicy.mutateAsync(input)}
          />
        )}
      </Column>
    </PageContainer>
  );
}
