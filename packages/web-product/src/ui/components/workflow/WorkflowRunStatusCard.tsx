'use client';

import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  Badge,
  Text,
  Stack,
  Inline,
  Icon,
  JsonViewer,
} from '@aflow/design-system';

import { useSpace } from '../providers.js';
import { FeedbackPicker } from '../feedback/FeedbackPicker.js';

// ---------------------------------------------------------------------------
// Shape types (mirrors workflow.run.start / resume / complete output)
// ---------------------------------------------------------------------------

interface TaskTool {
  toolId: string;
  taskId: string;
  name: string;
}

interface TaskResult {
  taskId: string;
  status: string;
  attempts?: number;
  summary?: string;
  metrics?: Record<string, unknown>;
}

/** Output from workflow.run.start */
interface RunStartData {
  runId: string;
  slug: string;
  status: string;
  taskTools: TaskTool[];
}

/** Output from workflow.run.resume */
interface RunResumeData {
  runId: string;
  slug: string;
  status: string;
  completedTasks: string[];
  pendingTasks: string[];
  taskResults: TaskResult[];
  taskTools: TaskTool[];
}

/** Output from workflow.run.cancel and harness-driven terminal events */
interface RunCompleteData {
  runId: string;
  slug?: string;
  status: string;
  completedAt?: string;
}

type WorkflowRunStatusData = RunStartData | RunResumeData | RunCompleteData;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isRunStart(data: Record<string, unknown>): boolean {
  return (
    typeof data['runId'] === 'string' &&
    typeof data['slug'] === 'string' &&
    Array.isArray(data['taskTools'])
  );
}

function isRunResume(data: Record<string, unknown>): boolean {
  return (
    typeof data['runId'] === 'string' &&
    Array.isArray(data['completedTasks']) &&
    Array.isArray(data['pendingTasks'])
  );
}

function isRunComplete(data: Record<string, unknown>): boolean {
  return (
    typeof data['runId'] === 'string' &&
    typeof data['status'] === 'string' &&
    !('taskId' in data) &&
    !('taskTools' in data) &&
    !('completedTasks' in data)
  );
}

export function isWorkflowRunStatus(data: unknown): data is WorkflowRunStatusData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return isRunStart(obj) || isRunResume(obj) || isRunComplete(obj);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusVariant(status: string): 'succeeded' | 'failed' | 'warning' | 'neutral' {
  switch (status) {
    case 'running':
      return 'warning';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'paused':
      return 'neutral';
    case 'cancelled':
      return 'failed';
    default:
      return 'neutral';
  }
}

function taskStatusVariant(status: string): 'succeeded' | 'failed' | 'warning' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'neutral';
    default:
      return 'warning';
  }
}

/**
 * Classify a task `summary` string. `summary` is server-side capped at 500 chars
 * and is also fed back to the agent as its tool result, so we keep the cap and
 * just decide how to render the three shapes the renderer sees:
 *  - `text`     — human-readable (e.g. "Resolved via workflow.run.resume…")
 *  - `json`     — short structured payload that fits under 500 chars and parses
 *  - `truncated`— starts with `{`/`[` but won't parse (mid-string cut). Noise;
 *                 we hide it. Full output lives in metricsJson/outputRef and
 *                 will get a dedicated drill-down later.
 */
