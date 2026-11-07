'use client';

/**
 * Unified RunTimeline component — used in both the Chat inspector and the Runs detail page.
 *
 * Displays flow run events as a rich timeline grouped by step, with:
 * - Step name, type, operation, status and duration
 * - Expandable step cards to inspect input/output and variable changes
 * - Lazy-loaded payload details (only when expanded)
 */

import { Fragment, useState, useMemo, type ReactNode } from 'react';

import {
  Text,
  Row,
  Column,
  Badge,
  JsonViewer,
  Icon,
  Tabs,
  TabList,
  Tab,
  TabPanel,
} from '@aflow/design-system';
import type { SessionEvent } from '../lib/types.js';
import { StateViewer } from './state-viewer';
import {
  buildTimelineEntries,
  computeRunSummary,
  resolveDelegateRole,
  stepGroupKey,
  turnToolGroups,
  turnToolsSummary,
} from './run-timeline/buildTimelineEntries';
import {
  eventColor,
  eventIcon,
  formatTime,
  friendlyEventLabel,
  subflowEventColor,
  subflowEventIcon,
  subflowEventLabel,
  turnToolsLabel,
} from './run-timeline/displayHelpers';
import { ev } from './run-timeline/eventAccessor';
import { RunSummaryBar, type RunSummary } from './run-timeline/RunSummaryBar';
import { StepGroupCard } from './run-timeline/StepGroupCard';
import type {
  RunTimelineProps,
  StepGroup,
  SubflowEntry,
  TimelineEntry,
} from './run-timeline/types';
import './run-timeline.css';

export type { RunTimelineProps } from './run-timeline/types';

function ExecutionList({
  entries,
  summary,
  historyEdge,
  foldTurnTools = false,
}: {
  entries: TimelineEntry[];
  summary: RunSummary;
  historyEdge?: ReactNode;
  foldTurnTools?: boolean;
}) {
  const toolsByTurn = useMemo(
    () => (foldTurnTools ? turnToolGroups(entries) : new Map<string, StepGroup[]>()),
    [entries, foldTurnTools],
  );
  return (
    <Column gap="1">
      <RunSummaryBar summary={summary} />
      {historyEdge}
      {entries.map((entry) => {
        if (entry.kind === 'flow') {
          return <FlowEventRow key={entry.event.eventId} event={entry.event} />;
        }
        if (entry.kind === 'subflow') {
          return <SubflowEventCard key={entry.entry.event.eventId} entry={entry.entry} />;
        }
        const key = stepGroupKey(entry.group);
        const parent = entry.group.parentTurnKey;
        // A folded tool row renders under its turn, not at its own place.
        if (parent != null && toolsByTurn.has(parent)) return null;
        if (parent != null) {
          return (
            <div key={key} className="rt-tool-indent">
              <StepGroupCard group={entry.group} />
            </div>
          );
        }
        const tools = toolsByTurn.get(key);
        if (!tools) return <StepGroupCard key={key} group={entry.group} />;
        return (
          <Fragment key={key}>
            <StepGroupCard group={entry.group} />
            <TurnToolsFold turn={entry.group} tools={tools} />
          </Fragment>
        );
      })}
    </Column>
  );
}

/**
 * One turn's tool rows behind a single line that counts them and says what
 * the turn and its tools spent. Open, it shows the rows as the flat list
 * shows them.
 */
function TurnToolsFold({ turn, tools }: { turn: StepGroup; tools: StepGroup[] }) {
  const [expanded, setExpanded] = useState(false);
  const label = turnToolsLabel(turnToolsSummary(turn, tools));
  return (
    <div className="rt-tool-indent" data-turn-tools-fold={stepGroupKey(turn)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((v) => !v);
        }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          boxSizing: 'border-box',
          width: '100%',
          padding: 'var(--space-1) var(--space-2)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <Row gap="2" align="center">
          <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
          <Text variant="muted" size="xs">
            {label}
          </Text>
        </Row>
      </button>
      {expanded && (
        <Column gap="1">
          {tools.map((group) => (
            <StepGroupCard key={stepGroupKey(group)} group={group} />
          ))}
        </Column>
      )}
    </div>
  );
}

export function RunTimeline({
  events,
  compact,
  withTabs = true,
  loading = false,
  historyEdge,
  foldTurnTools = false,
}: RunTimelineProps) {
  const entries = useMemo(() => buildTimelineEntries(events), [events]);
  const summary = useMemo(() => computeRunSummary(entries), [entries]);

  if (events.length === 0) {
    return (
      <Text variant="muted" size="sm">
        {loading ? 'Loading events…' : 'No events yet'}
      </Text>
    );
  }

  if (compact) {
    const EPHEMERAL = new Set(['SurfaceUpdate']);
    return (
      <Column gap="1">
        {events
          .filter((e) => {
            if (EPHEMERAL.has(e.eventType)) return false;
            if (
              e.eventType === 'SubflowEventForwarded' &&
              EPHEMERAL.has(
                (e.data?.['sourceEventType'] ?? e.metadata?.['sourceEventType']) as string,
              )
            )
              return false;
            return true;
          })
          .map((event) => (
            <CompactEventRow key={event.eventId} event={event} />
          ))}
      </Column>
    );
  }

  if (!withTabs) {
    return (
      <ExecutionList
        entries={entries}
        summary={summary}
        historyEdge={historyEdge}
        foldTurnTools={foldTurnTools}
      />
    );
  }

  return (
    <Tabs defaultTab="execution">
      <TabList>
        <Tab id="execution">Execution</Tab>
        <Tab id="state">State</Tab>
      </TabList>

      <TabPanel id="execution">
        <ExecutionList
          entries={entries}
          summary={summary}
          historyEdge={historyEdge}
          foldTurnTools={foldTurnTools}
        />
      </TabPanel>

      <TabPanel id="state">
        <StateViewer events={events} />
      </TabPanel>
    </Tabs>
  );
}

