'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  PageContainer,
  Row,
  Text,
} from '@aflow/design-system';
import { useApiQuery, useApiMutation } from '../hooks/useApiQuery.js';

interface AdminSpaceRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  memberCount: number;
  ownerId: string | null;
  archivedAt: string | null;
  myRole: 'admin' | 'editor' | 'viewer' | null;
}

interface SpacesPayload {
  spaces?: AdminSpaceRow[];
}

interface MePayload {
  user: { userId?: string } | null;
}

export function TenantSpacesPage() {
  const spacesQuery = useApiQuery<SpacesPayload>({
    key: ['spaces', 'admin', 'all'],
    path: '/spaces?status=all',
    staleTime: 15_000,
  });
  const meQuery = useApiQuery<MePayload>({
    key: ['users', 'me'],
    path: '/users/me',
    staleTime: 5 * 60_000,
  });
  const myUserId = meQuery.data?.user?.userId;

  const [joinTarget, setJoinTarget] = useState<AdminSpaceRow | null>(null);

  const joinMutation = useApiMutation<{ spaceId: string; userId: string }>({
    path: (input) => `/spaces/${input.spaceId}/members`,
    method: 'POST',
    serialize: (input) => JSON.stringify({ userId: input.userId, role: 'admin' }),
    invalidate: [['spaces', 'admin', 'all'], ['spaces']],
  });

  const spaces = useMemo(() => {
    const rows = spacesQuery.data?.spaces ?? [];
    return [...rows].sort((a, b) => {
      if (Boolean(a.archivedAt) !== Boolean(b.archivedAt)) return a.archivedAt ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [spacesQuery.data]);

  return (
    <PageContainer>
      <Column gap="lg">
        <Column gap="xs">
          <Text variant="muted">
            Every space in this tenant. You can administer any space's lifecycle, but content is
            visible only in spaces you are a member of. Joining a shared space is an explicit,
            audited action — solo spaces stay private to their owner.
          </Text>
          <Text variant="muted" size="sm">
            Archived spaces are restored or permanently deleted from the{' '}
            <Link href="/spaces/archived">Archived list</Link>.
          </Text>
        </Column>

        {spacesQuery.isLoading && <Text variant="muted">Loading…</Text>}

        {!spacesQuery.isLoading && spaces.length === 0 && (
          <Text variant="muted">No spaces exist in this tenant yet.</Text>
        )}

        {spaces.length > 0 && (
          <Card>
            <CardBody>
              <Column gap="sm">
                {spaces.map((s, idx) => {
                  const solo = s.memberCount <= 1;
                  const isMember = s.myRole !== null;
                  const canJoin = !isMember && !solo && !s.archivedAt && myUserId !== undefined;
                  return (
                    <Column key={s.id} gap="sm">
                      {idx > 0 && (
                        <div style={{ borderTop: '1px solid var(--color-border-subtle)' }} />
                      )}
                      <Row justify="between" align="center" wrap gap="sm">
                        <Column gap="xs" style={{ flex: 1, minWidth: 0 }}>
                          <Row gap="sm" align="center" wrap>
                            <Text size="sm" weight="semibold">
                              {s.name}
                            </Text>
                            <Badge variant="neutral">{s.slug}</Badge>
                            {s.archivedAt && <Badge variant="warning">archived</Badge>}
                            <Badge variant={solo ? 'accent' : 'info'}>
                              {solo ? 'personal' : `shared · ${s.memberCount} members`}
                            </Badge>
                            {isMember && <Badge variant="success">member · {s.myRole}</Badge>}
                          </Row>
                          {s.description && (
                            <Text size="xs" variant="muted">
                              {s.description}
                            </Text>
                          )}
                        </Column>
                        <Row gap="sm" align="center">
                          {isMember && !s.archivedAt && (
                            <Link href={`/s/${s.slug}/chat`}>
                              <Button size="sm" variant="secondary">
                                Open
                              </Button>
                            </Link>
                          )}
                          {canJoin && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setJoinTarget(s);
                              }}
                            >
                              Join
                            </Button>
                          )}
                          {!isMember && solo && !s.archivedAt && (
                            <Text size="xs" variant="muted">
                              private to its owner
                            </Text>
                          )}
                        </Row>
                      </Row>
                    </Column>
                  );
                })}
              </Column>
            </CardBody>
          </Card>
        )}
      </Column>

      <Dialog
        open={joinTarget !== null}
        onClose={() => {
          setJoinTarget(null);
        }}
        title="Join this space?"
        footer={
          <Row gap="sm" justify="end">
            <Button
              variant="secondary"
              onClick={() => {
                setJoinTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={joinMutation.isPending}
              onClick={() => {
                if (!joinTarget || myUserId === undefined) return;
                joinMutation.mutate(
                  { spaceId: joinTarget.id, userId: myUserId },
                  {
                    onSuccess: () => {
                      setJoinTarget(null);
                    },
                  },
                );
              }}
            >
              {joinMutation.isPending ? 'Joining…' : 'Join as admin'}
            </Button>
          </Row>
        }
      >
        <Column gap="sm">
          <Text size="sm">
            You will become an admin member of <strong>{joinTarget?.name}</strong> and gain access
            to its sessions, memory, and artifacts.
          </Text>
          <Text size="sm" variant="muted">
            This is recorded in the audit log and visible to the space's members.
          </Text>
        </Column>
      </Dialog>
    </PageContainer>
  );
}
