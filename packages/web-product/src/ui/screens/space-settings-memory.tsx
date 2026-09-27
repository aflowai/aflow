'use client';

import {
  PageContainer,
  Column,
  Row,
  Card,
  CardBody,
  Button,
  Text,
  Heading,
  Badge,
  HelperText,
} from '@aflow/design-system';
import { useSpaceFromRoute } from '../components/providers.js';
import { useApiQuery, useApiMutation } from '../hooks/useApiQuery.js';

interface RegisterEntry {
  id: string;
  kind: 'fact' | 'convention' | 'working_context';
  statement: string;
  detailPath?: string;
  status: 'candidate' | 'active' | 'revoked';
  sourceClass: string;
  assertedByUserId?: string;
  expiresAt?: string;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RegisterResponse {
  eligible: boolean;
  revision: number;
  entries: RegisterEntry[];
}

const STATUS_VARIANT: Record<RegisterEntry['status'], 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  candidate: 'warning',
  revoked: 'neutral',
};

function EntryRow({
  entry,
  spaceId,
  registerKey,
}: {
  entry: RegisterEntry;
  spaceId: string;
  registerKey: readonly unknown[];
}) {
  const promote = useApiMutation({
    path: `/spaces/${spaceId}/active-memory/${entry.id}/promote`,
    invalidate: [registerKey],
  });
  const revoke = useApiMutation({
    path: `/spaces/${spaceId}/active-memory/${entry.id}/revoke`,
    invalidate: [registerKey],
  });
  const remove = useApiMutation({
    path: `/spaces/${spaceId}/active-memory/${entry.id}`,
    method: 'DELETE',
    invalidate: [registerKey],
  });

  const busy = promote.isPending || revoke.isPending || remove.isPending;
  const error = promote.error ?? revoke.error ?? remove.error;

  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" wrap>
            <Badge variant={STATUS_VARIANT[entry.status]}>
              {entry.expired ? 'expired' : entry.status}
            </Badge>
            <Badge variant="neutral">{entry.kind}</Badge>
            {entry.status === 'active' && <Badge variant="neutral">{entry.sourceClass}</Badge>}
          </Row>
          <Text>{entry.statement}</Text>
          {entry.detailPath && <HelperText>Detail: {entry.detailPath}</HelperText>}
          {entry.expiresAt && <HelperText>Expires: {entry.expiresAt}</HelperText>}
          {error && <Text tone="danger">{error.message}</Text>}
          <Row gap="sm">
            {entry.status === 'candidate' && !entry.expired && (
              <Button
                size="sm"
                onClick={() => {
                  promote.mutate();
                }}
                disabled={busy}
              >
                Promote
              </Button>
            )}
            {entry.status === 'active' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  revoke.mutate();
                }}
                disabled={busy}
              >
                Revoke
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                remove.mutate();
              }}
              disabled={busy}
            >
              Delete
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

export function AgentMemoryPage() {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const registerKey = ['space', spaceId, 'activeMemory'] as const;

  const { data, isLoading, error } = useApiQuery<RegisterResponse>({
    key: registerKey,
    path: `/spaces/${spaceId}/active-memory`,
    enabled: spaceId.length > 0,
  });

  const entries = data?.entries ?? [];
  const candidates = entries.filter((e) => e.status === 'candidate');
  const active = entries.filter((e) => e.status === 'active');
  const revoked = entries.filter((e) => e.status === 'revoked');

  return (
    <PageContainer>
      <Column gap="lg">
        <Column gap="xs">
          <Heading level={2}>Agent memory</Heading>
          <Text variant="muted">
            Standing reference notes the agent carries into every conversation in this space. The
            agent proposes candidates; only notes you promote become part of its context. Notes are
            reference, never rules — the agent applies them with judgment and your current message
            always wins.
          </Text>
          {data && !data.eligible && (
            <Text tone="warning">
              Active memory is available only while you are the sole member — nothing is injected in
              this space.
            </Text>
          )}
        </Column>

        {isLoading && <Text variant="muted">Loading…</Text>}
        {error && <Text tone="danger">{error.message}</Text>}

        {!isLoading && entries.length === 0 && (
          <Text variant="muted">
            No standing notes yet. When the agent proposes one, it appears here for your review.
          </Text>
        )}

        {candidates.length > 0 && (
          <Column gap="sm">
            <Heading level={4}>Awaiting review ({candidates.length})</Heading>
            {candidates.map((e) => (
              <EntryRow key={e.id} entry={e} spaceId={spaceId} registerKey={registerKey} />
            ))}
          </Column>
        )}

        {active.length > 0 && (
          <Column gap="sm">
            <Heading level={4}>Active ({active.length})</Heading>
            {active.map((e) => (
              <EntryRow key={e.id} entry={e} spaceId={spaceId} registerKey={registerKey} />
            ))}
          </Column>
        )}

        {revoked.length > 0 && (
          <Column gap="sm">
            <Heading level={4}>Revoked ({revoked.length})</Heading>
            {revoked.map((e) => (
              <EntryRow key={e.id} entry={e} spaceId={spaceId} registerKey={registerKey} />
            ))}
          </Column>
        )}
      </Column>
    </PageContainer>
  );
}
