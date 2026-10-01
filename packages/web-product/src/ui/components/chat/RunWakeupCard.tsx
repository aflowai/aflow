'use client';

import { Icon } from '@aflow/design-system';
import type { RunWakeupPayload } from '@aflow/run-view';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { isInlinePayloadRef } from '../../lib/fetch-payload.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { useSpace } from '../providers.js';
import { StatusOrb } from '../workflow-run-surface/StatusOrb.js';
import { Pill } from '../workflow-run-surface/WorkflowRunSurfaceParts.js';
import type { WorkflowRunDetailResponse } from '../workflow-run-surface/workflowRunDetailToState.js';
import {
  describeRunWakeup,
  readInlineRunWakeupEnvelope,
  readRunWakeupEnvelope,
} from './runWakeup.js';
import '../workflow-run-surface/workflow-run-surface.css';

function useRunWakeupEnvelope(ref: string | undefined) {
  const inline = ref !== undefined && isInlinePayloadRef(ref);
  const { data } = useApiQuery({
    key: ['payload', ref ?? ''],
    path: `/payloads?ref=${encodeURIComponent(ref ?? '')}`,
    enabled: ref !== undefined && !inline,
    staleTime: Number.POSITIVE_INFINITY,
    retryOnMount: false,
  });
  if (ref === undefined) return undefined;
  return inline ? readInlineRunWakeupEnvelope(ref) : readRunWakeupEnvelope(data);
}

/**
 * A run this conversation started without waiting reported in — the reason
 * the agent speaks next with nobody having said anything. It reads like the
 * header of the run's own card: which skill, how it stands, and the one line
 * that says why.
 */
export function RunWakeupCard({ payload }: { payload: RunWakeupPayload }) {
  const { activeSpace } = useSpace();
  const spaceId = activeSpace?.id;
  // The same entry the run's own card reads, so a run already on screen
  // costs no second request.
  const { data: run } = useApiQuery<WorkflowRunDetailResponse>({
    key: ['space', spaceId ?? '', 'workflow-run', payload.runId],
    path: `/spaces/${spaceId ?? ''}/workflow-runs/${payload.runId}`,
    ...(spaceId ? { spaceId } : {}),
    enabled: spaceId !== undefined,
    staleTime: 30_000,
  });
  const envelope = useRunWakeupEnvelope(payload.envelopeRef);
  const view = describeRunWakeup(payload.outcome, envelope);
  const title =
    run?.run.workflowTitle ?? run?.run.workflowSlug ?? `Run ${payload.runId.slice(0, 8)}`;
  const runHref = activeSpace?.slug ? spaceRoute(activeSpace.slug, `/runs/${payload.runId}`) : null;

  return (
    <div
      data-run-id={payload.runId}
      data-run-wakeup={payload.outcome}
      className="workflow-run-surface ds-enter-rise"
    >
      <div className="workflow-run-surface__header">
        <div className="workflow-run-surface__title-row">
          <StatusOrb
            kind={view.orb}
            size={76}
            className="workflow-run-surface__orb--header"
            decorative={false}
            label={`Run ${view.pill.label}`}
          />
          <span className="workflow-run-surface__label">Skill</span>
          <span className="workflow-run-surface__sep">|</span>
          <span className="workflow-run-surface__title" title={title}>
            {title}
          </span>
        </div>
        <div className="workflow-run-surface__meta-row">
          <Pill label={view.pill.label} tone={view.pill.tone} />
        </div>
      </div>
      <div style={{ padding: '0 12px 4px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{view.headline}</div>
        {view.line !== undefined && (
          <div className="workflow-run-surface__output-summary" title={view.line}>
            {view.line}
          </div>
        )}
        {runHref && (
          <a
            href={runHref}
            target="_blank"
            rel="noopener noreferrer"
            className="workflow-run-surface__open-full"
            title="Open the run in a new tab"
          >
            Open run
            <Icon name="arrow-square-out" size="xs" />
          </a>
        )}
      </div>
    </div>
  );
}
