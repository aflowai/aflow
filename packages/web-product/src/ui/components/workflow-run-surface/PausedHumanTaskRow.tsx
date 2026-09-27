'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  AnimatedHeight,
  Button,
  Column,
  JsonViewer,
  Row,
  SchemaForm,
  Text,
} from '@aflow/design-system';
import type { WorkflowRunResumeInput } from '@aflow/schemas';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import type { WorkflowSurfaceTaskState } from '../../lib/types.js';

function ActionPreviewBadge({ op }: { op: string }) {
  return (
    <Row
      gap="1"
      align="center"
      style={{
        display: 'inline-flex',
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border-subtle)',
        fontSize: 'var(--font-size-xs)',
        fontFamily: 'var(--font-mono, monospace)',
        color: 'var(--color-text-secondary)',
      }}
    >
      {op}
    </Row>
  );
}

type ResumeBody = Omit<WorkflowRunResumeInput, 'runId'>;

interface PausedHumanTaskRowProps {
  runId: string;
  spaceId: string;
  task: WorkflowSurfaceTaskState;
  runPauseVersion: number;
}

export function PausedHumanTaskRow({
  runId,
  spaceId,
  task,
  runPauseVersion,
}: PausedHumanTaskRowProps) {
  const pauseVersion = task.pauseVersion ?? runPauseVersion;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [collectValue, setCollectValue] = useState<unknown>({});
  const [collectValid, setCollectValid] = useState(false);

  const resumeMutation = useApiMutation<ResumeBody, { runId: string }>({
    // BFF proxy rewrites /api → /v1 upstream; paths supplied to
    // `useApiMutation` start at the route root (e.g. `/spaces/...`),
    // never with a hard-coded `/v1` prefix. A leading `/v1` here would
    // become `/v1/v1/spaces/...` at the Fastify server and 404 silently
    // — the exact symptom that broke the Kaggle Approve click on the
    // run surface.
    path: `/spaces/${spaceId}/workflow-runs/${runId}/resume`,
    spaceId,
    method: 'POST',
  });

  const submitResume = useCallback(
    (resolution: ResumeBody['resolution']) => {
      resumeMutation.mutate({
        pauseVersion,
        resolution,
        takeOver: false,
      });
    },
    [pauseVersion, resumeMutation],
  );

  const isSubmitting = resumeMutation.isPending;

  const approvePreview = useMemo(() => {
    if (task.humanIntent !== 'approve' || !task.actionPreview) return null;
    return task.actionPreview;
  }, [task.actionPreview, task.humanIntent]);

  if (task.humanIntent === 'approve') {
    return (
      <Column gap="4" className="ds-enter-rise" style={{ marginTop: 'var(--space-2)' }}>
        {approvePreview && (
          <Column gap="1">
            <Text size="xs" variant="muted">
              Proposed action
            </Text>
            <ActionPreviewBadge op={approvePreview.op} />
            <JsonViewer data={approvePreview.input} collapseDepth={2} maxHeight="240px" />
          </Column>
        )}
        <AnimatedHeight>
          {rejectOpen && (
            <Column gap="1" style={{ paddingBottom: 'var(--space-2)' }}>
              <Text size="xs" variant="muted">
                Rejection reason (optional)
              </Text>
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => {
                  setRejectReason(e.target.value);
                }}
                placeholder="Why are you rejecting?"
                maxLength={500}
                disabled={isSubmitting}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-subtle)',
                  background: 'var(--color-surface-1)',
                  fontSize: 'var(--font-size-sm)',
                }}
              />
              <Text size="xs" variant="muted">
                Rejecting skips this action and its gated branch; the rest of the run continues
                (e.g. any always-on follow-up such as recording learnings).
              </Text>
            </Column>
          )}
        </AnimatedHeight>
        <Row gap="2" align="center">
          <Button
            variant="primary"
            size="sm"
            disabled={isSubmitting}
            onClick={() => {
              submitResume({
                mode: 'replace_output',
                output: { decision: 'approved' },
              });
            }}
          >
            {isSubmitting ? 'Approving…' : 'Approve'}
          </Button>
          {!rejectOpen ? (
            <Button
              variant="danger"
              size="sm"
              disabled={isSubmitting}
              onClick={() => {
                setRejectOpen(true);
              }}
            >
              Reject
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              disabled={isSubmitting}
              onClick={() => {
                const trimmed = rejectReason.trim();
                submitResume({
                  mode: 'reject',
                  ...(trimmed ? { comment: trimmed } : {}),
                });
              }}
            >
              Confirm reject
            </Button>
          )}
        </Row>
      </Column>
    );
  }

  if (task.humanIntent === 'collect' && task.resolutionSchema) {
    return (
      <Column gap="2" className="ds-enter-rise" style={{ marginTop: 'var(--space-2)' }}>
        <SchemaForm
          schema={task.resolutionSchema}
          value={collectValue}
          onChange={setCollectValue}
          onValidityChange={setCollectValid}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={isSubmitting || !collectValid}
          onClick={() => {
            submitResume({
              mode: 'replace_output',
              output: collectValue,
            });
          }}
        >
          {isSubmitting ? 'Submitting…' : 'Submit'}
        </Button>
      </Column>
    );
  }

  return null;
}
