'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon, JsonViewer, Spinner } from '@aflow/design-system';
import { useApi } from '../providers.js';
import { fetchPayload } from '../../lib/fetch-payload.js';
import type { WorkflowSurfaceTaskState } from '../../lib/types.js';
import { formatDurationFromTimestamps, harnessFeedStepId } from './workflowRunSurfaceHelpers.js';
import { Pill } from './WorkflowRunSurfaceParts.js';
import { CodingTranscriptView } from './CodingTranscriptView.js';
import {
  HARNESS_RUN_OPERATION,
  HarnessActivityCard,
  useHarnessActivityLines,
  useHarnessName,
  useHarnessResult,
} from '../harness-activity-card.js';

const MAX_RENDERED_PAYLOAD_CHARS = 20_000;

type SectionStatus =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: unknown }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

function PayloadSection({ label, payloadRef }: { label: string; payloadRef: string }) {
  const { apiUrl, headers } = useApi();
  const [status, setStatus] = useState<SectionStatus>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // Re-entering for a new ref (task retried while the drawer is open →
    // hydration swapped the attempt's refs) must not keep showing the
    // previous attempt's payload while the new fetch is in flight.
    setStatus({ kind: 'loading' });
    void (async () => {
      try {
        const data = await fetchPayload(apiUrl, headers, payloadRef);
        if (!cancelled) setStatus({ kind: 'loaded', data });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'failed to load';
        // fetchPayload surfaces non-2xx as exactly `HTTP <status>`; a 404
        // means the payload was never recorded for this attempt (e.g.
        // inline-op failures, post-claim dispatch failures) — expected,
        // not an error.
        if (message === 'HTTP 404') setStatus({ kind: 'missing' });
        else setStatus({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, payloadRef]);

  return (
    <div>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: 'var(--space-1)',
        }}
      >
        {label}
      </div>
      {status.kind === 'loading' && <Spinner size="sm" />}
      {status.kind === 'missing' && (
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            fontStyle: 'italic',
            color: 'var(--color-text-muted)',
          }}
        >
          not recorded
        </span>
      )}
      {status.kind === 'error' && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-status-failed)' }}>
          {status.message}
        </span>
      )}
      {status.kind === 'loaded' && <PayloadBody data={status.data} />}
    </div>
  );
}

function PayloadBody({ data }: { data: unknown }) {
  let json: string;
  try {
    json = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    json = String(data);
  }
  if (json.length > MAX_RENDERED_PAYLOAD_CHARS) {
    return (
      <div>
        <pre
          style={{
            margin: 0,
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface-1)',
            fontSize: 'var(--font-size-xs)',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {json.slice(0, MAX_RENDERED_PAYLOAD_CHARS)}
        </pre>
        <div
          style={{
            marginTop: 'var(--space-1)',
            fontSize: 'var(--font-size-xs)',
            fontStyle: 'italic',
            color: 'var(--color-text-muted)',
          }}
        >
          truncated — {json.length.toLocaleString('en-US')} characters total
        </div>
      </div>
    );
  }
  return <JsonViewer data={data} collapseDepth={2} maxHeight="240px" />;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `transcriptRef` is nested inside the task's output (or, for a review's no-verdict
 * failure, its errorRef). Fetch whichever exists and pull the ref out, so the
 * transcript can be fetched on its own.
 */
async function findTranscriptRef(
  apiUrl: string,
  headers: () => Record<string, string>,
  refs: Array<string | undefined>,
): Promise<string | undefined> {
  for (const ref of refs) {
    if (!ref) continue;
    try {
      const payload = await fetchPayload(apiUrl, headers, ref);
      if (isRecord(payload) && typeof payload['transcriptRef'] === 'string') {
        return payload['transcriptRef'];
      }
    } catch (err) {
      // A 404 means this container payload was never recorded — try the next ref.
      // Any other error (401/500/network) is a real failure, not missing data:
      // re-throw so the section surfaces it instead of silently showing "not recorded".
      const message = err instanceof Error ? err.message : '';
      if (message !== 'HTTP 404') throw err;
    }
  }
  return undefined;
}

/**
 * The full harness transcript for a coding task — the only window into the agent's
 * actual turns. Lazy: the nested fetch only runs when "View execution" is expanded.
 */
function TranscriptSection({ outputRef, errorRef }: { outputRef?: string; errorRef?: string }) {
  const { apiUrl, headers } = useApi();
  const [status, setStatus] = useState<SectionStatus>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: 'loading' });
    void (async () => {
      try {
        const transcriptRef = await findTranscriptRef(apiUrl, headers, [outputRef, errorRef]);
        if (cancelled) return;
        if (transcriptRef === undefined) {
          setStatus({ kind: 'missing' });
          return;
        }
        const data = await fetchPayload(apiUrl, headers, transcriptRef);
        if (!cancelled) setStatus({ kind: 'loaded', data });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'failed to load';
        if (message === 'HTTP 404') setStatus({ kind: 'missing' });
        else setStatus({ kind: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, headers, outputRef, errorRef]);

  return (
    <div>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: 'var(--space-1)',
        }}
      >
        Transcript
      </div>
      {status.kind === 'loading' && <Spinner size="sm" />}
      {status.kind === 'missing' && (
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            fontStyle: 'italic',
            color: 'var(--color-text-muted)',
          }}
        >
          Transcript will be available when the agent completes..
        </span>
      )}
      {status.kind === 'error' && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-status-failed)' }}>
          {status.message}
        </span>
      )}
      {status.kind === 'loaded' && <TranscriptBody data={status.data} />}
    </div>
  );
}

