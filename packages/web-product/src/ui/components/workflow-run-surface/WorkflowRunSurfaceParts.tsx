'use client';

import { useState } from 'react';
import { Icon, JsonViewer, ShimmerText, SwapStack } from '@aflow/design-system';
import { sanitizeTerminalErrorMessage, type WorkflowRunResult } from '@aflow/schemas';
import { useSpace } from '../providers.js';
import { spaceRoute } from '../../lib/space-routes.js';
import type { WorkflowSurfaceTaskState, WorkflowSurfaceTaskWhen } from '../../lib/types.js';
import { pickThinkingVerb, resolveActionLabel, THINKING_CLASS_OPS } from '../../lib/op-labels.js';
import { MarkdownRenderer } from '../markdown-renderer.js';
import {
  ACTIVE_OP_STALE_THRESHOLD_MS,
  THINKING_GRACE_MS,
  compactSkipReason,
  type PillTone,
} from './workflowRunSurfaceHelpers.js';

// =============================================================================
// RunSummary — compact run-level progress read in the header. Shows
// "done/total", a failed count when any task failed, and (for terminal
// runs) total wall-clock. Gives the card the "how far / how long" sense
// the bare status pill lacked.
// =============================================================================

export function RunSummary({
  done,
  total,
  failed,
  durationLabel,
}: {
  done: number;
  total: number;
  failed: number;
  durationLabel?: string | undefined;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1-5)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-muted)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      <span>
        {done}/{total}
      </span>
      {failed > 0 && <span style={{ color: 'var(--color-status-failed)' }}>{failed} failed</span>}
      {durationLabel && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <Icon name="clock" size="xs" />
          {durationLabel}
        </span>
      )}
    </span>
  );
}

// =============================================================================
// ConditionLine — a task's `when` guard as a labeled disclosure.
// Collapsed: status label only (reads as a condition, not a task description).
// Expanded (click): shows the compacted expression.
//   potential → Condition
//   met       → ✓ Condition met
//   not_met   → ✕ Condition not met
// =============================================================================

export function joinWhenClauses(when: WorkflowSurfaceTaskWhen): string {
  return when.clauses.join(when.mode === 'any' ? ' or ' : ' and ');
}

type ConditionOutcome = 'potential' | 'met' | 'not_met';

const CONDITION_LABEL: Record<ConditionOutcome, string> = {
  potential: 'Condition',
  met: 'Condition met',
  not_met: 'Condition not met',
};

function ConditionOutcomeIcon({ outcome }: { outcome: ConditionOutcome }) {
  if (outcome === 'met') {
    return <Icon name="check" size="xs" weight="bold" color="var(--color-success-default)" />;
  }
  if (outcome === 'not_met') {
    return <Icon name="x" size="xs" weight="bold" />;
  }
  return <Icon name="git-branch" size="xs" />;
}