function FlowEventRow({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);

  const e = ev(event);
  const label = friendlyEventLabel(event.eventType, e.stepName, e.pauseType);
  const icon = eventIcon(event.eventType);
  const color = eventColor(event.eventType);
  const time = formatTime(event.timestamp);

  return (
    <div>
      <button
        onClick={() => {
          setExpanded((v) => !v);
        }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          boxSizing: 'border-box',
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-md)',
          transition: 'background-color 120ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--color-surface-2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--space-1) var(--space-2)',
          }}
        >
          <Row gap="2" align="center" style={{ flexShrink: 0 }}>
            <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
            <span style={{ color, display: 'flex', alignItems: 'center' }}>
              <Icon name={icon} size="sm" />
            </span>
            <Text size="sm" style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
              {label}
            </Text>
          </Row>
          <Text variant="muted" size="xs" style={{ whiteSpace: 'nowrap', marginLeft: 'auto' }}>
            {time}
          </Text>
        </div>
      </button>
      {expanded && (event.metadata ?? event.data) && (
        <div
          style={{
            marginLeft: 'var(--space-7)',
            marginTop: 'var(--space-1)',
            marginBottom: 'var(--space-2)',
          }}
        >
          <JsonViewer
            data={{
              ...(event.metadata ?? {}),
              ...(event.data ?? {}),
            }}
            collapseDepth={2}
            maxHeight="200px"
          />
        </div>
      )}
    </div>
  );
}

function SubflowEventCard({ entry }: { entry: SubflowEntry }) {
  const [expanded, setExpanded] = useState(false);
  const label = subflowEventLabel(entry);
  const icon = subflowEventIcon(entry.sourceEventType);
  const color = subflowEventColor(entry.sourceEventType);
  const time = formatTime(entry.timestamp);
  const role = resolveDelegateRole(entry.subflowStepName, entry.sourceAgentId);
  const agentName = entry.stepName ?? entry.subflowStepName ?? entry.sourceStepId;
  const isFailed = entry.sourceEventType.includes('Failed');

  return (
    <div
      className="rt-step-card"
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        borderLeft: '2px solid var(--color-accent, #7c5cc7)',
        overflow: 'hidden',
        backgroundColor: 'var(--color-surface-0)',
        marginTop: 'var(--space-1)',
        marginBottom: 'var(--space-1)',
      }}
    >
      <button
        onClick={() => {
          setExpanded((v) => !v);
        }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          boxSizing: 'border-box',
          padding: 'var(--space-2) var(--space-3)',
          transition: 'background-color 120ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--color-surface-2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <div className="rt-step-header">
          <div className="rt-step-left">
            <Row gap="2" align="center" style={{ minWidth: 0, flex: '1 1 auto' }}>
              <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
              <span style={{ color, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <Icon name={icon} size="sm" />
              </span>
              <Text
                size="sm"
                style={{
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}
                title={agentName ?? 'Delegate'}
              >
                {agentName ?? 'Delegate'}
              </Text>
            </Row>
            <Text
              variant="muted"
              size="xs"
              style={{
                whiteSpace: 'nowrap',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {label}
            </Text>
            <Badge variant="info">{role}</Badge>
          </div>
          <div className="rt-step-right">
            <Text size="xs" className="rt-step-right-item rt-step-time">
              {time}
            </Text>
            <Text
              variant="muted"
              size="xs"
              className="rt-step-right-item rt-step-status"
              style={{ color }}
            >
              {isFailed ? 'Failed' : 'Completed'}
            </Text>
          </div>
        </div>
      </button>

      {expanded && (
        <div
          style={{
            padding: '0 var(--space-3) var(--space-3)',
            borderTop: '1px solid var(--color-border-subtle)',
          }}
        >
          {entry.agentMessage && (
            <div style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              <Text
                variant="muted"
                size="xs"
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: 'italic' }}
              >
                {entry.agentMessage}
              </Text>
            </div>
          )}
          <div style={{ marginTop: entry.agentMessage ? 0 : 'var(--space-2)' }}>
            <JsonViewer
              data={{
                ...(entry.event.metadata ?? {}),
                ...(entry.event.data ?? {}),
              }}
              collapseDepth={2}
              maxHeight="200px"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function CompactEventRow({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);
  const e = ev(event);
  const label = friendlyEventLabel(event.eventType, e.stepName, e.pauseType);
  const stepName = e.stepName ?? e.stepId;
  const operationId = e.operationId;
  const color = eventColor(event.eventType);

  return (
    <div>
      <button
        onClick={() => {
          setExpanded((v) => !v);
        }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          boxSizing: 'border-box',
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-md)',
          transition: 'background-color 120ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--color-surface-2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <Row gap="2" align="center">
          <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: color,
              flexShrink: 0,
            }}
          />
          <Text size="xs" style={{ fontWeight: 500 }}>
            {label}
          </Text>
          {stepName && (
            <Text variant="muted" size="xs">
              {stepName}
            </Text>
          )}
          {operationId && <Badge variant="neutral">{operationId}</Badge>}
          <span style={{ flex: 1 }} />
          <Text variant="muted" size="xs">
            {formatTime(event.timestamp)}
          </Text>
        </Row>
      </button>
      {expanded && event.data && (
        <div style={{ marginLeft: 'var(--space-7)', marginBottom: 'var(--space-1)' }}>
          <JsonViewer data={event.data} collapseDepth={2} maxHeight="150px" />
        </div>
      )}
    </div>
  );
}
