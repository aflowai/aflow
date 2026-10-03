'use client';

import { useState } from 'react';
import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Button,
  Text,
  Heading,
  HelperText,
  Badge,
} from '@aflow/design-system';
import type { HostPushApproval } from '@aflow/schemas';
import { useSpace, useSpaceFromRoute } from '../components/providers.js';
import { useEdition } from '../hooks/useEdition.js';
import { useApiQuery, useApiMutation } from '../hooks/useApiQuery.js';
import { HostBrowserProfiles } from '../components/host/HostBrowserProfiles.js';

interface HostBinding {
  hostBindingId: string;
  label: string;
  root: string;
  writable: boolean;
  allowsExecution: boolean;
  /** Null means the folder pushes nothing. */
  branchPrefix: string | null;
  /** Null where the folder pushes nothing, or its machine is not running. */
  pushApproval: HostPushApproval | null;
}

const PUSH_APPROVAL_LINE: Record<HostPushApproval, string> = {
  always: 'A publication from here asks you before every push.',
  never: 'A publication from here pushes without asking.',
  'unless-unreviewed':
    'A publication from here reviews its commit and asks you before pushing unless the review approves it.',
};

interface BindingsResponse {
  bindings: HostBinding[];
}

/**
 * Local edition only: pairing needs a machine running the host executor beside
 * the server, which the hosted deployment has no way to reach. The nav entry is
 * hidden there, so anyone arriving followed a link — a bookmark, an agent, a
 * shared URL — and the page must say so itself rather than render controls
 * whose every call the API is right to refuse.
 */
