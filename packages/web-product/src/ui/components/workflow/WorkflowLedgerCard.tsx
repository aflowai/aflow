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
import type { ActiveLearning, RunEvaluationEnvelope } from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Shape types (mirrors WorkflowLedgerGetOutputSchema)
// ---------------------------------------------------------------------------

interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'skipped';
  summary?: string;
  failureReason?: string;
  attempts?: number;
  durationMs?: number;
  costCents?: number;
  metrics?: Record<string, unknown>;
}

interface Learning {
  id: string;
  category: string;
  observation: string;
  recommendation?: string;
  confidence?: string;
  status?: string;
}

interface ActiveLearningRow {
  key: string;
  category: string;
  observation: string;
  recommendation?: string;
  confidence?: string;
}

function toActiveLearningRow(entry: ActiveLearning): ActiveLearningRow | null {
  switch (entry.kind) {
    case 'trajectory':
      return {
        key: 'trajectory',
        category: 'trajectory',
        observation: [
          `objective: ${entry.objective.direction} ${entry.objective.metricKey}`,
          entry.peak !== undefined ? `peak ${String(entry.peak)}` : null,
          entry.recentScores.length > 0 ? `recent: ${entry.recentScores.join(', ')}` : null,
        ]
          .filter((p) => p !== null)
          .join(' · '),
      };
    case 'durable':
      return {
        key: entry.learningId,
        category: entry.learningKind,
        observation: entry.statement,
        confidence: entry.confidence,
      };
    case 'candidate':
      return {
        key: `${entry.runId}:${entry.learningId}`,
        category: entry.category,
        observation: entry.observation,
        ...(entry.recommendation !== undefined ? { recommendation: entry.recommendation } : {}),
        confidence: entry.confidence,
      };
    default:
      // Historical sessions replay persisted step outputs whose entries may
      // not match the current union — skip them instead of crashing the card.
      return null;
  }
}

interface LedgerEntry {
  runId: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  snapshot?: { workflowRevision?: number };
  status: string;
  taskResults: TaskResult[];
  evaluation?: RunEvaluationEnvelope;
  totalCostCents?: number;
  totalTokens?: number;
  learnings?: Learning[];
}

interface TrajectoryRow {
  runId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  learningCount?: number;
  costCents?: number;
  score?: number | null;
}

interface WorkflowLedgerData {
  workflowId: string;
  totalEntries: number;
  trajectory?: TrajectoryRow[];
  entries: LedgerEntry[];
  activeLearnings: ActiveLearning[];
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isWorkflowLedger(data: unknown): data is WorkflowLedgerData {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj['workflowId'] === 'string' &&
    typeof obj['totalEntries'] === 'number' &&
    Array.isArray(obj['entries']) &&
    Array.isArray(obj['activeLearnings'])
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runStatusVariant(status: string): 'succeeded' | 'failed' | 'warning' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'skipped':
      return 'warning';
    case 'running':
    case 'in_flight':
    case 'paused':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function evalVerdictVariant(
  verdict: 'pass' | 'fail' | 'partial' | 'error',
): 'succeeded' | 'failed' | 'warning' {
  switch (verdict) {
    case 'pass':
      return 'succeeded';
    case 'partial':
      return 'warning';
    case 'fail':
    case 'error':
      return 'failed';
  }
}

function taskStatusVariant(status: string): 'succeeded' | 'failed' | 'warning' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'warning';
    default:
      return 'neutral';
  }
}

function learningIcon(category: string): string {
  switch (category) {
    case 'worked':
      return '+';
    case 'failed':
      return '-';
    case 'discovered':
      return '*';
    case 'hypothesis':
      return '?';
    case 'workflow_adjustment':
      return '~';
    case 'platform':
      return '#';
    default:
      return ' ';
  }
}

function learningColor(category: string): string {
  switch (category) {
    case 'worked':
      return 'var(--color-success-default)';
    case 'failed':
      return 'var(--color-danger-default)';
    default:
      return 'var(--color-text-muted)';
  }
}

function formatOutcomeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    /* non-JSON-serializable */
  }
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return 'Symbol()';
  return '[Unsupported]';
}

