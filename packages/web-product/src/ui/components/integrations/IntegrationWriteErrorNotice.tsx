'use client';

import { useState } from 'react';
import { Button, Column, Row, Text } from '@aflow/design-system';
import type { IntegrationHostRequest } from '@aflow/schemas';
import { useSpaceFromRoute } from '../providers.js';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { ApiError } from '../../lib/query-client.js';

function deniedHostsFrom(error: unknown): string[] {
  if (!(error instanceof ApiError) || typeof error.body !== 'object' || error.body === null) {
    return [];
  }
  const body = error.body as { code?: unknown; deniedHosts?: unknown };
  if (body.code !== 'INTEGRATION_HOST_NOT_ALLOWED' || !Array.isArray(body.deniedHosts)) {
    return [];
  }
  return body.deniedHosts.filter((host): host is string => typeof host === 'string');
}

/**
 * Save-error rendering for the integration add/edit dialogs. A tenant
 * allowlist denial (the payload carries `deniedHosts`) additionally offers
 * filing an access request for the blocked hosts; anything else renders as
 * the plain danger message the dialogs showed before.
 */
export function IntegrationWriteErrorNotice({
  error,
  kind,
}: {
  error: unknown;
  kind: 'api' | 'mcp';
}) {
  const spaceId = useSpaceFromRoute()?.id;
  const deniedHosts = deniedHostsFrom(error);
  const [sent, setSent] = useState(false);
  const request = useApiMutation<{ hostPattern: string }, IntegrationHostRequest>({
    path: () => `/spaces/${spaceId ?? ''}/integration-host-requests`,
    serialize: (input) => JSON.stringify({ kind, hostPattern: input.hostPattern }),
  });

  const message = error instanceof Error ? error.message : 'Something went wrong.';

  if (deniedHosts.length === 0) {
    return (
      <Text size="sm" tone="danger">
        {message}
      </Text>
    );
  }

  return (
    <Column gap="2">
      <Text size="sm" tone="danger">
        {message}
      </Text>
      {sent ? (
        <Text size="sm" color="secondary">
          Request sent — a tenant admin will review it.
        </Text>
      ) : (
        <Row gap="2" align="center">
          <Button
            variant="secondary"
            disabled={!spaceId || request.isPending}
            onClick={() => {
              void (async () => {
                try {
                  for (const hostPattern of deniedHosts) {
                    await request.mutateAsync({ hostPattern });
                  }
                  setSent(true);
                } catch {
                  // request.error renders below
                }
              })();
            }}
          >
            {request.isPending ? 'Requesting…' : 'Request access'}
          </Button>
          {request.error && (
            <Text size="sm" tone="danger">
              {request.error.message}
            </Text>
          )}
        </Row>
      )}
    </Column>
  );
}
