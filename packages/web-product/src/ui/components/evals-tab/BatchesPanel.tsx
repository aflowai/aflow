'use client';

/**
 * BATCHES — the list and the reading side by side in one bounded region, each
 * scrolling on its own. Picking a batch changes the pane on the right and
 * nothing else; picking a trial opens a sheet over it, so neither the rail
 * nor the trial table moves under the reader.
 */
import { Button, Column, EmptyState, Icon, Row, Spinner, Text } from '@aflow/design-system';
import type { EvalBatchHeadView } from '@aflow/schemas';

import { useApiMutation, useApiQuery } from '../../hooks/useApiQuery.js';
import type { ApiError } from '../../lib/query-client.js';
import { BatchDetail } from './BatchDetail.js';
import type {
  EvalBaselineResponse,
  EvalBatchDetailResponse,
  EvalComparisonResponse,
} from './evalsApi.js';
import { baselineMutationInvalidates, evalsKeys } from './evalsApi.js';
import { NON_TERMINAL } from './evalsStyles.js';
import { BatchPicker } from './BatchPicker.js';
import { TrialSheet } from './TrialSheet.js';

export function BatchesPanel({
  spaceId,
  workflowSlug,
  batches,
  selectedBatchId,
  onSelectBatch,
  detail,
  detailLoading,
  detailError,
  onRetryDetail,
  batchesError,
  onRetryBatches,
  canLaunch,
  onLaunch,
  selectedTrial,
  onSelectTrial,
  onCloseTrial,
}: {
  spaceId: string;
  workflowSlug: string;
  batches: EvalBatchHeadView[];
  selectedBatchId: string | null;
  onSelectBatch: (batchId: string) => void;
  detail: EvalBatchDetailResponse | undefined;
  detailLoading: boolean;
  /** Set when the batch detail read failed with nothing cached — the pane is blank, not empty. */
  detailError: ApiError | null;
  onRetryDetail: () => void;
  /** Set when the batch list read failed with nothing cached — the list is unknown, not empty. */
  batchesError: ApiError | null;
  onRetryBatches: () => void;
  canLaunch: boolean;
  onLaunch: () => void;
  selectedTrial: { batchId: string; caseRevisionId: string; trial: number } | null;
  onSelectTrial: (batchId: string, caseRevisionId: string, trial: number) => void;
  onCloseTrial: () => void;
}) {
  const cancelMutation = useApiMutation<{ batchId: string }>({
    path: ({ batchId }) => `/spaces/${spaceId}/eval-batches/${batchId}/cancel`,
    method: 'POST',
    spaceId,
    invalidate: [
      evalsKeys.batches(spaceId, workflowSlug),
      ...(selectedBatchId !== null ? [evalsKeys.batchDetail(spaceId, selectedBatchId)] : []),
    ],
  });

  const pinMutation = useApiMutation<{ batchId: string }>({
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/eval-baseline`,
    method: 'PUT',
    spaceId,
    invalidate: baselineMutationInvalidates(spaceId, workflowSlug),
  });

  const unpinMutation = useApiMutation<Record<string, never>>({
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/eval-baseline`,
    method: 'DELETE',
    spaceId,
    invalidate: baselineMutationInvalidates(spaceId, workflowSlug),
  });

  const baselineQuery = useApiQuery<EvalBaselineResponse>({
    key: evalsKeys.baseline(spaceId, workflowSlug),
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/eval-baseline`,
    spaceId,
    staleTime: 30_000,
  });
  const baselineBatchId = baselineQuery.data?.baseline?.batchId ?? detail?.baseline?.batchId;
  const selectedTerminal = detail !== undefined && !NON_TERMINAL.has(detail.batch.status);
  const comparisonEligible =
    selectedBatchId !== null &&
    selectedTerminal &&
    baselineBatchId !== undefined &&
    baselineBatchId !== selectedBatchId;

  const comparisonQuery = useApiQuery<EvalComparisonResponse>({
    key:
      selectedBatchId !== null
        ? evalsKeys.comparison(spaceId, selectedBatchId)
        : ['space', spaceId, 'eval-batch', '__none__', 'comparison'],
    path: `/spaces/${spaceId}/eval-batches/${selectedBatchId ?? ''}/comparison`,
    spaceId,
    staleTime: 30_000,
    enabled: comparisonEligible,
  });

  const openTrialRow =
    detail !== undefined && selectedTrial !== null && selectedTrial.batchId === detail.batch.batchId
      ? detail.caseResults.find(
          (result) =>
            result.caseRevisionId === selectedTrial.caseRevisionId &&
            result.trial === selectedTrial.trial,
        )
      : undefined;

  const detailPane =
    selectedBatchId === null && batchesError !== null ? (
      <Column gap="sm" style={{ padding: 'var(--space-5)' }}>
        <Text size="sm" color="muted">
          The batch list could not be read, so no batch can be selected. Retry it in the list.
        </Text>
      </Column>
    ) : selectedBatchId === null ? (
      <Column gap="sm" style={{ padding: 'var(--space-5)' }}>
        <EmptyState
          icon={<Icon name="flask" size="lg" />}
          title="No batch yet"
          description="A batch freezes the current dataset version, pins the skill revision, and replays every case as frozen trials. The first completed batch can be pinned as the baseline ruler."
          {...(canLaunch
            ? {
                action: (
                  <Button variant="primary" size="sm" onClick={onLaunch}>
                    <Icon name="play" size="xs" /> Launch batch
                  </Button>
                ),
              }
            : {})}
        />
        {!canLaunch && (
          <Text size="sm" color="muted" align="center">
            The dataset needs at least one active case first — add one on the Cases tab.
          </Text>
        )}
      </Column>
    ) : detail !== undefined ? (
      <BatchDetail
        key={detail.batch.batchId}
        detail={detail}
        baselineBatchId={baselineBatchId}
        isBaseline={baselineBatchId === detail.batch.batchId}
        comparison={comparisonEligible ? comparisonQuery.data : undefined}
        comparisonLoading={comparisonEligible && comparisonQuery.isLoading}
        comparisonError={comparisonEligible ? comparisonQuery.error : null}
        selectedTrial={
          selectedTrial !== null && selectedTrial.batchId === detail.batch.batchId
            ? { caseRevisionId: selectedTrial.caseRevisionId, trial: selectedTrial.trial }
            : null
        }
        onSelectTrial={(caseRevisionId, trial) => {
          onSelectTrial(detail.batch.batchId, caseRevisionId, trial);
        }}
        onCancelBatch={() => {
          cancelMutation.mutate({ batchId: detail.batch.batchId });
        }}
        onPinBaseline={() => {
          pinMutation.mutate({ batchId: detail.batch.batchId });
        }}
        onUnpinBaseline={() => {
          unpinMutation.mutate({});
        }}
        cancelPending={cancelMutation.isPending}
        pinPending={pinMutation.isPending}
        unpinPending={unpinMutation.isPending}
      />
    ) : detailLoading ? (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="sm" label="Loading batch" />
      </Row>
    ) : detailError !== null ? (
      <Column gap="sm" style={{ padding: 'var(--space-5)' }}>
        <Text size="sm" tone="danger">
          Could not load this batch — its results are not shown. {detailError.message}
        </Text>
        <Row>
          <Button variant="secondary" size="sm" onClick={onRetryDetail}>
            Retry
          </Button>
        </Row>
      </Column>
    ) : null;

  return (
    <>
      <Column gap="sm" style={{ height: '100%', minHeight: 0, padding: 'var(--space-3)' }}>
        <BatchPicker
          batches={batches}
          selectedBatchId={selectedBatchId}
          baselineBatchId={baselineBatchId}
          onSelectBatch={onSelectBatch}
          batchesError={batchesError}
          onRetryBatches={onRetryBatches}
        />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{detailPane}</div>
      </Column>

      {detail !== undefined && openTrialRow !== undefined && (
        <TrialSheet
          spaceId={spaceId}
          workflowSlug={workflowSlug}
          batchId={detail.batch.batchId}
          row={openTrialRow}
          caseResults={detail.caseResults}
          onSelectTrial={(caseRevisionId, trial) => {
            onSelectTrial(detail.batch.batchId, caseRevisionId, trial);
          }}
          onClose={onCloseTrial}
        />
      )}
    </>
  );
}
