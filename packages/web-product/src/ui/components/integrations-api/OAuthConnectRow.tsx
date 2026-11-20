'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { Badge, Button, Column, Icon, Row, Text } from '@aflow/design-system';
import { getOAuthIssuer, type OAuthBindingConnection } from '@aflow/schemas';
import type { ApiBindingSummary } from '../../hooks/use-integrations.js';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { OAUTH_CONNECTIONS_KEY } from '../../hooks/use-oauth-connections.js';
import { useOAuthConsentPopup } from '../../lib/oauthConsentPopup.js';

export const NOT_CONNECTED_LABEL = 'Not connected';

function formatSince(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The card's one line about a binding's token, built only from what the token
 * row records. A provider that reported no account gets "Connected" with no
 * name, and a row with no recorded consent time gets no "since".
 */
export function describeOAuthConnection(
  connection: OAuthBindingConnection | null | undefined,
  format: (iso: string) => string = formatSince,
): string {
  if (!connection) return NOT_CONNECTED_LABEL;
  const who = connection.account ? ` as ${connection.account}` : '';
  if (connection.status === 'expired') return `Connection${who} expired`;
  const parts = [`Connected${who}`];
  if (connection.connectedAt) parts.push(`since ${format(connection.connectedAt)}`);
  parts.push(`scopes ${String(connection.scopes.length)}`);
  return parts.join(', ');
}

function isBindingsQuery(query: Query): boolean {
  const key = query.queryKey;
  return key[0] === 'space' && key[2] === 'integrations' && key[3] === 'bindings';
}

/**
 * Connect / Connected affordance for an `oauth2_authorization_code` API binding.
 * Consent runs in a popup so the app tab never navigates away: open the popup
 * synchronously on click, POST the binding's consent-start route, then point the
 * popup at the returned authorization URL (mirrors `OAuthConsentCard`). When the
 * popup closes the bindings read runs again, so the card states the new token
 * without a manual refresh. The server derives the owner from the binding's
 * ownerScope + the signed-in user; the UI just launches it. Disconnect lives on
 * the /account page.
 */
export function OAuthConnectRow({
  binding,
  readOnly = false,
}: {
  binding: ApiBindingSummary;
  readOnly?: boolean;
}): ReactNode {
  const connection = binding.oauthConnection;
  const connected = connection?.status === 'connected';
  const rawIssuerKey = binding.auth['issuerKey'];
  const issuerKey = typeof rawIssuerKey === 'string' ? rawIssuerKey : '';
  const issuer = getOAuthIssuer(issuerKey);

  const queryClient = useQueryClient();
  const { launch } = useOAuthConsentPopup();
  const [launchError, setLaunchError] = useState<string | null>(null);

  const startConsent = useApiMutation<undefined, { authorizationUrl?: string }>({
    path: `/integrations/api/bindings/${binding.bindingId}/consent`,
    method: 'POST',
  });

  const handleConnect = useCallback(() => {
    setLaunchError(null);
    launch({
      start: () => startConsent.mutateAsync(undefined),
      onClosed: () => {
        void queryClient.invalidateQueries({ predicate: isBindingsQuery });
        void queryClient.invalidateQueries({ queryKey: [...OAUTH_CONNECTIONS_KEY] });
      },
      onError: (message) => {
        setLaunchError(message);
      },
    });
  }, [launch, queryClient, startConsent]);

  const summary = (
    <Text size="xs" color={connected ? 'secondary' : 'muted'} data-testid="oauth-connection-status">
      {describeOAuthConnection(connection)}
    </Text>
  );

  if (connected) {
    return (
      <Row gap="2" align="center" wrap>
        <Badge variant="success">
          <Icon name="check-circle" size="xs" /> Connected
        </Badge>
        {summary}
      </Row>
    );
  }

  if (readOnly) return summary;

  const error = launchError ?? (startConsent.error ? startConsent.error.message : null);

  return (
    <Column gap="1">
      {summary}
      <Row>
        <Button
          variant="primary"
          leftIcon={<Icon name="plugs-connected" size="sm" />}
          onClick={handleConnect}
          disabled={startConsent.isPending}
        >
          {startConsent.isPending
            ? 'Connecting…'
            : issuer
              ? `Connect ${issuer.displayName}`
              : 'Sign in'}
        </Button>
      </Row>
      {error && (
        <Text size="xs" tone="danger">
          {error}
        </Text>
      )}
    </Column>
  );
}
