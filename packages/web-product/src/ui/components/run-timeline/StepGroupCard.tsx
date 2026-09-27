'use client';

import { useState, useCallback, type CSSProperties } from 'react';
import { fetchPayload } from '../../lib/fetch-payload.js';

import { Text, Row, Column, Badge, JsonViewer, Divider, Icon, Spinner } from '@aflow/design-system';
import type { SessionEvent } from '../../lib/types.js';
import { useApi } from '../providers.js';

import {
  HARNESS_RUN_OPERATION,
  HarnessActivityCard,
  useHarnessActivityLines,
  useHarnessName,
  useHarnessResult,
} from '../harness-activity-card.js';
import { AGENT_TURN_OPERATION } from './buildTimelineEntries';
import { ev } from './eventAccessor';
import {
  agentTurnLabel,
  eventColor,
  formatCostUsd,
  formatDuration,
  formatNumber,
  formatTime,
  formatTimeFull,
  friendlyEventLabel,
  friendlyOperationLabel,
  stepStatusColor,
  stepStatusIcon,
  stepStatusLabel,
} from './displayHelpers';
import type { StepGroup } from './types';

// =============================================================================
// Step group card (expandable)
// =============================================================================

export function StepGroupCard({ group }: { group: StepGroup }) {
  const [expanded, setExpanded] = useState(false);

  const statusColor = stepStatusColor(group.status);
  const statusIcon = stepStatusIcon(group.status);
  const statusLabel = stepStatusLabel(group.status, group.pauseKind);

  const rawOpLabel = friendlyOperationLabel(group.operationId);

  // For agent turns, derive a more descriptive label from the action outcome
  const isAgentTurn = group.operationId === AGENT_TURN_OPERATION;
  const isDispatchedTool = group.parentTurnKey != null;
  const opLabel = isAgentTurn ? agentTurnLabel(group.agentAction, rawOpLabel) : rawOpLabel;
  // For agent turns with tool invocations, show tool names as the detail
  // For agent turns with response options, show option count
  const effectiveDetail =
    isAgentTurn && group.invokedTools?.length
      ? group.invokedTools.map((t) => t.name).join(', ')
      : isAgentTurn && group.responseOptions?.options?.length
        ? `${String(group.responseOptions.options.length)} options (${group.responseOptions.type === 'multi' ? 'multi' : 'single'})`
        : group.stepDetail;

  // Per-delegate accent: stable hue derived from child sessionId. Lets the eye
  // cluster bubbles from the same child even when two parallel runners
  // interleave in chat. Applied as a CSS custom property so the .rt-step-card
  // rule paints a left border without inline-style override conflicts.
  const accentHue = group.delegateInfo?.accentHue;
  const cardStyle: CSSProperties = {
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    backgroundColor: 'var(--color-surface-0)',
    marginTop: 'var(--space-1)',
    marginBottom: 'var(--space-1)',
  };
  if (accentHue != null) {
    (cardStyle as Record<string, string>)['--rt-delegate-accent'] =
      `hsl(${String(accentHue)}, 55%, 55%)`;
  }

  return (
    <div
      className={`rt-step-card${isAgentTurn ? ' rt-step-card--turn' : ''}${
        isDispatchedTool ? ' rt-step-card--tool' : ''
      }${group.status === 'running' ? ' rt-step-card--running' : ''}${
        accentHue != null ? ' rt-step-card--delegate' : ''
      }`}
      style={cardStyle}
    >
      {/* Header — always visible */}
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
          {/* Left: name, operation, badges */}
          <div className="rt-step-left">
            <Row gap="2" align="center" style={{ minWidth: 0, flex: '1 1 auto' }}>
              <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
              <span
                style={{
                  color: statusColor,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon name={statusIcon} size="sm" />
              </span>
              {isAgentTurn && (
                <span className="rt-step-turn-glyph">
                  <Icon name="robot" size="sm" />
                </span>
              )}
              <Text
                size="sm"
                style={{
                  fontWeight: isDispatchedTool ? 500 : 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}
                title={group.stepName}
              >
                {group.stepName}
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
              {opLabel}
              {effectiveDetail && <span style={{ opacity: 0.7 }}>{` · ${effectiveDetail}`}</span>}
            </Text>

            {group.delegateInfo && (
              <Badge variant="info">
                {(() => {
                  const role = group.delegateInfo.role ?? 'delegate';
                  const wf = group.delegateInfo.workflowSlug;
                  const task = group.delegateInfo.taskName;
                  if (wf && task) return `${role} · ${wf} › ${task}`;
                  if (wf) return `${role} · ${wf}`;
                  if (task) return `${role} · ${task}`;
                  return role;
                })()}
              </Badge>
            )}
            {group.attempt > 1 && <Badge variant="paused">attempt {group.attempt}</Badge>}
          </div>

          {/* Right: timestamp (anchor), duration, status — stacked vertically and
              right-aligned so they always occupy the same spot across cards. */}
          <div className="rt-step-right">
            <Text size="xs" className="rt-step-right-item rt-step-time">
              {group.scheduledAt ? formatTime(group.scheduledAt) : '—'}
            </Text>
            <Text size="xs" className="rt-step-right-item rt-step-duration">
              {group.durationMs != null ? formatDuration(group.durationMs) : '—'}
            </Text>
            <Text
              variant="muted"
              size="xs"
              className="rt-step-right-item rt-step-status"
              style={{ color: statusColor }}
            >
              {statusLabel}
            </Text>
          </div>
        </div>

        {/* Row 2: step cost metadata — model + tokens (compact) */}
        {group.costInfo && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              marginTop: '2px',
              justifyContent: 'space-between',
            }}
          >
            {group.costInfo.model && (
              <Text
                variant="muted"
                size="xs"
                style={{ fontFamily: 'var(--font-family-mono)', fontSize: '10px' }}
              >
                {group.costInfo.model}
              </Text>
            )}
            {group.costInfo.totalTokens != null && group.costInfo.totalTokens > 0 && (
              <Text variant="muted" size="xs" style={{ fontSize: '10px' }}>
                {formatNumber(group.costInfo.totalTokens)} tok
                {(group.costInfo.promptTokens ?? 0) > 0 &&
                  ` (${formatNumber(group.costInfo.promptTokens ?? 0)} ctx)`}
              </Text>
            )}
            {group.costInfo.totalCostUsd != null && group.costInfo.totalCostUsd > 0 && (
              <Text variant="muted" size="xs" style={{ fontSize: '10px' }}>
                {formatCostUsd(group.costInfo.totalCostUsd)}
              </Text>
            )}
            {(group.costInfo.cacheReadTokens ?? 0) > 0 &&
              (group.costInfo.promptTokens ?? 0) > 0 && (
                <Text
                  variant="muted"
                  size="xs"
                  style={{ fontSize: '10px', color: 'var(--color-status-succeeded)' }}
                >
                  {Math.round(
                    ((group.costInfo.cacheReadTokens ?? 0) / (group.costInfo.promptTokens ?? 1)) *
                      100,
                  )}
                  % cached
                </Text>
              )}
          </div>
        )}
      </button>

      {/* A harness step says what it is doing while it does it, under the row
          and never inside the agent's message. It stays after the step ends —
          folded to its count, with the result beneath it. */}
      {group.operationId === HARNESS_RUN_OPERATION && <HarnessStepActivity group={group} />}

      {/* Expanded details */}
      {expanded && <StepGroupDetails group={group} />}
    </div>
  );
}