function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return '';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatCost(cents?: number): string {
  if (cents == null) return '';
  if (cents < 100) return `${cents.toFixed(1)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

function taskCounts(taskResults: TaskResult[]): { ok: number; fail: number; total: number } {
  let ok = 0;
  let fail = 0;
  for (const t of taskResults) {
    if (t.status === 'completed') ok += 1;
    else if (t.status === 'failed') fail += 1;
  }
  return { ok, fail, total: taskResults.length };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowLedgerCard({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  if (!isWorkflowLedger(data)) {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }

  const { totalEntries, entries } = data;
  const trajectory = data.trajectory ?? [];
  const statusRows: Array<{ status: string }> = entries.length > 0 ? entries : trajectory;
  const succeeded = statusRows.filter((e) => e.status === 'completed').length;
  const failed = statusRows.filter((e) => e.status === 'failed').length;
  const hasRuns = entries.length > 0 || trajectory.length > 0;
  const activeLearningRows = data.activeLearnings.flatMap((entry) => {
    const row = toActiveLearningRow(entry);
    return row !== null ? [row] : [];
  });
  const learningCount = data.activeLearnings.filter(
    (e) => e.kind === 'durable' || e.kind === 'candidate',
  ).length;

  return (
    <Card
      style={{ backgroundColor: 'var(--surface-raised-alpha)', marginRight: 'var(--space-3xl)' }}
    >
      <CardHeader>
        <Inline gap="2" align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Inline gap="2" align="center">
            <Icon name="list" size="sm" />
            <Text variant="label" size="sm">
              Workflow Ledger
            </Text>
            <Text variant="muted" size="xs">
              {String(totalEntries)} run{totalEntries !== 1 ? 's' : ''}
            </Text>
            {succeeded > 0 && <Badge variant="succeeded">{String(succeeded)} ok</Badge>}
            {failed > 0 && <Badge variant="failed">{String(failed)} fail</Badge>}
            {learningCount > 0 && (
              <Text variant="muted" size="xs">
                · {String(learningCount)} learning
                {learningCount !== 1 ? 's' : ''}
              </Text>
            )}
          </Inline>
          <Inline gap="2" align="center">
            <button
              onClick={() => {
                setExpanded(!expanded);
                if (expanded) setShowDetails(false);
              }}
              aria-expanded={expanded}
              style={{
                background: 'none',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-sm)',
                padding: '2px 8px',
                cursor: 'pointer',
                fontSize: '12px',
                color: 'var(--color-text-muted)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Icon name={expanded ? 'caret-up' : 'caret-down'} size="xs" />
              {expanded ? 'Hide' : 'Show'}
            </button>
            {expanded && entries.length > 0 && (
              <button
                onClick={() => {
                  setShowDetails(!showDetails);
                }}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  color: 'var(--color-text-muted)',
                }}
              >
                {showDetails ? 'Less' : 'More'}
              </button>
            )}
          </Inline>
        </Inline>
      </CardHeader>

      {expanded && (
        <CardBody>
          <Stack gap="3">
            {/* Run entries */}
            {entries.length > 0 && (
              <Stack gap="1">
                <Text variant="label" size="xs">
                  Runs ({String(entries.length)})
                </Text>
                {entries.map((e) => {
                  const counts = taskCounts(e.taskResults);
                  const duration = formatDuration(e.startedAt, e.completedAt);
                  return (
                    <Stack key={e.runId} gap="1">
                      <Inline gap="2" align="center">
                        <Badge variant={runStatusVariant(e.status)}>{e.status}</Badge>
                        <Text size="xs" variant="muted" style={{ fontFamily: 'monospace' }}>
                          {e.runId.slice(0, 8)}
                        </Text>
                        <Text size="xs" variant="muted">
                          {formatTime(e.startedAt)}
                          {duration ? ` · ${duration}` : ''}
                        </Text>
                        {counts.total > 0 && (
                          <Text size="xs" variant="muted">
                            tasks {String(counts.ok)}/{String(counts.total)}
                            {counts.fail > 0 ? ` (${String(counts.fail)} failed)` : ''}
                          </Text>
                        )}
                        {e.evaluation?.summary && (
                          <Badge variant={evalVerdictVariant(e.evaluation.summary.verdict)}>
                            eval {e.evaluation.summary.verdict}
                          </Badge>
                        )}
                        {e.evaluation?.outcomeEvaluation && (
                          <Badge
                            variant={e.evaluation.outcomeEvaluation.allMet ? 'succeeded' : 'failed'}
                          >
                            {e.evaluation.outcomeEvaluation.allMet
                              ? 'outcomes met'
                              : 'outcomes missed'}
                          </Badge>
                        )}
                        {e.totalCostCents != null && (
                          <Text size="xs" variant="muted">
                            {formatCost(e.totalCostCents)}
                          </Text>
                        )}
                      </Inline>

                      {/* Per-entry details */}
                      {showDetails && (
                        <Stack
                          gap="1"
                          style={{
                            paddingLeft: 'var(--space-4)',
                            borderLeft: '1px solid var(--color-border-default)',
                            marginLeft: 'var(--space-1)',
                          }}
                        >
                          {/* Task results */}
                          {e.taskResults.map((t) => (
                            <Inline key={t.taskId} gap="2" align="baseline">
                              <Badge variant={taskStatusVariant(t.status)}>{t.status}</Badge>
                              <Text size="xs">{t.taskId}</Text>
                              {t.attempts != null && t.attempts > 1 && (
                                <Text size="xs" variant="muted">
                                  ×{String(t.attempts)}
                                </Text>
                              )}
                              {t.failureReason && (
                                <Text
                                  size="xs"
                                  variant="muted"
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    maxWidth: 480,
                                  }}
                                  title={t.failureReason}
                                >
                                  {t.failureReason}
                                </Text>
                              )}
                            </Inline>
                          ))}

                          {/* Outcome results */}
                          {e.evaluation?.outcomeEvaluation?.outcomeResults.map((o) => (
                            <Inline key={o.outcomeId} gap="2" align="center">
                              <Icon name={o.met ? 'check' : 'x'} size="xs" />
                              <Text size="xs">{o.outcomeId}</Text>
                              {o.value != null && (
                                <Text size="xs" variant="muted">
                                  = {formatOutcomeValue(o.value)}
                                </Text>
                              )}
                            </Inline>
                          ))}

                          {/* Per-run learnings */}
                          {e.learnings?.map((l) => (
                            <Inline key={l.id} gap="2" align="baseline">
                              <Text
                                size="xs"
                                style={{
                                  fontFamily: 'monospace',
                                  color: learningColor(l.category),
                                }}
                              >
                                [{learningIcon(l.category)}]
                              </Text>
                              <Text size="xs">{l.observation}</Text>
                            </Inline>
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  );
                })}
              </Stack>
            )}

            {entries.length === 0 && trajectory.length > 0 && (
              <Stack gap="1">
                <Text variant="label" size="xs">
                  Runs ({String(trajectory.length)})
                </Text>
                {trajectory.map((e) => {
                  const duration = formatDuration(e.startedAt, e.completedAt);
                  return (
                    <Inline key={e.runId} gap="2" align="center">
                      <Badge variant={runStatusVariant(e.status)}>{e.status}</Badge>
                      <Text size="xs" variant="muted" style={{ fontFamily: 'monospace' }}>
                        {e.runId.slice(0, 8)}
                      </Text>
                      <Text size="xs" variant="muted">
                        {formatTime(e.startedAt)}
                        {duration ? ` · ${duration}` : ''}
                      </Text>
                      {e.score != null && (
                        <Text size="xs" variant="muted">
                          score {String(e.score)}
                        </Text>
                      )}
                      {e.learningCount != null && e.learningCount > 0 && (
                        <Text size="xs" variant="muted">
                          {String(e.learningCount)} learning{e.learningCount !== 1 ? 's' : ''}
                        </Text>
                      )}
                      {e.costCents != null && (
                        <Text size="xs" variant="muted">
                          {formatCost(e.costCents)}
                        </Text>
                      )}
                    </Inline>
                  );
                })}
              </Stack>
            )}

            {/* Active learnings */}
            {activeLearningRows.length > 0 && (
              <Stack gap="1">
                <Text variant="label" size="xs">
                  Active learnings ({String(activeLearningRows.length)})
                </Text>
                {activeLearningRows.map((l) => (
                  <Inline key={l.key} gap="2" align="baseline">
                    <Text
                      size="xs"
                      style={{
                        fontFamily: 'monospace',
                        color: learningColor(l.category),
                      }}
                    >
                      [{learningIcon(l.category)}]
                    </Text>
                    <Text size="xs">{l.observation}</Text>
                    {l.confidence && (
                      <Text size="xs" variant="muted">
                        [{l.confidence}]
                      </Text>
                    )}
                    {showDetails && l.recommendation && (
                      <Text size="xs" variant="muted">
                        → {l.recommendation}
                      </Text>
                    )}
                  </Inline>
                ))}
              </Stack>
            )}

            {!hasRuns && activeLearningRows.length === 0 && (
              <Text size="xs" variant="muted">
                No runs or learnings yet.
              </Text>
            )}
          </Stack>
        </CardBody>
      )}
    </Card>
  );
}
