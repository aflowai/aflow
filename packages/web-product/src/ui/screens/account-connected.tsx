'use client';

import { useMemo, useState } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Text,
  Heading,
  Icon,
  Badge,
  Button,
} from '@aflow/design-system';
import { getAllOAuthIssuers, type OAuthConnection } from '@aflow/schemas';
import { useOAuthConnections } from '../hooks/use-oauth-connections.js';
import type { DisconnectInput } from '../hooks/use-oauth-connections.js';

// ---------------------------------------------------------------------------
// Per-user "Connected accounts" (Plan 185 §11)
// ---------------------------------------------------------------------------
//
// Lists the signed-in user's OAuth connections (owner_scope='user'). Each row
// shows the provider label, granted scopes, and a connected/expired status, plus
// a Disconnect action. New connections are initiated via the binding consent flow
// / Action Center "Connect" card — this surface shows + disconnects.

function connectionKey(c: OAuthConnection): string {
  return `${c.integrationKind}:${c.resourceKey}`;
}

/**
 * Resolve a docs link for a connection by matching its display name against the
 * curated issuer registry. The list endpoint carries no `issuerKey`, so the name
 * is the only join key available; an unmatched connection simply has no link.
 */
function issuerDocsUrl(displayName: string): string | undefined {
  const issuer = getAllOAuthIssuers().find(
    (i) => i.displayName.toLowerCase() === displayName.toLowerCase(),
  );
  return issuer?.docsUrl;
}

function ConnectionRow({
  connection,
  idx,
  pending,
  onDisconnect,
}: {
  connection: OAuthConnection;
  idx: number;
  pending: boolean;
  onDisconnect: () => void;
}) {
  const isExpired = connection.status === 'expired';
  const docsUrl = issuerDocsUrl(connection.displayName);

  return (
    <Row
      gap="md"
      wrap
      style={{
        padding: 'var(--space-3) var(--space-4)',
        alignItems: 'center',
        borderTop: idx > 0 ? '1px solid var(--color-border-subtle)' : undefined,
      }}
    >
      <Icon
        name="plugs-connected"
        size="md"
        style={{ color: 'var(--color-content-secondary)', flexShrink: 0 }}
      />
      <Column gap="0" style={{ flex: 1, minWidth: 0 }}>
        <Row gap="sm" style={{ alignItems: 'center' }}>
          <Text size="sm" weight="medium">
            {connection.displayName}
          </Text>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-content-link)', display: 'inline-flex' }}
              aria-label={`${connection.displayName} documentation`}
            >
              <Icon name="arrow-square-out" size="xs" />
            </a>
          )}
        </Row>
        <Text
          size="xs"
          variant="muted"
          style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {connection.scopes.length > 0
            ? connection.scopes.join(', ')
            : 'No scopes recorded for this connection'}
        </Text>
      </Column>
      <Badge variant={isExpired ? 'warning' : 'success'}>
        {isExpired ? 'Expired' : 'Connected'}
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDisconnect}
        loading={pending}
        style={{ color: 'var(--color-danger)' }}
      >
        Disconnect
      </Button>
    </Row>
  );
}

export function ConnectedAccountsPage() {
  const { connections, isLoading, error, refetch, disconnect } = useOAuthConnections();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...connections].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [connections],
  );

  const handleDisconnect = (connection: OAuthConnection) => {
    const input: DisconnectInput = {
      integrationKind: connection.integrationKind,
      resourceKey: connection.resourceKey,
    };
    setPendingKey(connectionKey(connection));
    setDisconnectError(null);
    disconnect.mutate(input, {
      onError: (err) => {
        setDisconnectError(err.message);
      },
      onSettled: () => {
        setPendingKey(null);
      },
    });
  };

  if (isLoading) {
    return (
      <PageContainer>
        <Text variant="muted" size="sm">
          Loading connected accounts...
        </Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Column gap="lg" style={{ maxWidth: 640 }}>
        <Column gap="xs">
          <Heading level={4}>Connected accounts</Heading>
          <Text size="sm" variant="muted">
            Accounts you have connected for integrations. Connecting once makes the account
            available across all your spaces. New connections are started when an integration asks
            you to connect.
          </Text>
        </Column>

        {error && (
          <Card>
            <CardBody>
              <Row gap="sm" style={{ alignItems: 'center' }}>
                <Icon name="warning-circle" size="sm" style={{ color: 'var(--color-danger)' }} />
                <Text size="sm" style={{ color: 'var(--color-danger)', flex: 1 }}>
                  {error.message}
                </Text>
                <Button variant="ghost" size="sm" onClick={() => void refetch()}>
                  Retry
                </Button>
              </Row>
            </CardBody>
          </Card>
        )}

        {disconnectError && (
          <Text size="sm" style={{ color: 'var(--color-danger)' }}>
            {disconnectError}
          </Text>
        )}

        {sorted.length === 0 ? (
          <Card>
            <CardBody>
              <Column gap="sm" style={{ alignItems: 'center', padding: 'var(--space-6)' }}>
                <Icon
                  name="plugs-connected"
                  size="lg"
                  style={{ color: 'var(--color-content-secondary)' }}
                />
                <Text size="sm" variant="muted" style={{ textAlign: 'center' }}>
                  No connected accounts yet. When an integration needs your account, you'll be
                  prompted to connect it.
                </Text>
              </Column>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody style={{ padding: 0 }}>
              {sorted.map((connection, idx) => (
                <ConnectionRow
                  key={connectionKey(connection)}
                  connection={connection}
                  idx={idx}
                  pending={pendingKey === connectionKey(connection)}
                  onDisconnect={() => {
                    handleDisconnect(connection);
                  }}
                />
              ))}
            </CardBody>
          </Card>
        )}
      </Column>
    </PageContainer>
  );
}