const HARNESS_RUNNING_STATUSES = new Set(['scheduled', 'running', 'retrying', 'waiting_on_child']);

function HarnessStepActivity({ group }: { group: StepGroup }) {
  const lines = useHarnessActivityLines(group.stepExecutionId);
  const running = HARNESS_RUNNING_STATUSES.has(group.status);
  const result = useHarnessResult(running ? undefined : group.outputRef);
  const harness = useHarnessName(group.inputRef);

  return (
    <div style={{ padding: '0 var(--space-3) var(--space-3)' }}>
      <HarnessActivityCard
        lines={lines}
        running={running}
        result={result}
        harness={harness}
        stepExecutionId={group.stepExecutionId}
      />
    </div>
  );
}

function PayloadViewer({ label, payloadRef }: { label: string; payloadRef: string }) {
  const { apiUrl, headers } = useApi();
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchPayload(apiUrl, headers, payloadRef));
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, payloadRef, headers, loaded]);

  return (
    <div>
      <Row gap="2" align="center">
        <Text variant="label" size="xs">
          {label}
        </Text>
        {!loaded && (
          <button
            onClick={() => void load()}
            style={{
              all: 'unset',
              cursor: 'pointer',
              color: 'var(--color-text-link)',
              fontSize: 'var(--font-size-xs)',
            }}
          >
            {loading ? <Spinner size="sm" /> : 'Load'}
          </button>
        )}
      </Row>
      {loaded && data != null && (
        <div style={{ marginTop: 'var(--space-1)' }}>
          <JsonViewer data={data} collapseDepth={2} maxHeight="200px" />
        </div>
      )}
      {error && (
        <Text size="xs" style={{ color: 'var(--color-status-failed)' }}>
          {error}
        </Text>
      )}
    </div>
  );
}