export function SpaceHostBindingsPage() {
  const isHostedEdition = useEdition().id === 'enterprise';
  const { activeSpaceId, isLoading: spacesLoading } = useSpace();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? activeSpaceId ?? '';
  const key = ['space', spaceId, 'hostBindings'] as const;

  const { data, isLoading } = useApiQuery<BindingsResponse>({
    key,
    path: `/spaces/${spaceId}/host-bindings`,
    enabled: spaceId.length > 0,
  });

  const [copied, setCopied] = useState(false);

  const remove = useApiMutation<string>({
    path: (hostBindingId) => `/spaces/${spaceId}/host-bindings/${hostBindingId}`,
    method: 'DELETE',
    invalidate: [key],
  });

  const bindings = data?.bindings ?? [];
  const apiOrigin = process.env['NEXT_PUBLIC_API_ORIGIN'] ?? 'http://127.0.0.1:3000';
  const DEFAULT_ORIGIN = 'http://127.0.0.1:3000';

  // Minted on request rather than on load: a code is a credential with a
  // lifetime, and one printed to a page nobody is reading is spent time.
  const mint = useApiMutation<{ spaceId: string }, { code: string; expiresAt: string }>({
    path: () => '/host/connect-tokens',
    method: 'POST',
  });
  const [token, setToken] = useState<{ code: string; expiresAt: string } | null>(null);

  // One line. The folder, its name on the machine, what it may be used for and
  // which branches it may publish to are all decided on the machine, which is
  // the only place they can be checked: a browser cannot read a path, and only
  // the machine knows which names it already uses and whether the folder is a
  // repository. This page says what will be asked, so nothing comes as a
  // refusal. Run from the checkout, because that is where `yarn workspace`
  // resolves from.
  const commandFor = (code: string): string =>
    `yarn workspace @aflow/aflow-executor-host connect ${code}${
      apiOrigin === DEFAULT_ORIGIN ? '' : ` --api ${apiOrigin}`
    }`;

  if (isHostedEdition) {
    return (
      <PageContainer>
        <Column gap="sm">
          <Heading level={1}>This Computer</Heading>
          <Text>
            Connecting a folder needs Aflow running on the machine that holds it. This deployment
            runs in the cloud, so there is no computer here to pair with.
          </Text>
          <HelperText>Available in Aflow Local, which runs on your own machine.</HelperText>
        </Column>
      </PageContainer>
    );
  }

  if (spacesLoading || isLoading) {
    return (
      <PageContainer>
        <Text>Loading…</Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Column gap="lg">
        <Column gap="xs">
          <Heading level={2}>This Computer</Heading>
          <Text variant="muted">
            Folders on your machine that this workspace can reach, and the browser its agents use
            there.
          </Text>
        </Column>

        <Card>
          <CardBody>
            <Column gap="md">
              <Heading level={3}>Connect a folder</Heading>
              {token === null ? (
                <>
                  <Text variant="muted" size="sm">
                    Get a code, then run one command on the machine that holds the folder. The code
                    lasts a few minutes and works once.
                  </Text>
                  <Row gap="sm" align="center">
                    <Button
                      onClick={() => {
                        void mint.mutateAsync({ spaceId }).then(setToken);
                      }}
                      disabled={mint.isPending}
                    >
                      {mint.isPending ? 'Getting a code…' : 'Get a code'}
                    </Button>
                  </Row>
                </>
              ) : (
                <>
                  <Text variant="muted" size="sm">
                    Run this on that machine, from your aflow checkout. It opens a folder picker,
                    then asks whether the folder may be written to and whether commands may run in
                    it. A git repository whose commands may run publishes only to branches under{' '}
                    <Text variant="mono" size="sm">
                      aflow/
                    </Text>
                    , never forced, unless the command is given another prefix, and a publication
                    asks you before every push unless the command says otherwise. The folder is
                    named after itself here, made unique when another workspace already reaches it.
                  </Text>
                  <Text
                    variant="mono"
                    size="sm"
                    style={{ userSelect: 'all', whiteSpace: 'pre-wrap' }}
                  >
                    {commandFor(token.code)}
                  </Text>
                  <Row gap="sm" align="center">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void navigator.clipboard.writeText(commandFor(token.code)).then(() => {
                          setCopied(true);
                          setTimeout(() => {
                            setCopied(false);
                          }, 2000);
                        });
                      }}
                    >
                      {copied ? 'Copied' : 'Copy command'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setToken(null);
                      }}
                    >
                      Done
                    </Button>
                  </Row>
                  <HelperText>
                    Works once, and expires at {new Date(token.expiresAt).toLocaleTimeString()}. It
                    can connect folders to this workspace and nothing else.
                  </HelperText>
                </>
              )}
            </Column>
          </CardBody>
        </Card>

        <Column gap="sm">
          <Heading level={3}>Connected folders</Heading>
          {bindings.length === 0 ? (
            <Text variant="muted">None yet.</Text>
          ) : (
            bindings.map((binding) => (
              <Card key={binding.hostBindingId}>
                <CardBody>
                  <Row justify="between" align="center">
                    <Column gap="xs">
                      <Row gap="sm" align="center">
                        <Text weight="medium">{binding.label}</Text>
                        <Badge variant="neutral">{binding.hostBindingId}</Badge>
                        <Badge variant={binding.writable ? 'warning' : 'neutral'}>
                          {binding.writable ? 'read and write' : 'read only'}
                        </Badge>
                        {binding.allowsExecution && <Badge variant="warning">commands</Badge>}
                        {binding.branchPrefix !== null && (
                          <Badge variant="warning">pushes under {binding.branchPrefix}</Badge>
                        )}
                      </Row>
                      <Text variant="muted" size="sm">
                        {binding.root}
                      </Text>
                      {binding.pushApproval !== null && (
                        <Text variant="muted" size="sm">
                          {PUSH_APPROVAL_LINE[binding.pushApproval]}
                        </Text>
                      )}
                    </Column>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void remove.mutateAsync(binding.hostBindingId);
                      }}
                    >
                      Disconnect
                    </Button>
                  </Row>
                </CardBody>
              </Card>
            ))
          )}
        </Column>

        <HostBrowserProfiles />
      </Column>
    </PageContainer>
  );
}
