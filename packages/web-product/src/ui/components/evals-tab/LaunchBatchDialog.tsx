'use client';

/**
 * LAUNCH — the batch's cost ceiling is mandatory and the preflight estimate
 * is echoed live beside it, so a launch that would be refused says so before
 * it is attempted.
 */
import { useState } from 'react';
import { Button, Column, Dialog, Row, Text } from '@aflow/design-system';

import { useApiMutation, useApiQuery } from '../../hooks/useApiQuery.js';
import type { EvalBatchPreflightResponse } from './evalsApi.js';
import { evalsKeys } from './evalsApi.js';
import { formatCents } from './evalsDerive.js';

export function LaunchBatchDialog({
  open,
  onClose,
  spaceId,
  workflowSlug,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  workflowSlug: string;
}) {
  const [trialsPerCase, setTrialsPerCase] = useState(1);
  const [costCeilingCents, setCostCeilingCents] = useState<number | ''>('');
  const [validationSliceSize, setValidationSliceSize] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);

  const preflightQuery = useApiQuery<EvalBatchPreflightResponse>({
    key: evalsKeys.preflight(spaceId, workflowSlug, trialsPerCase),
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/eval-batch-preflight?trialsPerCase=${String(trialsPerCase)}`,
    spaceId,
    staleTime: 30_000,
    enabled: open,
  });
  const preflight = preflightQuery.data;

  const launchMutation = useApiMutation<{
    trialsPerCase: number;
    costCeilingCents: number;
    validationSliceSize?: number | undefined;
    notes?: string | undefined;
  }>({
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/eval-batches`,
    method: 'POST',
    spaceId,
    invalidate: [evalsKeys.batches(spaceId, workflowSlug)],
    onSuccess: () => {
      onClose();
    },
    onError: (error) => {
      setErrorText(error.message);
    },
  });

  const ceilingValid = typeof costCeilingCents === 'number' && costCeilingCents > 0;
  const estimateExceedsCeiling =
    ceilingValid &&
    preflight?.estimatedCostCents != null &&
    preflight.estimatedCostCents > costCeilingCents;

  const submit = () => {
    if (!ceilingValid) return;
    setErrorText(null);
    launchMutation.mutate({
      trialsPerCase,
      costCeilingCents,
      ...(typeof validationSliceSize === 'number' ? { validationSliceSize } : {}),
      ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
    });
  };

  const fieldStyle = {
    padding: 'var(--space-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-surface-1)',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    width: 120,
  } as const;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Launch eval batch"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={launchMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!ceilingValid || launchMutation.isPending}
          >
            {launchMutation.isPending ? 'Launching…' : 'Launch batch'}
          </Button>
        </>
      }
    >
      <Column gap="md">
        <Text size="sm" color="muted">
          The batch freezes the current dataset version, pins the skill revision, and replays every
          case as frozen trials. The cost ceiling is a hard stop — dispatch halts when crossed.
        </Text>
        <Row gap="md" wrap align="end">
          <Column gap="xs">
            <Text size="xs" color="muted">
              Trials per case (≥3 for baselines)
            </Text>
            <input
              type="number"
              min={1}
              max={10}
              value={trialsPerCase}
              onChange={(e) => {
                setTrialsPerCase(Math.max(1, Math.min(10, Number(e.target.value))));
              }}
              style={fieldStyle}
            />
          </Column>
          <Column gap="xs">
            <Text size="xs" color="muted">
              Cost ceiling (cents) — required
            </Text>
            <input
              type="number"
              min={1}
              value={costCeilingCents}
              onChange={(e) => {
                setCostCeilingCents(
                  e.target.value === '' ? '' : Math.max(0, Number(e.target.value)),
                );
              }}
              style={fieldStyle}
            />
          </Column>
          <Column gap="xs">
            <Text size="xs" color="muted">
              Validation slice (optional)
            </Text>
            <input
              type="number"
              min={0}
              max={500}
              value={validationSliceSize}
              onChange={(e) => {
                setValidationSliceSize(
                  e.target.value === '' ? '' : Math.max(0, Number(e.target.value)),
                );
              }}
              style={fieldStyle}
            />
          </Column>
        </Row>
        <Column gap="xs">
          <Text size="xs" color="muted">
            Notes — why this batch is being run
          </Text>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
            }}
            rows={2}
            style={{ ...fieldStyle, width: '100%', resize: 'vertical' }}
          />
        </Column>
        {preflight !== undefined && (
          <Text size="sm" color="muted">
            {preflight.caseCount} case{preflight.caseCount === 1 ? '' : 's'} at dataset v
            {preflight.resolvedVersion} × {trialsPerCase} trial{trialsPerCase === 1 ? '' : 's'}.{' '}
            {preflight.estimatedCostCents != null && preflight.perRunMedianCents != null
              ? `Estimated cost ${formatCents(preflight.estimatedCostCents)} (median ${formatCents(preflight.perRunMedianCents)}/run over ${String(preflight.sampleSize)} recent runs).`
              : 'No recent cost history — no estimate; the ceiling still halts dispatch if crossed.'}
          </Text>
        )}
        {preflight?.models !== undefined && (
          <Column gap="xs">
            <Text size="xs" weight="semibold" color="muted">
              Models this run will use
            </Text>
            {preflight.models.subject.map((model) => (
              <Text key={model.scope} size="xs" color="muted">
                {model.scope === 'runner' ? 'runner' : model.scope.replace('task:', 'agent · ')} —{' '}
                {model.modelRef}
              </Text>
            ))}
            {preflight.models.judges.length > 0 && (
              <Text size="xs" color="muted">
                judge{preflight.models.judges.length === 1 ? '' : 's'} —{' '}
                {preflight.models.judges.join(', ')}
              </Text>
            )}
          </Column>
        )}
        {estimateExceedsCeiling && (
          <Text size="sm" tone="warning">
            The estimate exceeds this ceiling — the launch will be refused. Raise the ceiling, lower
            trials, or run a smaller dataset version.
          </Text>
        )}
        {errorText !== null && (
          <Text size="sm" tone="danger">
            {errorText}
          </Text>
        )}
      </Column>
    </Dialog>
  );
}