// =============================================================================
// Expanded step details (lazy loaded payload)
// =============================================================================

function StepGroupDetails({ group }: { group: StepGroup }) {
  const [showDebug, setShowDebug] = useState(false);
  const [showEvents, setShowEvents] = useState(false);

  const userVarChanges = group.variableChanges?.filter(
    (c) =>
      !c.key.startsWith('ai.') &&
      !c.key.startsWith('chat.') &&
      !c.key.startsWith('flow.') &&
      !c.key.startsWith('_'),
  );
  const hasUserVarChanges = userVarChanges && userVarChanges.length > 0;
  const isAiStep = group.stepType === 'ai' || group.operationId.startsWith('ai.');

  return (
    <div
      style={{
        padding: '0 var(--space-3) var(--space-3)',
        borderTop: '1px solid var(--color-border-subtle)',
      }}
    >
      <Column gap="2">
        {/* Error message — prominently shown at top */}
        {(group.userError ?? group.errorMessage) && (
          <div
            style={{
              marginTop: 'var(--space-2)',
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--color-status-failed-bg)',
              border: '1px solid color-mix(in srgb, var(--color-status-failed) 40%, transparent)',
            }}
          >
            {group.userError ? (
              <Column gap="1">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <Text
                    size="xs"
                    style={{
                      color: 'var(--color-status-failed)',
                      fontWeight: 600,
                      lineHeight: 1.5,
                    }}
                  >
                    {group.userError.title}
                  </Text>
                  <Badge variant="danger" style={{ fontSize: '9px' }}>
                    {group.userError.category}
                  </Badge>
                </div>
                <Text size="xs" style={{ color: 'var(--color-status-failed)', lineHeight: 1.5 }}>
                  {group.userError.message}
                </Text>
                {group.userError.suggestedActions &&
                  group.userError.suggestedActions.length > 0 && (
                    <Text size="xs" variant="muted" style={{ lineHeight: 1.4 }}>
                      {group.userError.suggestedActions.join(' · ')}
                    </Text>
                  )}
              </Column>
            ) : (
              <Text size="xs" style={{ color: 'var(--color-status-failed)', lineHeight: 1.5 }}>
                {group.errorMessage}
              </Text>
            )}
          </div>
        )}

        {/* Timing detail grid */}
        <div
          style={{
            paddingTop: group.errorMessage || group.userError ? 0 : 'var(--space-2)',
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            gap: '2px var(--space-3)',
            alignItems: 'baseline',
          }}
        >
          {group.scheduledAt && (
            <>
              <Text variant="muted" size="xs">
                Scheduled
              </Text>
              <Text size="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTimeFull(group.scheduledAt)}
              </Text>
            </>
          )}
          {group.startedAt && (
            <>
              <Text variant="muted" size="xs">
                Started
              </Text>
              <Text size="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTimeFull(group.startedAt)}
              </Text>
            </>
          )}
          {group.completedAt && (
            <>
              <Text variant="muted" size="xs">
                Completed
              </Text>
              <Text size="xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTimeFull(group.completedAt)}
              </Text>
            </>
          )}
          {group.durationMs != null && (
            <>
              <Text variant="muted" size="xs">
                Duration
              </Text>
              <Text size="xs" weight="medium">
                {formatDuration(group.durationMs)}
              </Text>
            </>
          )}
        </div>

        {/* AI step token/cost detail */}
        {isAiStep && group.costInfo && (
          <>
            <Divider />
            <div>
              <Text variant="label" size="xs" style={{ marginBottom: 'var(--space-1)' }}>
                AI Usage
              </Text>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto minmax(0, 1fr)',
                  gap: '2px var(--space-3)',
                  alignItems: 'baseline',
                  padding: 'var(--space-1) var(--space-2)',
                  backgroundColor: 'var(--color-surface-1)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                {group.costInfo.model && (
                  <>
                    <Text variant="muted" size="xs">
                      Model
                    </Text>
                    <Text size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
                      {group.costInfo.model}
                    </Text>
                  </>
                )}
                {group.costInfo.provider && (
                  <>
                    <Text variant="muted" size="xs">
                      Provider
                    </Text>
                    <Text size="xs">{group.costInfo.provider}</Text>
                  </>
                )}
                {(group.costInfo.promptTokens ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Context
                    </Text>
                    <Text size="xs">{formatNumber(group.costInfo.promptTokens ?? 0)} tokens</Text>
                  </>
                )}
                {(group.costInfo.promptTokens ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Input tokens
                    </Text>
                    <Text size="xs">{formatNumber(group.costInfo.promptTokens ?? 0)}</Text>
                  </>
                )}
                {(group.costInfo.completionTokens ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Output tokens
                    </Text>
                    <Text size="xs">{formatNumber(group.costInfo.completionTokens ?? 0)}</Text>
                  </>
                )}
                {(group.costInfo.reasoningTokens ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Reasoning tokens
                    </Text>
                    <Text size="xs">
                      {formatNumber(group.costInfo.reasoningTokens ?? 0)} (
                      {Math.round(
                        ((group.costInfo.reasoningTokens ?? 0) /
                          (group.costInfo.completionTokens ?? 1)) *
                          100,
                      )}
                      % of output)
                    </Text>
                  </>
                )}
                {(group.costInfo.totalTokens ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Total tokens
                    </Text>
                    <Text size="xs" weight="medium">
                      {formatNumber(group.costInfo.totalTokens ?? 0)}
                    </Text>
                  </>
                )}
                {(group.costInfo.totalCostUsd ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Cost
                    </Text>
                    <Text size="xs" weight="medium">
                      {formatCostUsd(group.costInfo.totalCostUsd ?? 0)}
                    </Text>
                  </>
                )}
                {(group.costInfo.cacheReadTokens ?? 0) > 0 && (
                  <>
                    <Text variant="muted" size="xs">
                      Cache hit
                    </Text>
                    <Text
                      size="xs"
                      weight="medium"
                      style={{ color: 'var(--color-status-succeeded)' }}
                    >
                      {Math.round(
                        ((group.costInfo.cacheReadTokens ?? 0) /
                          (group.costInfo.promptTokens ?? 1)) *
                          100,
                      )}
                      % ({formatNumber(group.costInfo.cacheReadTokens ?? 0)} read
                      {(group.costInfo.cacheWriteTokens ?? 0) > 0 &&
                        ` / ${formatNumber(group.costInfo.cacheWriteTokens ?? 0)} write`}
                      )
                    </Text>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* Input payload (lazy-loaded) */}
        {group.inputRef && (
          <>
            <Divider />
            <PayloadViewer label="Input" payloadRef={group.inputRef} />
          </>
        )}

        {/* Output payload (lazy-loaded, with media support) */}
        {group.outputRef && (
          <>
            <Divider />
            <PayloadViewer label="Output" payloadRef={group.outputRef} />
          </>
        )}

        {/* User-facing variable changes */}
        {hasUserVarChanges && (
          <>
            <Divider />
            <div>
              <Text variant="label" size="xs" style={{ marginBottom: 'var(--space-1)' }}>
                State Updates
              </Text>
              <Column gap="1">
                {userVarChanges.map((change) => (
                  <VariableChangeRow key={change.key} change={change} />
                ))}
              </Column>
            </div>
          </>
        )}

        {/* Events sub-timeline — collapsed by default */}
        <Divider />
        <button
          onClick={() => {
            setShowEvents((v) => !v);
          }}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
          }}
        >
          <Icon
            name={showEvents ? 'caret-down' : 'caret-right'}
            size="xs"
            color="var(--color-text-muted)"
          />
          <Text variant="muted" size="xs">
            {showEvents ? 'Hide' : 'Show'} {group.events.length} event
            {group.events.length !== 1 ? 's' : ''}
          </Text>
        </button>
        {showEvents && (
          <Column gap="0">
            {group.events.map((evt) => (
              <SubEventRow key={evt.eventId} event={evt} />
            ))}
          </Column>
        )}

        {/* Debug info — behind disclosure */}
        <button
          onClick={() => {
            setShowDebug((v) => !v);
          }}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
          }}
        >
          <Icon
            name={showDebug ? 'caret-down' : 'caret-right'}
            size="xs"
            color="var(--color-text-muted)"
          />
          <Text variant="muted" size="xs">
            Debug info
          </Text>
        </button>
        {showDebug && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              gap: 'var(--space-1) var(--space-3)',
              alignItems: 'baseline',
              wordBreak: 'break-word',
              padding: 'var(--space-1) var(--space-2)',
              backgroundColor: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <Text variant="muted" size="xs">
              Step ID
            </Text>
            <Text variant="mono" size="xs">
              {group.stepId}
            </Text>
            {group.stepExecutionId && (
              <>
                <Text variant="muted" size="xs">
                  Execution
                </Text>
                <Text variant="mono" size="xs">
                  {group.stepExecutionId.slice(0, 12)}…
                </Text>
              </>
            )}
            <Text variant="muted" size="xs">
              Type
            </Text>
            <Text size="xs">{group.stepType}</Text>
            <Text variant="muted" size="xs">
              Operation
            </Text>
            <Text size="xs">{group.operationId}</Text>
          </div>
        )}
      </Column>
    </div>
  );
}

