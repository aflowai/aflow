'use client';

/**
 * Everything armed to start work here without anybody asking.
 *
 * A clock and an inbound event are the same thing from the operator's side —
 * something happens, and an agent runs — so they belong on one page. Split by
 * source they read as two features; together they answer the question that
 * actually gets asked, which is what runs here on its own.
 *
 * Nothing showed either before this: no page, and until recently not the
 * agent's context, so a nightly job was discoverable only by thinking to ask
 * whether one existed.
 *
 * The authority is ordinary — a triggered run reaches exactly what an
 * interactive one reaches — so this is not a consent surface and does not
 * pretend to be. It answers what is armed, when it next happens, and who armed
 * it.
 */

import { useMemo } from 'react';
import {
  Badge,
  Card,
  CardBody,
  Column,
  Heading,
  HelperText,
  Icon,
  IconButton,
  PageContainer,
  Row,
  Text,
} from '@aflow/design-system';

import { useApiMutation, useApiQuery } from '../hooks/useApiQuery.js';
import { spaceSchedulesKey, useSpaceSchedules } from '../hooks/use-space-schedules.js';
import { useSpaceFromRoute } from '../components/providers.js';

import { ScheduleCard } from '../components/schedule-card.js';

interface WebhookRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lastReceivedAt: string | null;
  lastError: string | null;
  url?: string;
}

export function TriggersPage(): React.ReactNode {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const key = spaceSchedulesKey(spaceId);

  // A page whose whole purpose is showing what is armed must not quietly show
  // some of it. Both reads are cursor-paginated and this takes the first page;
  // the cursor coming back is the signal that there is more, and it is said out
  // loud below rather than dropped. A load-more control is the fuller answer,
  // and silence was the part that could mislead.
  const { data, isLoading } = useSpaceSchedules(spaceId);

  const hooksKey = ['space', spaceId, 'webhook-endpoints'];
  const { data: hookData } = useApiQuery<{
    endpoints: WebhookRow[];
    nextCursor?: string | null;
  }>({
    key: hooksKey,
    path: '/webhook-endpoints?limit=100',
    spaceId,
    enabled: spaceId.length > 0,
  });

  const remove = useApiMutation<string>({
    path: (scheduleId) => `/schedules/${scheduleId}`,
    method: 'DELETE',
    invalidate: [key],
  });

  // Pausing is the reversible answer and therefore the ordinary one. Deleting a
  // schedule the operator did not write is a decision; stopping it for now is
  // not, and offering only the irreversible action makes every glance a risk.
  const setStatus = useApiMutation<{ id: string; status: 'active' | 'paused' }>({
    path: ({ id }) => `/schedules/${id}`,
    method: 'PATCH',
    invalidate: [key],
  });

  const removeHook = useApiMutation<string>({
    path: (webhookId) => `/webhook-endpoints/${webhookId}`,
    method: 'DELETE',
    invalidate: [hooksKey],
  });

  const rows = data?.schedules ?? [];
  const hooks = hookData?.endpoints ?? [];
  // Active first: what is armed is the question this page exists to answer, and
  // a finished one-shot is history rather than news.
  const ordered = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return (a.nextFireAt ?? '').localeCompare(b.nextFireAt ?? '');
      }),
    [rows],
  );

  if (isLoading) {
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
          <Heading level={2}>Triggers</Heading>
          <Text variant="muted">
            What starts work in this space without anybody asking. A triggered run reaches exactly
            what an interactive one reaches.
          </Text>
        </Column>

        {ordered.length === 0 && hooks.length === 0 ? (
          <Card>
            <CardBody>
              <Column gap="xs">
                <Text variant="muted">Nothing is scheduled here.</Text>
                <HelperText>
                  Ask in chat to set something up — a daily report, a repository check — and it will
                  appear here.
                </HelperText>
              </Column>
            </CardBody>
          </Card>
        ) : (
          <Column gap="lg">
            {ordered.length > 0 && (
              <Column gap="sm">
                <Heading level={3}>On a schedule</Heading>
                <Column gap="sm">
                  {ordered.map((row) => (
                    <ScheduleCard
                      key={row.id}
                      schedule={row}
                      variant="page"
                      onToggleStatus={(schedule) => {
                        void setStatus.mutateAsync({
                          id: schedule.id,
                          status: schedule.status === 'active' ? 'paused' : 'active',
                        });
                      }}
                      onDelete={(schedule) => {
                        void remove.mutateAsync(schedule.id);
                      }}
                    />
                  ))}
                  {data?.nextCursor ? (
                    <HelperText>
                      {`Showing the first ${String(rows.length)}. More schedules exist than fit this page.`}
                    </HelperText>
                  ) : null}
                </Column>
              </Column>
            )}

            {hooks.length > 0 && (
              <Column gap="sm">
                <Heading level={3}>On an event</Heading>
                <Column gap="sm">
                  {hooks.map((hook) => (
                    <Card key={hook.id}>
                      <CardBody>
                        <Row gap="md" align="center" justify="between">
                          <Column gap="xs">
                            <Row gap="sm" align="center">
                              <Text weight="medium">{hook.name}</Text>
                              {hook.status !== 'active' && (
                                <Badge variant="neutral">{hook.status}</Badge>
                              )}
                              {hook.lastError !== null && (
                                <Badge variant="danger">last failed</Badge>
                              )}
                            </Row>
                            {hook.description !== null && (
                              <Text variant="muted" size="sm">
                                {hook.description}
                              </Text>
                            )}
                          </Column>
                          <Row gap="md" align="center">
                            <Text variant="muted" size="sm">
                              {hook.lastReceivedAt === null
                                ? 'never called'
                                : `last called ${new Date(hook.lastReceivedAt).toLocaleString()}`}
                            </Text>
                            <IconButton
                              variant="danger"
                              aria-label="Delete"
                              title="Delete"
                              icon={<Icon name="trash" />}
                              onClick={() => {
                                void removeHook.mutateAsync(hook.id);
                              }}
                            />
                          </Row>
                        </Row>
                      </CardBody>
                    </Card>
                  ))}
                  {hookData?.nextCursor ? (
                    <HelperText>
                      {`Showing the first ${String(hooks.length)}. More endpoints exist than fit this page.`}
                    </HelperText>
                  ) : null}
                </Column>
              </Column>
            )}
          </Column>
        )}
      </Column>
    </PageContainer>
  );
}
