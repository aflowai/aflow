/**
 * Server-response shapes and query keys for the Evals tab. Response
 * types derive from the shared Zod schemas the routes serialize with
 * (derive-don't-mirror); the only local shapes are route-specific envelopes
 * with no schema of their own. All keys nest under `['space', spaceId, …]` —
 * the Plan 161 §4.4 space-switch invalidation handle.
 */
import type { QueryKey } from '@tanstack/react-query';
import type {
  EvalBaselineView,
  EvalBatchCompareOutput,
  EvalBatchGetOutput,
  EvalBatchListOutput,
  EvalBatchPreflight,
  EvalDatasetGetOutput,
  EvalLabelQueueListItem,
  EvalTrialDetailView,
} from '@aflow/schemas';

/** One stored case at this version that does not parse, and so is not in `cases`. */
export interface UnreadableCase {
  revisionId: string;
  caseId: string;
  title: string;
  reason: string;
}

/**
 * `EvalDatasetGetOutput` with the route's no-dataset-yet shape (null dataset,
 * no version) and the unreadable rows only the REST listing carries — they
 * refuse a launch, so the surface that lists cases has to be able to name them.
 */
export type GoldenDatasetResponse = Omit<EvalDatasetGetOutput, 'dataset' | 'resolvedVersion'> & {
  dataset: EvalDatasetGetOutput['dataset'] | null;
  resolvedVersion?: EvalDatasetGetOutput['resolvedVersion'] | undefined;
  unreadable?: UnreadableCase[];
};

export type EvalBatchListResponse = EvalBatchListOutput;

export type EvalBatchDetailResponse = EvalBatchGetOutput;

/** The per-trial attribution read — the route returns the view object bare, with no envelope. */
export type EvalTrialDetailResponse = EvalTrialDetailView;

/** The REST comparison read is the op output minus its agent-facing summary paragraph. */
export type EvalComparisonResponse = Omit<EvalBatchCompareOutput, 'summary'>;

export interface EvalBaselineResponse {
  baseline: (EvalBaselineView & { pinnedByUserId: string | null }) | null;
}

export type EvalBatchPreflightResponse = Omit<EvalBatchPreflight, 'costCeilingCents'> & {
  caseCount: number;
  resolvedVersion: number;
};

export type LabelQueueItem = EvalLabelQueueListItem;

export interface LabelQueueResponse {
  items: LabelQueueItem[];
}

/** Prefix over every per-batch read (details AND comparisons) — the pin/unpin invalidation handle. */
const batchData = (spaceId: string): QueryKey => ['space', spaceId, 'eval-batch'];
const batchDetail = (spaceId: string, batchId: string): QueryKey => [
  ...batchData(spaceId),
  batchId,
];

export const evalsKeys = {
  dataset: (spaceId: string, slug: string): QueryKey => [
    'space',
    spaceId,
    'workflow',
    slug,
    'golden-dataset',
  ],
  batches: (spaceId: string, slug: string): QueryKey => [
    'space',
    spaceId,
    'workflow',
    slug,
    'eval-batches',
  ],
  batchData,
  batchDetail,
  comparison: (spaceId: string, batchId: string): QueryKey => [
    ...batchDetail(spaceId, batchId),
    'comparison',
  ],
  trial: (spaceId: string, batchId: string, caseRevisionId: string, trial: number): QueryKey => [
    ...batchDetail(spaceId, batchId),
    'trial',
    caseRevisionId,
    trial,
  ],
  baseline: (spaceId: string, slug: string): QueryKey => [
    'space',
    spaceId,
    'workflow',
    slug,
    'eval-baseline',
  ],
  labelQueue: (spaceId: string, slug?: string): QueryKey => [
    'space',
    spaceId,
    'eval-label-queue',
    ...(slug !== undefined ? [slug] : []),
  ],
  preflight: (spaceId: string, slug: string, trialsPerCase: number): QueryKey => [
    'space',
    spaceId,
    'workflow',
    slug,
    'eval-batch-preflight',
    trialsPerCase,
  ],
};

/**
 * Pin/unpin move the ruler: EVERY cached batch detail (baseline/isBaseline/
 * baselineDelta) and every cached comparison reads against the old pin, not
 * just the selected batch's — so the whole per-batch prefix is invalidated
 * (TanStack matches by prefix).
 */
export function baselineMutationInvalidates(spaceId: string, slug: string): QueryKey[] {
  return [
    evalsKeys.baseline(spaceId, slug),
    evalsKeys.batches(spaceId, slug),
    evalsKeys.batchData(spaceId),
  ];
}