/** Renders a single variable change with value preview */
function VariableChangeRow({ change }: { change: { key: string; value?: unknown } }) {
  const [expanded, setExpanded] = useState(false);
  const isComplex = typeof change.value === 'object' && change.value !== null;

  // Extract a short preview for complex values
  const preview = isComplex
    ? summarizeVariableValue(change.value)
    : change.value != null
      ? typeof change.value === 'object'
        ? JSON.stringify(change.value)
        : String(change.value as string | number | boolean | bigint | symbol | null | undefined)
      : '(empty)';

  return (
    <div
      style={{
        padding: 'var(--space-1) var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: 'var(--color-surface-1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          cursor: isComplex ? 'pointer' : 'default',
        }}
        onClick={
          isComplex
            ? () => {
                setExpanded((e) => !e);
              }
            : undefined
        }
      >
        {isComplex && (
          <Icon
            name={expanded ? 'caret-down' : 'caret-right'}
            size="xs"
            color="var(--color-text-muted)"
          />
        )}
        <Text weight="medium" size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
          {change.key}
        </Text>
        <span style={{ flex: 1 }} />
        {!expanded && (
          <Text
            variant="muted"
            size="xs"
            style={{
              fontFamily: 'var(--font-family-mono)',
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {preview}
          </Text>
        )}
      </div>
      {expanded && isComplex && (
        <div style={{ marginTop: 'var(--space-1)', paddingLeft: isComplex ? '18px' : '0' }}>
          <JsonViewer data={change.value} collapseDepth={2} maxHeight="200px" />
        </div>
      )}
    </div>
  );
}

function summarizeVariableValue(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length <= 3) return `{ ${keys.join(', ')} }`;
    return `{ ${keys.slice(0, 3).join(', ')}, … } (${keys.length})`;
  }
  return String(value);
}

// =============================================================================
// Sub-event row (within step group)
// =============================================================================

function SubEventRow({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);
  const evData = ev(event);
  const label = friendlyEventLabel(event.eventType, evData.stepName, evData.pauseType);
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
          padding: 'var(--space-1) var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          transition: 'background-color 100ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--color-surface-2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <Row gap="2" align="center">
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: color,
              flexShrink: 0,
            }}
          />
          <Text size="xs">{label}</Text>
          <span style={{ flex: 1 }} />
          <Text variant="muted" size="xs">
            {formatTime(event.timestamp)}
          </Text>
        </Row>
      </button>
      {expanded && event.data && (
        <div style={{ marginLeft: 'var(--space-5)', marginBottom: 'var(--space-1)' }}>
          <JsonViewer data={event.data} collapseDepth={2} maxHeight="150px" />
        </div>
      )}
    </div>
  );
}
