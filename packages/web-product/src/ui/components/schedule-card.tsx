'use client';

/**
 * One schedule, as every surface that lists schedules shows it.
 *
 * The Triggers page and the Workbench beside the chat both answer "what runs
 * here on its own", so they read one row and render it through one component.
 * Two renderings drift, and the drift that matters is one surface calling a
 * one-shot that has already run expired while the other says it will run.
 */

import { Badge, Card, CardBody, Column, Icon, IconButton, Row, Text } from '@aflow/design-system';

import { describeCron, describeWork } from '../lib/triggers-describe.js';

export interface ScheduleRow {
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
  /** Present when an agent set it up during a conversation. */
  createdByRunId: string | null;
  /** The schedule this one renews, which an agent set up already. */
  renewsScheduleId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export type ScheduleState = 'active' | 'paused' | 'expired' | 'deleted';

function hasExpired(row: ScheduleRow): boolean {
  return row.expiresAt !== null && new Date(row.expiresAt).getTime() <= Date.now();
}

/**
 * The state a person should read. A schedule still marked active whose end has
 * passed will not run whatever its status says, so it reads as expired.
 */
export function scheduleState(row: ScheduleRow): ScheduleState {
  if (row.status === 'active') return hasExpired(row) ? 'expired' : 'active';
  if (row.status === 'paused' || row.status === 'deleted') return row.status;
  return 'expired';
}

/** "in 4 min", "in 3 h", a date further out, or "due now". */
function untilNext(nextFireAt: string): string {
  const at = new Date(nextFireAt);
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  if (minutes < 0) return 'due now';
  if (minutes < 60) return `in ${String(minutes)} min`;
  if (minutes < 60 * 24) return `in ${String(Math.round(minutes / 60))} h`;
  return at.toLocaleString();
}

/** "just now", "5 min ago", "3 h ago" or "2 d ago". */
function sinceLast(lastFiredAt: string): string {
  const minutes = Math.round((Date.now() - new Date(lastFiredAt).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  if (minutes < 60 * 24) return `${String(Math.round(minutes / 60))} h ago`;
  return `${String(Math.round(minutes / (60 * 24)))} d ago`;
}

function whenNext(row: ScheduleRow): string {
  if (row.status !== 'active') return '—';
  // A next-firing time on a schedule whose end has passed is the page telling a
  // confident lie: it will not run, whatever the clock says.
  if (hasExpired(row)) return 'expired';
  if (!row.nextFireAt) return 'not scheduled';
  return untilNext(row.nextFireAt);
}

/**
 * When it last ran, which is the half of the story the firing count cannot
 * tell: a schedule that ran three times and then stopped a week ago looks
 * healthy as a number and wrong as a date.
 */
function whenLast(row: ScheduleRow): string {
  if (!row.lastFiredAt) return 'never run';
  const count = row.firingCount > 1 ? ` · ${String(row.firingCount)}×` : '';
  return `ran ${sinceLast(row.lastFiredAt)}${count}`;
}

function recurrence(row: ScheduleRow): string {
  if (row.kind === 'cron' && row.cronExpression)
    return describeCron(row.cronExpression, row.timezone);
  if (row.scheduledAt) return `Once, ${new Date(row.scheduledAt).toLocaleString()}`;
  return row.kind;
}

/**
 * What a folded card says beside the name: "next in 4 min" for one that will
 * run. A schedule that will not run never gets a time it would run at, so it
 * says its state instead.
 */
function compactWhen(row: ScheduleRow): string {
  const state = scheduleState(row);
  if (state !== 'active') return state;
  return row.nextFireAt ? `next ${untilNext(row.nextFireAt)}` : 'not scheduled';
}

export type ScheduleCardProps =
  | {
      schedule: ScheduleRow;
      /** The Triggers page: everything about it, with Pause and Delete. */
      variant: 'page';
      onToggleStatus: (schedule: ScheduleRow) => void;
      onDelete: (schedule: ScheduleRow) => void;
    }
  | {
      schedule: ScheduleRow;
      /**
       * A narrow column: the name and when it runs next on one line, with the
       * recurrence, the work and when it last ran folded under it.
       */
      variant: 'compact';
    };

export function ScheduleCard(props: ScheduleCardProps): React.ReactNode {
  const row = props.schedule;

  if (props.variant === 'compact') {
    const work = describeWork(row.inputTemplate) ?? row.description;
    return (
      <Card role="article" aria-label={row.name}>
        {/* One line until opened, so the section is as tall as the schedules
            it lists and the sections below it stay in view. */}
        <details>
          <summary style={{ cursor: 'pointer', padding: 'var(--space-1) var(--space-2)' }}>
            <Row
              gap="sm"
              align="center"
              justify="between"
              style={{ display: 'inline-flex', width: 'calc(100% - 1.25em)' }}
            >
              <Text weight="medium" size="sm" truncate style={{ minWidth: 0 }}>
                {row.name}
              </Text>
              <Text variant="muted" size="xs" style={{ flexShrink: 0 }}>
                {compactWhen(row)}
              </Text>
            </Row>
          </summary>
          <Column gap="xs" style={{ padding: '0 var(--space-2) var(--space-1)' }}>
            <Text variant="muted" size="xs">
              {recurrence(row)}
            </Text>
            {work !== null && (
              <Text variant="muted" size="xs">
                {work}
              </Text>
            )}
            <Text variant="muted" size="xs">
              {whenLast(row)}
            </Text>
            {row.lastError !== null && (
              <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
                {`Last run failed: ${row.lastError}`}
              </Text>
            )}
          </Column>
        </details>
      </Card>
    );
  }

  const { onToggleStatus, onDelete } = props;
  return (
    <Card role="article" aria-label={row.name}>
      <CardBody>
        <Row gap="md" align="center" justify="between">
          <Column gap="xs">
            <Row gap="sm" align="center">
              <Text weight="medium">{row.name}</Text>
              {row.status !== 'active' && <Badge variant="neutral">{row.status}</Badge>}
              {/* Worth seeing at a glance: a schedule armed mid-conversation
                  is one the operator may never have watched being made. */}
              {row.createdByRunId !== null && <Badge variant="warning">set up in chat</Badge>}
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
                onToggleStatus(row);
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
                onDelete(row);
              }}
            />
          </Row>
        </Row>
      </CardBody>
    </Card>
  );
}
