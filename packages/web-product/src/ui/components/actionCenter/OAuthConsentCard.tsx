'use client';

import { useCallback, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { OAUTH_CONNECTIONS_KEY } from '../../hooks/use-oauth-connections.js';
import { useOAuthConsentPopup } from '../../lib/oauthConsentPopup.js';
import type {
  ActionCenterItem,
  OAuthConsentExtension,
} from '../../hooks/use-action-center-types.js';

export interface OAuthConsentCardProps {
  item: ActionCenterItem;
  extension: OAuthConsentExtension;
}

interface ConsentStartResponse {
  authorizationUrl?: string;
}

/**
 * "Connect {provider}" card for a step paused on OAuth consent (Plan 185 §9.3
 * Plane A). Consent runs in a popup so the operator's app tab never navigates
 * away: we open the popup synchronously on click, then point it at the provider
 * authorization URL — either the executor's `authorizationUrlHint` (known
 * synchronously) or the consent-start endpoint's response. Resume of the parked
 * session is callback-driven (the OAuth callback), not a resolve-route action —
 * so this card has no submit/approve affordance. When the popup closes we
 * invalidate the connections + Action Center queries so the consent item
 * refreshes/clears after the run resumes.
 */
export function OAuthConsentCard({ item, extension }: OAuthConsentCardProps): ReactElement {
  const [launchError, setLaunchError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { launch } = useOAuthConsentPopup();

  // BFF-relative consent-start path (the `/api` → `/v1` proxy adds the prefix).
  // The executor's `consentUrlHint` is server-relative (`/v1/...`); strip the
  // `/v1` so it routes through the BFF. Otherwise derive it from the binding.
  const consentPath =
    (extension.consentUrlHint ? extension.consentUrlHint.replace(/^\/v1/, '') : undefined) ??
    `/integrations/${extension.integrationKind}/bindings/${extension.bindingId}/consent`;

  const startConsent = useApiMutation<undefined, ConsentStartResponse>({
    path: consentPath,
    method: 'POST',
    spaceId: item.spaceId,
  });

  const canConnect = item.allowedActions.includes('connect');

  const handleConnect = useCallback((): void => {
    setLaunchError(null);
    const onClosed = (): void => {
      void queryClient.invalidateQueries({ queryKey: [...OAUTH_CONNECTIONS_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['space', item.spaceId, 'action-center'] });
    };
    // Prefer a fully-resolved authorization URL when the executor already
    // produced one; otherwise launch via the consent-start endpoint.
    launch({
      ...(extension.authorizationUrlHint
        ? { directUrl: extension.authorizationUrlHint }
        : { start: () => startConsent.mutateAsync(undefined) }),
      onClosed,
      onError: (message) => {
        setLaunchError(message);
      },
    });
  }, [extension.authorizationUrlHint, item.spaceId, launch, queryClient, startConsent]);

  const error = launchError ?? (startConsent.error ? startConsent.error.message : null);

  return (
    <Card>
      <CardBody>
        <Column gap="sm">
          <Row gap="sm" align="center">
            <Text size="base" weight="semibold">
              {item.title}
            </Text>
            {extension.reason === 'expired' && <Badge variant="warning">Expired</Badge>}
          </Row>
          <Text size="sm" variant="muted">
            {item.summary}
          </Text>
          {error && (
            <Text
              size="sm"
              variant="muted"
              style={{ color: 'var(--color-danger-default, #dc2626)' }}
            >
              {error}
            </Text>
          )}
          <Row gap="sm">
            <Button
              variant="primary"
              onClick={handleConnect}
              disabled={!canConnect || startConsent.isPending}
            >
              {startConsent.isPending
                ? 'Connecting…'
                : extension.reason === 'expired'
                  ? 'Reconnect'
                  : 'Connect'}
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