/** Shared expandable condition row used by ConditionLine + SkipReasonLine. */
export function ConditionDisclosure({
  outcome,
  expression,
  title,
}: {
  outcome: ConditionOutcome;
  expression?: string;
  /** Full tooltip (recorded skip reason, etc.). */
  title?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = CONDITION_LABEL[outcome];
  const canExpand = Boolean(expression);
  const tip = title ?? (expression ? `${label} — ${expression}` : label);

  const rowStyle = {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: 'var(--space-1)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-muted)',
  };

  return (
    <div style={{ marginTop: 'var(--space-1)' }}>
      {canExpand ? (
        <button
          type="button"
          onClick={() => {
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          title={tip}
          style={{
            ...rowStyle,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
          <ConditionOutcomeIcon outcome={outcome} />
          <span style={{ flexShrink: 0 }}>{label}</span>
        </button>
      ) : (
        <div style={rowStyle} title={tip}>
          <ConditionOutcomeIcon outcome={outcome} />
          <span style={{ flexShrink: 0 }}>{label}</span>
        </div>
      )}
      {expanded && expression && (
        <div
          style={{
            marginTop: 2,
            marginLeft: 18,
            maxWidth: 480,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
          }}
          title={expression}
        >
          {expression}
        </div>
      )}
    </div>
  );
}

export function ConditionLine({
  when,
  variant,
}: {
  when: WorkflowSurfaceTaskWhen;
  variant: 'potential' | 'met';
}) {
  return <ConditionDisclosure outcome={variant} expression={joinWhenClauses(when)} />;
}

// =============================================================================
// SkipReasonLine — untaken branch via ConditionDisclosure (not_met). Prefer
// definition-sourced `when` clauses; fall back to a compacted ledger summary.
// =============================================================================

export function SkipReasonLine({
  task,
  when,
}: {
  task: WorkflowSurfaceTaskState;
  when?: WorkflowSurfaceTaskWhen;
}) {
  const recorded = task.summary?.trim();
  const expression = when
    ? joinWhenClauses(when)
    : recorded
      ? compactSkipReason(recorded)
      : undefined;
  const title = recorded
    ? `Condition not met — ${recorded.replace(/^skipped[\s:—–-]*/i, '').trim()}`
    : undefined;
  return (
    <ConditionDisclosure
      outcome="not_met"
      {...(expression ? { expression } : {})}
      {...(title ? { title } : {})}
    />
  );
}

// =============================================================================
// AttemptBadge — surfaces `task.attempt` when a task was retried. This was
// in reducer state but never rendered; a silent retry is exactly the kind
// of thing an operator wants to see.
// =============================================================================

export function AttemptBadge({ attempt }: { attempt: number }) {
  return (
    <span
      title={`This task is on attempt ${String(attempt)} (it was retried).`}
      style={{
        marginTop: 'var(--space-1)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-status-paused)',
      }}
    >
      <Icon name="refresh" size="xs" />
      retry ×{attempt}
    </span>
  );
}

// =============================================================================
// OpenRunnerLink — small "↗ open runner" affordance under each task row
// that has a `workerSessionId`. Opens the worker's chat session in a new
// tab so the operator can drill into the runner's timeline / messages /

const CYBERNETIC_RUNNER_AGENT_ID = 'cybernetic-runner';

export function OpenRunnerLink({ workerSessionId }: { workerSessionId: string }) {
  const { activeSpace } = useSpace();
  const spaceSlug = activeSpace?.slug;
  const chatHref = spaceRoute(
    spaceSlug,
    `/chat?agentId=${encodeURIComponent(CYBERNETIC_RUNNER_AGENT_ID)}&session=${encodeURIComponent(workerSessionId)}`,
  );
  return (
    <a
      href={chatHref}
      target="_blank"
      rel="noopener noreferrer"
      title="Open this task's runner chat in a new tab"
      aria-label="Open runner chat in new tab"
      style={{
        position: 'absolute',
        top: 'var(--space-1)',
        right: 'var(--space-2)',
        display: 'inline-flex',
        alignItems: 'center',
        padding: 2,
        color: 'var(--color-text-secondary)',
        textDecoration: 'none',
        borderRadius: 'var(--radius-sm)',
        opacity: 0.7,
        transition: 'opacity 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '0.7';
      }}
    >
      <Icon name="arrow-square-out" size="xs" />
    </a>
  );
}

// =============================================================================
// FailureLine — compact failure detail rendered under failed/cancelled rows.

export function FailureLine({ task }: { task: WorkflowSurfaceTaskState }) {
  const { failure, failureReason } = task;
  if (!failure && !failureReason) return null;
  const cleanedReason = failureReason ? sanitizeTerminalErrorMessage(failureReason, 500) : null;
  return (
    <div
      style={{
        marginTop: 'var(--space-1)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--color-text-secondary)',
      }}
    >
      {failure && (
        <>
          <Pill
            label={failure.code}
            tone="destructive"
            title={`${failure.code} (${failure.classification})`}
          />
          {failure.retryable && (
            <Pill label="retryable" tone="info" title="this failure is classified as retryable" />
          )}
        </>
      )}
      {cleanedReason && (
        <span
          style={{
            maxWidth: 480,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={cleanedReason}
        >
          {cleanedReason}
        </span>
      )}
    </div>
  );
}

// =============================================================================
// SummaryLine — the agent task's one-line output summary (`task.summary`),
// rendered on terminal agent rows (succeeded AND failed — a task can do real
// work before failing). Muted, single-line + ellipsis, full text on hover.
// Operation/human rows don't get it, so non-agent rows stay minimal.
// =============================================================================

export function SummaryLine({ summary }: { summary: string }) {
  return (
    <div
      style={{
        marginTop: 'var(--space-1)',
        fontSize: 11,
        color: 'var(--color-text-secondary)',
        lineHeight: 1.3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
      }}
      title={summary}
    >
      {summary}
    </div>
  );
}

// =============================================================================

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function TaskStatsLine({ task }: { task: WorkflowSurfaceTaskState }) {
  const { stepCount, totalTokens } = task;
  const parts: string[] = [];
  if (stepCount != null) parts.push(`${String(stepCount)} ${stepCount === 1 ? 'step' : 'steps'}`);
  if (totalTokens != null) parts.push(`${formatTokens(totalTokens)} tokens`);
  if (parts.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 'var(--space-1)',
        fontSize: 11,
        color: 'var(--color-text-muted)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
      {...(totalTokens != null ? { title: `${totalTokens.toLocaleString('en-US')} tokens` } : {})}
    >
      {parts.join(' · ')}
    </div>
  );
}

// =============================================================================
// HumanDecisionLine — resolved-decision trace for a `type: 'human'`,
// `intent: 'approve'` row (approved → succeeded; rejected → failed). The
// task-row icon is the neutral person icon (the family), so this line is
// what tells the operator the *outcome* — and, for approvals, who decided
// and any comment. For rejections the reject reason is already on
// `<FailureLine>`, so we surface only the pill (+ approver when present) to
// avoid duplicating the comment text.
// =============================================================================

export function HumanDecisionLine({ task }: { task: WorkflowSurfaceTaskState }) {
  const decision = task.humanDecision;
  if (!decision) return null;
  const approved = decision.decision === 'approved';
  return (
    <div
      style={{
        marginTop: 'var(--space-1)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--color-text-secondary)',
      }}
    >
      <Pill
        label={approved ? 'approved' : 'rejected'}
        tone={approved ? 'success' : 'destructive'}
        title={
          decision.decidedAt
            ? `${approved ? 'Approved' : 'Rejected'} at ${decision.decidedAt}`
            : approved
              ? 'Approved'
              : 'Rejected'
        }
      />
      {decision.decidedBy && <span>by {decision.decidedBy}</span>}
      {approved && decision.comment && (
        <span
          style={{
            maxWidth: 480,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontStyle: 'italic',
          }}
          title={decision.comment}
        >
          “{decision.comment}”
        </span>
      )}
    </div>
  );
}

// =============================================================================

export function ActivitySubline({
  task,
  nowMs,
}: {
  task: WorkflowSurfaceTaskState;
  nowMs: number;
}) {
  if (!task.activeOp) return null;
  if (
    task.activeOpUpdatedAtMs !== undefined &&
    nowMs - task.activeOpUpdatedAtMs > ACTIVE_OP_STALE_THRESHOLD_MS
  ) {
    return null;
  }
  const isThinking = THINKING_CLASS_OPS.has(task.activeOp);
  const inThinkingGrace =
    isThinking &&
    task.activeOpUpdatedAtMs !== undefined &&
    nowMs - task.activeOpUpdatedAtMs < THINKING_GRACE_MS &&
    task.lastSubstantiveOp !== undefined;
  const displayOp = inThinkingGrace ? task.lastSubstantiveOp! : task.activeOp;
  const displayDetail = inThinkingGrace ? task.lastSubstantiveDetail : task.activeDetail;
  const isThinkingClassDisplay = THINKING_CLASS_OPS.has(displayOp);
  const head = isThinkingClassDisplay
    ? pickThinkingVerb(task.taskId, task.activeOpSequence ?? 0)
    : resolveActionLabel(displayOp, undefined);
  // Each distinct reported action gets its own line in the trail. The signature
  // has to capture everything visible so a change rolls a new line in (and so
  // the snapshot <SwapStack> holds for each history line stays correct): the
  // head label already folds in op + thinking verb, the detail covers the rest.
  const swapKey = `${head}::${displayDetail ?? ''}`;
  return (
    <div
      style={{
        marginTop: 'var(--space-1)',
        fontSize: 11,
        fontStyle: 'italic',
        color: 'var(--color-text-secondary)',
        lineHeight: 1.3,
        // Single-line truncation: long stepDetails (URLs, prompts) shouldn't
        // wrap and push the row height around. `nowrap` is inherited by the
        // <SwapStack> lines, which carry the ellipsis.
        whiteSpace: 'nowrap',
        maxWidth: '100%',
      }}
      title={displayDetail ? `${head} · ${displayDetail}` : head}
    >
      {/* Trail of the last few reported actions: current at the bottom in full
          color, recent history rising above it dimmer with age. Only the live
          bottom line shimmers (history lines flatten via the .ds-swap-stack
          shimmer-neutralizing rule). */}
      <SwapStack swapKey={swapKey}>
        {/* Thinking-class ops get the shimmer "AI is working" treatment;
            substantive tool ops read as plain muted text. */}
        {isThinkingClassDisplay ? <ShimmerText>{head}</ShimmerText> : head}
        {displayDetail ? (
          <>
            {' · '}
            <span style={{ color: 'var(--color-text-secondary)' }}>{displayDetail}</span>
          </>
        ) : null}
      </SwapStack>
    </div>
  );
}

// =============================================================================
// RunOutputSection — first-class run output block, rendered between the task
// timeline and the controls footer. Three data sources, all optional:
//
//   - `outputs`: the sanitized promoted run-level state bag. Accumulates LIVE
//     as promoting tasks succeed (`WorkflowTaskUpdate.promotedState`), then is
//     reconciled with the terminal `result.output`.
//   - `result.score`: primary goal metric with direction, target check, and
//     campaign best — the headline number for optimization skills.
//   - `result.outcomes`: deterministic outcome checks (threshold/pattern).
//
// `result.summary` / `result.guidance` are agent-facing (the task rows already
// narrate per-task summaries) — only the summary renders here, on terminal
// runs, as the run's closing line.
// =============================================================================

function formatOutputValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function formatScoreNumber(n: number): string {
  return Math.abs(n) >= 1000 ? n.toLocaleString('en-US') : String(n);
}

export function RunOutputSection({
  outputs,
  result,
  completed,
}: {
  outputs?: Record<string, unknown> | undefined;
  result?: WorkflowRunResult | undefined;
  completed: boolean;
}) {
  const score = result?.score;
  const outcomes = result?.outcomes;
  const primaryKey = result?.primaryOutput;
  const entries = Object.entries(outputs ?? {});
  // Primary deliverable leads; the score metric never repeats as a row
  // (even when it IS the primary) — the score line already headlines it.
  const orderedEntries = [
    ...entries.filter(([k]) => k === primaryKey && k !== score?.metricKey),
    ...entries.filter(([k]) => k !== primaryKey && k !== score?.metricKey),
  ];
  const hasAnything =
    score !== undefined ||
    orderedEntries.length > 0 ||
    (outcomes?.length ?? 0) > 0 ||
    (completed && result?.summary);
  if (!hasAnything) return null;

  return (
    <div className="workflow-run-surface__output">
      <div className="workflow-run-surface__output-header">
        <Icon name="flag" size="xs" />
        <span>{completed ? 'Output' : 'Output so far'}</span>
      </div>
      {score && (
        <div className="workflow-run-surface__output-score">
          <span style={{ color: 'var(--color-text-secondary)' }}>{score.metricKey}</span>
          <span style={{ fontWeight: 700 }}>{formatScoreNumber(score.value)}</span>
          <span
            title={score.direction === 'maximize' ? 'higher is better' : 'lower is better'}
            style={{ color: 'var(--color-text-muted)' }}
          >
            {score.direction === 'maximize' ? '↑' : '↓'}
          </span>
          {score.target !== undefined && (
            <Pill
              label={`target ${formatScoreNumber(score.target)}${score.targetMet === undefined ? '' : score.targetMet ? ' met' : ' not met'}`}
              tone={
                score.targetMet === true
                  ? 'success'
                  : score.targetMet === false
                    ? 'warning'
                    : 'muted'
              }
            />
          )}
          {score.bestScore !== undefined && (
            <span
              style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
              title="Best score across this campaign (including this run)"
            >
              best {formatScoreNumber(score.bestScore)}
            </span>
          )}
        </div>
      )}
      {orderedEntries.map(([key, value]) => {
        const isObject = value !== null && typeof value === 'object';
        const isMarkdown = typeof value === 'string' && value.includes('\n');
        const isComplex = isObject || isMarkdown;
        return (
          <div
            className="workflow-run-surface__output-row"
            key={key}
            style={isComplex ? { flexDirection: 'column', alignItems: 'flex-start' } : undefined}
          >
            <span
              className="workflow-run-surface__output-key"
              style={key === primaryKey ? { fontWeight: 700 } : undefined}
              title={key === primaryKey ? `${key} (primary output)` : key}
            >
              {key}
            </span>
            {isObject ? (
              <JsonViewer data={value} collapsed collapseDepth={1} maxHeight="200px" />
            ) : isMarkdown ? (
              <MarkdownRenderer
                content={value}
                className="chat-history-md workflow-run-surface__output-markdown"
              />
            ) : (
              <span className="workflow-run-surface__output-value" title={formatOutputValue(value)}>
                {formatOutputValue(value)}
              </span>
            )}
          </div>
        );
      })}
      {outcomes && outcomes.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--space-1)',
          }}
        >
          {outcomes.map((o) => (
            <Pill
              key={o.id}
              label={
                o.met === false ? `${o.name}: not met` : o.met === true ? `${o.name}: met` : o.name
              }
              tone={o.met === true ? 'success' : o.met === false ? 'destructive' : 'muted'}
              title={
                o.met === true
                  ? `${o.name}: met`
                  : o.met === false
                    ? `${o.name}: not met`
                    : `${o.name}: not evaluated (metric absent)`
              }
            />
          ))}
        </div>
      )}
      {completed && result?.summary && (
        <div className="workflow-run-surface__output-summary" title={result.summary}>
          {result.summary}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Pill — copied verbatim from `entity-active-surface-spine.tsx` so the
// chat-side surface uses the same mini-tag styling as the inspector.
// =============================================================================

export function Pill({ label, tone, title }: { label: string; tone: PillTone; title?: string }) {
  const colorByTone: Record<PillTone, string> = {
    success: 'var(--color-success-default)',
    warning: 'var(--color-warning-default)',
    destructive: 'var(--color-cybernetic-regression)',
    info: 'var(--color-accent-default)',
    muted: 'var(--color-text-secondary)',
  };
  const bgByTone: Record<PillTone, string> = {
    success: 'var(--color-success-bg)',
    warning: 'var(--color-warning-bg)',
    destructive: 'var(--color-cybernetic-regression-bg)',
    info: 'var(--color-accent-bg)',
    muted: 'var(--color-surface-1)',
  };
  return (
    <span
      title={title}
      style={{
        fontSize: 7,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: colorByTone[tone],
        padding: '4px 8px',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        whiteSpace: 'nowrap',
        background: bgByTone[tone],
      }}
    >
      {label}
    </span>
  );
}
