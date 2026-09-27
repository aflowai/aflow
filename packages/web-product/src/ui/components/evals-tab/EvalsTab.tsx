'use client';

/**
 * Evals — the offline plane's ONE operator surface (Plan 269 Part 6):
 * batches, golden dataset, review. Configuration and results share this tab
 * deliberately — the unit of work is the loop (tweak a case → rerun → read
 * the flips → tweak). It never restates production-monitor state: the
 * online plane (production suite, rolling baseline, per-run decisions)
 * lives on the Performance tab.
 *
 * The three phases are TABS over bounded panels, not a stack: only the
 * status line spans them, and every panel scrolls inside itself, so the
 * page has a fixed height and reading one phase never pushes another down.
 *
 * V1 is poll/refetch-on-action: batch progress re-polls while a batch is
 * live. A session-events subscription for batch progress would attach at the
 * detail query below when the batch engine emits progress events.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Column,
  Row,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
} from '@aflow/design-system';

import { useApiQuery } from '../../hooks/useApiQuery.js';
import { DatasetSection } from './DatasetSection.js';
import { ReviewSection } from './ReviewSection.js';
import { LaunchBatchDialog } from './LaunchBatchDialog.js';
import type {
  EvalBatchDetailResponse,
  EvalBatchListResponse,
  GoldenDatasetResponse,
  LabelQueueResponse,
} from './evalsApi.js';
import { evalsKeys } from './evalsApi.js';
import { deriveCoverage, deriveTrialTally } from './evalsDerive.js';
import { EvalsStatusLine } from './EvalsStatusLine.js';
import { evalsPanelStyle } from './evalsStyles.js';
import { BatchesPanel } from './BatchesPanel.js';

const LIVE_BATCH_POLL_MS = 5_000;

type EvalsSection = 'batches' | 'cases' | 'review';

interface SelectedTrial {
  batchId: string;
  caseRevisionId: string;
  trial: number;
}

export function EvalsTab({ spaceId, workflowSlug }: { spaceId: string; workflowSlug: string }) {
  const datasetQuery = useApiQuery<GoldenDatasetResponse>({
    key: evalsKeys.dataset(spaceId, workflowSlug),
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/golden-dataset`,
    spaceId,
    staleTime: 30_000,
    enabled: workflowSlug.length > 0,
  });

  const batchesQuery = useApiQuery<EvalBatchListResponse>({
    key: evalsKeys.batches(spaceId, workflowSlug),
    path: `/spaces/${spaceId}/eval-batches?workflowSlug=${encodeURIComponent(workflowSlug)}`,
    spaceId,
    staleTime: 30_000,
    enabled: workflowSlug.length > 0,
  });
  const batches = batchesQuery.data?.batches ?? [];

  const [section, setSection] = useState<EvalsSection>('batches');
  const [launchOpen, setLaunchOpen] = useState(false);
  const [selectedTrial, setSelectedTrial] = useState<SelectedTrial | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const newestBatchId = batches[0]?.batchId ?? null;
  useEffect(() => {
    if (selectedBatchId === null && newestBatchId !== null) setSelectedBatchId(newestBatchId);
  }, [selectedBatchId, newestBatchId]);
  const effectiveBatchId =
    selectedBatchId !== null && batches.some((b) => b.batchId === selectedBatchId)
      ? selectedBatchId
      : newestBatchId;

  const selectedHead = batches.find((b) => b.batchId === effectiveBatchId);
  const selectedIsLive =
    selectedHead !== undefined &&
    (selectedHead.status === 'queued' ||
      selectedHead.status === 'running' ||
      selectedHead.status === 'cancelling');

  const detailQuery = useApiQuery<EvalBatchDetailResponse>({
    key:
      effectiveBatchId !== null
        ? evalsKeys.batchDetail(spaceId, effectiveBatchId)
        : ['space', spaceId, 'eval-batch', '__none__'],
    path: `/spaces/${spaceId}/eval-batches/${effectiveBatchId ?? ''}`,
    spaceId,
    staleTime: 10_000,
    enabled: effectiveBatchId !== null,
    ...(selectedIsLive ? { refetchInterval: LIVE_BATCH_POLL_MS } : {}),
  });

  // The same read the review panel makes, so the tab can carry its count.
  const queueQuery = useApiQuery<LabelQueueResponse>({
    key: evalsKeys.labelQueue(spaceId, workflowSlug),
    path: `/spaces/${spaceId}/eval-label-queue?status=pending&workflowSlug=${encodeURIComponent(workflowSlug)}`,
    spaceId,
    staleTime: 30_000,
  });

  if (datasetQuery.isLoading || batchesQuery.isLoading) {
    return (
      <Row justify="center" style={{ padding: 'var(--space-6)' }}>
        <Spinner size="md" label="Loading evals" />
      </Row>
    );
  }

  const loadError = datasetQuery.error ?? batchesQuery.error;
  if (loadError && datasetQuery.data === undefined) {
    return (
      <Column
        gap="sm"
        style={{ padding: 'var(--space-6)', alignItems: 'center', textAlign: 'center' }}
      >
        <Text size="base">Could not load the evals surface.</Text>
        <Text size="sm" color="muted">
          {loadError.message}
        </Text>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void datasetQuery.refetch();
            void batchesQuery.refetch();
          }}
        >
          Retry
        </Button>
      </Column>
    );
  }

  const dataset = datasetQuery.data ?? { dataset: null, cases: [], drafts: [] };
  const batchesLoadError = batchesQuery.data === undefined ? batchesQuery.error : null;
  const detailLoadError = detailQuery.data === undefined ? detailQuery.error : null;
  const coverage = deriveCoverage(dataset.cases);

  const newestBatch = batches[0];
  const newestIsSelected = newestBatchId !== null && newestBatchId === effectiveBatchId;
  const latestTally =
    newestIsSelected && detailQuery.data !== undefined
      ? deriveTrialTally(detailQuery.data.caseResults)
      : undefined;
  const pendingLabels = queueQuery.data?.items.length;

  return (
    <div style={{ padding: 'var(--space-4)', maxWidth: 1440, marginInline: 'auto', width: '100%' }}>
      <Column gap="sm">
        <EvalsStatusLine
          latest={newestBatch}
          latestIsSelected={newestIsSelected}
          latestTally={latestTally}
          batchesError={batchesLoadError}
          canLaunch={dataset.cases.length > 0}
          onLaunch={() => {
            setLaunchOpen(true);
          }}
          onShowLatest={() => {
            if (newestBatchId !== null) setSelectedBatchId(newestBatchId);
          }}
        />

        <Tabs
          value={section}
          onChange={(id) => {
            if (id === 'batches' || id === 'cases' || id === 'review') setSection(id);
          }}
        >
          <TabList aria-label="Evals sections">
            <Tab id="batches" count={batches.length}>
              Batches
            </Tab>
            <Tab id="cases" count={dataset.cases.length}>
              Cases
            </Tab>
            <Tab id="review" {...(pendingLabels !== undefined ? { count: pendingLabels } : {})}>
              Review
            </Tab>
          </TabList>

          <TabPanel id="batches" style={{ padding: 0, ...evalsPanelStyle }}>
            <BatchesPanel
              spaceId={spaceId}
              workflowSlug={workflowSlug}
              batches={batches}
              selectedBatchId={effectiveBatchId}
              onSelectBatch={setSelectedBatchId}
              detail={detailQuery.data}
              detailLoading={detailQuery.isLoading}
              detailError={detailLoadError}
              onRetryDetail={() => void detailQuery.refetch()}
              batchesError={batchesLoadError}
              onRetryBatches={() => void batchesQuery.refetch()}
              canLaunch={dataset.cases.length > 0}
              onLaunch={() => {
                setLaunchOpen(true);
              }}
              selectedTrial={selectedTrial}
              onSelectTrial={(batchId, caseRevisionId, trial) => {
                setSelectedTrial({ batchId, caseRevisionId, trial });
              }}
              onCloseTrial={() => {
                setSelectedTrial(null);
              }}
            />
          </TabPanel>

          <TabPanel
            id="cases"
            style={{ overflow: 'auto', ...evalsPanelStyle }}
            className="ds-scroll-subtle"
          >
            <DatasetSection
              spaceId={spaceId}
              workflowSlug={workflowSlug}
              dataset={dataset}
              coverage={coverage}
            />
          </TabPanel>

          <TabPanel id="review" style={{ padding: 0, ...evalsPanelStyle }}>
            <ReviewSection spaceId={spaceId} workflowSlug={workflowSlug} />
          </TabPanel>
        </Tabs>
      </Column>

      {launchOpen && (
        <LaunchBatchDialog
          open
          onClose={() => {
            setLaunchOpen(false);
          }}
          spaceId={spaceId}
          workflowSlug={workflowSlug}
        />
      )}
    </div>
  );
}
