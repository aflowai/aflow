'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Column, EmptyState, Icon, Row, Spinner, Text } from '@aflow/design-system';
import type { AppletInstance, AppletInstanceSummary, InstalledAppletSummary } from '@aflow/schemas';
import { AppPageHeader } from '../components/app-page-header.js';
import { useSpaceFromRoute } from '../components/providers.js';
import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { spaceRoute } from '../lib/space-routes.js';

interface AppletsListResponse {
  applets: AppletInstanceSummary[];
  total: number;
  installed?: InstalledAppletSummary[];
}

export function AppletsPage() {
  const router = useRouter();
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id;

  const listQuery = useApiQuery<AppletsListResponse>({
    key: ['space', spaceId ?? '__none__', 'applets'],
    path: '/applets?include=installed',
    enabled: !!spaceId,
    ...(spaceId ? { spaceId } : {}),
    staleTime: 10_000,
  });

  const instantiate = useApiMutation<{ artifactId: string }, { instance: AppletInstance }>({
    path: '/applets',
    ...(spaceId ? { spaceId } : {}),
    invalidate: [['space', spaceId ?? '__none__', 'applets']],
    onSuccess: (output) => {
      router.push(spaceRoute(routeSpace?.slug, `/applets/${output.instance.instanceId}`));
    },
  });

  const applets = listQuery.data?.applets ?? [];
  const installed = listQuery.data?.installed ?? [];

  return (
    <Column gap="none" style={{ height: '100%', overflow: 'auto' }}>
      <AppPageHeader title="Applets" />
      <Column gap="md" padding="lg" style={{ maxWidth: 920, width: '100%', margin: '0 auto' }}>
        {listQuery.isLoading ? (
          <Row gap="sm" align="center">
            <Spinner size="sm" />
            <Text size="sm" color="muted">
              Loading applets…
            </Text>
          </Row>
        ) : applets.length === 0 && installed.length === 0 ? (
          <EmptyState
            icon={<Icon name="squares-four" />}
            title="No applets yet"
            description="Applets installed from the Store, and the live instances people start from them, will show up here."
          />
        ) : (
          <>
            {applets.length > 0 && (
              <Column gap="sm">
                {applets.map((applet) => (
                  <Link
                    key={applet.instanceId}
                    href={spaceRoute(routeSpace?.slug, `/applets/${applet.instanceId}`)}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <Row
                      gap="md"
                      align="center"
                      style={{
                        padding: 'var(--space-3) var(--space-4)',
                        border: '1px solid var(--color-border-default)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-surface-1)',
                      }}
                    >
                      <Column gap="none" grow>
                        <Text weight="medium">{applet.attention?.title ?? applet.appletKey}</Text>
                        <Text size="xs" color="muted">
                          {applet.appletKey} · v{applet.stateVersion}
                          {applet.attention?.status ? ` · ${applet.attention.status}` : ''}
                        </Text>
                      </Column>
                      {applet.attention?.waitingOn && (
                        <Badge variant="warning">waiting on {applet.attention.waitingOn}</Badge>
                      )}
                      <Badge variant={applet.status === 'active' ? 'success' : 'neutral'}>
                        {applet.status}
                      </Badge>
                      <Icon name="caret-right" size="sm" />
                    </Row>
                  </Link>
                ))}
              </Column>
            )}
            {installed.length > 0 && (
              <Column gap="sm">
                <Text size="sm" weight="medium" color="muted">
                  Installed
                </Text>
                {installed.map((item) => (
                  <Row
                    key={item.artifactId}
                    gap="md"
                    align="center"
                    style={{
                      padding: 'var(--space-3) var(--space-4)',
                      border: '1px solid var(--color-border-default)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--color-surface-1)',
                    }}
                  >
                    <Column gap="none" grow>
                      <Text weight="medium">{item.name}</Text>
                      <Text size="xs" color="muted">
                        {item.appletKey}
                        {item.description ? ` · ${item.description}` : ''}
                      </Text>
                    </Column>
                    {item.liveInstances > 0 && (
                      <Badge variant="neutral">{item.liveInstances} live</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={
                        instantiate.isPending &&
                        instantiate.variables?.artifactId === item.artifactId
                      }
                      disabled={instantiate.isPending}
                      onClick={() => {
                        instantiate.mutate({ artifactId: item.artifactId });
                      }}
                    >
                      Start
                    </Button>
                  </Row>
                ))}
              </Column>
            )}
          </>
        )}
      </Column>
    </Column>
  );
}