function TranscriptBody({ data }: { data: unknown }) {
  const text = isRecord(data) && typeof data['transcript'] === 'string' ? data['transcript'] : '';
  if (text.length === 0) {
    return (
      <span
        style={{
          fontSize: 'var(--font-size-xs)',
          fontStyle: 'italic',
          color: 'var(--color-text-muted)',
        }}
      >
        empty
      </span>
    );
  }
  return <CodingTranscriptView transcript={text} />;
}

const HARNESS_RUNNING_STATUSES = new Set(['scheduled', 'running']);

/**
 * The harness card for a task in a run.
 *
 * The same card the chat timeline shows under a step, keyed by the step the run
 * recorded for the task; the stored feed on the result takes over once the run
 * has written it.
 */
function HarnessTaskActivity({ task }: { task: WorkflowSurfaceTaskState }) {
  const running = HARNESS_RUNNING_STATUSES.has(task.status);
  const stepExecutionId = harnessFeedStepId(task);
  const lines = useHarnessActivityLines(stepExecutionId);
  const result = useHarnessResult(running ? undefined : task.outputRef);
  const harness = useHarnessName(task.inputRef);

  return (
    <div style={{ marginTop: 'var(--space-1)' }}>
      <HarnessActivityCard
        lines={lines}
        running={running}
        result={result}
        harness={harness}
        stepExecutionId={stepExecutionId}
      />
    </div>
  );
}

export function TaskExecutionDetails({ task }: { task: WorkflowSurfaceTaskState }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  const duration = formatDurationFromTimestamps(task.startedAt, task.completedAt);
  const headerParts = [
    ...(task.operationId ? [task.operationId] : []),
    `attempt ${String(task.attempt)}`,
    ...(duration ? [duration] : []),
  ];

  return (
    <div style={{ marginTop: 'var(--space-1)' }}>
      {task.operationId === HARNESS_RUN_OPERATION && <HarnessTaskActivity task={task} />}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--font-size-xs)',
          cursor: 'pointer',
        }}
      >
        <Icon name={expanded ? 'caret-down' : 'caret-right'} size="xs" />
        <span>{expanded ? 'Hide execution' : 'View execution'}</span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 'var(--space-1)',
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-subtle)',
            background: 'var(--color-surface-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-family-mono)',
            }}
          >
            <span>{headerParts.join(' · ')}</span>
            {task.failure && (
              <Pill
                label={`${task.failure.code} [${task.failure.classification}]`}
                tone="destructive"
                title={task.failureReason ?? task.failure.code}
              />
            )}
          </div>
          {task.inputRef && <PayloadSection label="Input" payloadRef={task.inputRef} />}
          {task.outputRef && <PayloadSection label="Output" payloadRef={task.outputRef} />}
          {task.errorRef && <PayloadSection label="Error" payloadRef={task.errorRef} />}
          {task.operationId?.startsWith('code.agent.') && (
            <TranscriptSection
              {...(task.outputRef ? { outputRef: task.outputRef } : {})}
              {...(task.errorRef ? { errorRef: task.errorRef } : {})}
            />
          )}
        </div>
      )}
    </div>
  );
}
