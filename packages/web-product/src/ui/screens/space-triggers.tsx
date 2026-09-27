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
import { useSpaceFromRoute } from '../components/providers.js';

import { describeCron, describeWork } from '../lib/triggers-describe.js';

interface ScheduleRow {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  cronExpression: string | null;
  timezone: string;
  scheduledAt: string | null;
  status: string;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  firingCount: number;
  maxFirings: number | null;
  target: { kind: string; systemRole?: string; agentId?: string } | null;
  inputTemplate?: Record<string, unknown>;
  lastError: string | null;
  /** Present when an agent armed it during a conversation. */
  createdByRunId: string | null;
  expiresAt: string | null;
}

interface WebhookRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lastReceivedAt: string | null;
  lastError: string | null;
  url?: string;
}

function whenNext(row: ScheduleRow): string {
  if (row.status !== 'active') return '—';
  // A next-firing time on a schedule whose end has passed is the page telling a
  // confident lie: it will not run, whatever the clock says.
  if (row.expiresAt !== null && new Date(row.expiresAt).getTime() <= Date.now()) return 'expired';
  if (!row.nextFireAt) return 'not scheduled';
  const at = new Date(row.nextFireAt);
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  if (minutes < 0) return 'due now';
  if (minutes < 60) return `in ${String(minutes)} min`;
  if (minutes < 60 * 24) return `in ${String(Math.round(minutes / 60))} h`;
  return at.toLocaleString();
}

/**
 * When it last ran, which is the half of the story the firing count cannot
 * tell: a schedule that ran three times and then stopped a week ago looks
 * healthy as a number and wrong as a date.
 */
function whenLast(row: ScheduleRow): string {
  if (!row.lastFiredAt) return 'never run';
  const minutes = Math.round((Date.now() - new Date(row.lastFiredAt).getTime()) / 60_000);
  const count = row.firingCount > 1 ? ` · ${String(row.firingCount)}×` : '';
  if (minutes < 1) return `ran just now${count}`;
  if (minutes < 60) return `ran ${String(minutes)} min ago${count}`;
  if (minutes < 60 * 24) return `ran ${String(Math.round(minutes / 60))} h ago${count}`;
  return `ran ${String(Math.round(minutes / (60 * 24)))} d ago${count}`;
}

function recurrence(row: ScheduleRow): string {
  if (row.kind === 'cron' && row.cronExpression)
    return describeCron(row.cronExpression, row.timezone);
  if (row.scheduledAt) return `Once, ${new Date(row.scheduledAt).toLocaleString()}`;
  return row.kind;
}

export function TriggersPage(): React.ReactNode {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const key = ['space', spaceId, 'schedules'];

  // A page whose whole purpose is showing what is armed must not quietly show
  // some of it. Both reads are cursor-paginated and this takes the first page;
  // the cursor coming back is the signal that there is more, and it is said out
  // loud below rather than dropped. A load-more control is the fuller answer,
  // and silence was the part that could mislead.
  const { data, isLoading } = useApiQuery<{
    schedules: ScheduleRow[];
    nextCursor?: string | null;
  }>({
    key,
    path: '/schedules?limit=100',
    spaceId,
    enabled: spaceId.length > 0,
  });

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
                    <Card key={row.id}>
                      <CardBody>
                        <Row gap="md" align="center" justify="between">
                          <Column gap="xs">
                            <Row gap="sm" align="center">
                              <Text weight="medium">{row.name}</Text>
                              {row.status !== 'active' && (
                                <Badge variant="neutral">{row.status}</Badge>
                              )}
                              {/* Worth seeing at a glance: a schedule armed mid-conversation
                            is one the operator may never have watched being made. */}
                              {row.createdByRunId !== null && (
                                <Badge variant="warning">set up in chat</Badge>
                              )}
                            </Row>
                            <Text variant="muted" size="sm">
                              {recurrence(row)}
                            </Text>
                            {/* What it will actually do, which a name rarely
                                says and nobody could see before. */}
                            {(describeWork(row.inputTemplate) ?? row.description) !== null && (
                              <Text variant="muted" size="sm">
                                {describeWork(row.inputTemplate) ?? row.description}
                              </Text>
                            )}
                            {row.lastError !== null && (
                              <Text size="sm" style={{ color: 'var(--color-danger-default)' }}>
                                {`Last run failed: ${row.lastError}`}
                              </Text>
                            )}
                          </Column>
                          <Row gap="md" align="center" style={{ flexShrink: 0 }}>
                            {/* Fixed and non-shrinking: squeezed by a long
                                instruction beside it, "in 20 h" wrapped one
                                character per line. */}
                            <Column gap="xs" style={{ minWidth: '7rem', flexShrink: 0 }}>
                              <Text size="sm">{whenNext(row)}</Text>
                              <Text variant="muted" size="xs">
                                {whenLast(row)}
                              </Text>
                            </Column>
                            <IconButton
                              variant="secondary"
                              aria-label={row.status === 'active' ? 'Pause' : 'Resume'}
                              title={row.status === 'active' ? 'Pause' : 'Resume'}
                              icon={<Icon name={row.status === 'active' ? 'pause' : 'play'} />}
                              onClick={() => {
                                void setStatus.mutateAsync({
                                  id: row.id,
                                  status: row.status === 'active' ? 'paused' : 'active',
                                });
                              }}
                            />
                            {/* Danger, because deleting a schedule the operator
                                did not write is the one action here they cannot
                                take back. */}
                            <IconButton
                              variant="danger"
                              aria-label="Delete"
                              title="Delete"
                              icon={<Icon name="trash" />}
                              onClick={() => {
                                void remove.mutateAsync(row.id);
                              }}
                            />
                          </Row>
                        </Row>
                      </CardBody>
                    </Card>
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