function classifySummary(
  s: string,
): { kind: 'text' } | { kind: 'json'; data: unknown } | { kind: 'truncated' } {
  const trimmed = s.trim();
  const looksStructured = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksStructured) return { kind: 'text' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return { kind: 'json', data: parsed };
    return { kind: 'text' };
  } catch {
    return { kind: 'truncated' };
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowRunStatusCard({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object') {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }

  const raw = data as Record<string, unknown>;

  // Run start
  if (isRunStart(raw) && !isRunResume(raw)) {
    const d = data as RunStartData;
    return (
      <Card style={{ backgroundColor: 'var(--color-surface-0)' }}>
        <CardHeader>
          <Inline gap="2" align="center">
            <Icon name="play" size="sm" />
            <Text variant="label" size="sm">
              Workflow Run Started
            </Text>
            <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
          </Inline>
        </CardHeader>
        <CardBody>
          <Stack gap="2">
            <Inline gap="2" align="center">
              <Text size="xs" variant="muted">
                Workflow:
              </Text>
              <Text size="xs">{d.slug}</Text>
              <Text size="xs" variant="muted">
                Run:
              </Text>
              <Text size="xs">{d.runId.slice(0, 8)}</Text>
            </Inline>
            <Stack gap="1">
              <Text variant="label" size="xs">
                Available tasks ({String(d.taskTools.length)})
              </Text>
              {d.taskTools.map((t) => (
                <Inline key={t.taskId} gap="2" align="center">
                  <Icon name="minus" size="xs" />
                  <Text size="xs">{t.name}</Text>
                  <Text size="xs" variant="muted">
                    {t.toolId}
                  </Text>
                </Inline>
              ))}
            </Stack>
          </Stack>
        </CardBody>
      </Card>
    );
  }

  // Run resume
  if (isRunResume(raw)) {
    const d = data as RunResumeData;
    const completedCount = d.completedTasks.length;
    const totalCount = completedCount + d.pendingTasks.length;
    return (
      <Card style={{ backgroundColor: 'var(--color-surface-0)' }}>
        <CardHeader>
          <Inline gap="2" align="center">
            <Icon name="refresh" size="sm" />
            <Text variant="label" size="sm">
              Workflow Run Resumed
            </Text>
            <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
            <Text size="xs" variant="muted">
              {String(completedCount)}/{String(totalCount)} tasks done
            </Text>
          </Inline>
        </CardHeader>
        <CardBody>
          <Stack gap="2">
            <Inline gap="2" align="center">
              <Text size="xs" variant="muted">
                Workflow:
              </Text>
              <Text size="xs">{d.slug}</Text>
              <Text size="xs" variant="muted">
                Run:
              </Text>
              <Text size="xs">{d.runId.slice(0, 8)}</Text>
            </Inline>
            {/* Task results */}
            {d.taskResults.length > 0 && (
              <Stack gap="2">
                <Text variant="label" size="xs">
                  Completed tasks
                </Text>
                {d.taskResults.map((t) => {
                  const summary = t.summary ? classifySummary(t.summary) : null;
                  return (
                    <Stack key={t.taskId} gap="1">
                      <Inline gap="2" align="center">
                        <Badge variant={taskStatusVariant(t.status)}>{t.status}</Badge>
                        <Text size="xs">{t.taskId}</Text>
                        {t.attempts != null && t.attempts > 1 && (
                          <Text size="xs" variant="muted">
                            ({String(t.attempts)} attempts)
                          </Text>
                        )}
                        {summary?.kind === 'text' && (
                          <Text size="xs" variant="muted">
                            {t.summary}
                          </Text>
                        )}
                      </Inline>
                      {summary?.kind === 'json' && (
                        <JsonViewer data={summary.data} collapseDepth={1} maxHeight="240px" />
                      )}
                    </Stack>
                  );
                })}
              </Stack>
            )}
            {/* Pending tasks */}
            {d.pendingTasks.length > 0 && (
              <Stack gap="1">
                <Text variant="label" size="xs">
                  Pending tasks
                </Text>
                {d.pendingTasks.map((taskId) => (
                  <Inline key={taskId} gap="2" align="center">
                    <Icon name="minus" size="xs" />
                    <Text size="xs">{taskId}</Text>
                  </Inline>
                ))}
              </Stack>
            )}
          </Stack>
        </CardBody>
      </Card>
    );
  }

  // Run complete
  if (isRunComplete(raw)) {
    return <RunCompleteCard data={data as RunCompleteData} />;
  }

  // Fallback
  return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
}

// ---------------------------------------------------------------------------

function RunCompleteCard({ data }: { data: RunCompleteData }) {
  const { activeSpaceId } = useSpace();
  const [feedbackDismissed, setFeedbackDismissed] = useState(false);
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(data.status);

  return (
    <Card style={{ backgroundColor: 'var(--color-surface-0)' }}>
      <CardHeader>
        <Inline gap="2" align="center">
          <Icon name={data.status === 'completed' ? 'check-circle' : 'warning-circle'} size="sm" />
          <Text variant="label" size="sm">
            Workflow Run {data.status === 'completed' ? 'Completed' : 'Finalized'}
          </Text>
          <Badge variant={statusVariant(data.status)}>{data.status}</Badge>
        </Inline>
      </CardHeader>
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" align="center">
            <Text size="xs" variant="muted">
              Run: {data.runId.slice(0, 8)}
            </Text>
            {data.completedAt && (
              <Text size="xs" variant="muted">
                at {new Date(data.completedAt).toLocaleString()}
              </Text>
            )}
          </Inline>

          {isTerminal && activeSpaceId && data.slug && !feedbackDismissed && (
            <FeedbackPicker
              spaceId={activeSpaceId}
              subjectKind="run"
              subjectId={`${data.slug}:${data.runId}`}
              onSubmitted={() => {
                setFeedbackDismissed(true);
              }}
              onDismiss={() => {
                setFeedbackDismissed(true);
              }}
              compact
            />
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
